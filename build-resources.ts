import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir as _mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import fg from 'fast-glob'
import { deflateSync } from 'fflate'
import { ofetch } from 'ofetch'
import path from 'pathe'
import { create as createYtDlp } from 'youtube-dl-exec'
import { assertRunningInContainer } from './assert-container'

const execFileAsync = promisify(execFile)

interface MapleBgmItem {
	description: string
	filename: string
	mark: string
	metadata: {
		albumArtist: string
		artist: string
		title: string
		year: string
	}
	source: {
		client: string
		date: string
		structure: string
		version: string
	}
	youtube: string
}

interface OutputDataItem extends MapleBgmItem {
	audio: AudioResource | null
	duration: number
}

interface AudioResource {
	file: string
	codec: string
	container: string
}

interface FailedEntry {
	error: string
	attempts: number
	lastAttempt: number
}

interface BuildState {
	version: number
	downloadedBgms: Record<string, AudioResource>
	downloadedMarks: string[]
	failedBgms: Record<string, FailedEntry>
	failedMarks: Record<string, FailedEntry>
	lastUpdated: number
}

const BUILD_STATE_VERSION = 2

// ── Paths ──────────────────────────────────────────────────────────────────
const workspaceDir = fileURLToPath(new URL('.', import.meta.url))
const outputDir = path.join(workspaceDir, 'output')
const bgmDir = path.join(outputDir, 'bgm')
const markDir = path.join(outputDir, 'mark')
// State file lives in workspace root so it is never committed to gh-pages
const stateFilePath = path.join(workspaceDir, '.build-state.json')

// ── yt-dlp wrapper (uses system-installed yt-dlp binary) ──────────────────
const ytdlp = createYtDlp('yt-dlp')

// ── Helpers ────────────────────────────────────────────────────────────────
const mkdir = (dir: string) => _mkdir(dir, { recursive: true }).catch(() => {})
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function chunkArray<T>(array: T[], size: number): T[][] {
	const result: T[][] = []
	for (let i = 0; i < array.length; i += size) {
		result.push(array.slice(i, i + size))
	}
	return result
}

// Latin1 string of raw bytes, chunked because spreading a whole buffer into
// String.fromCharCode overflows the call stack on larger inputs.
function toBinaryString(bytes: Uint8Array): string {
	const chunkSize = 0x8000
	let result = ''
	for (let i = 0; i < bytes.length; i += chunkSize) {
		result += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
	}
	return result
}

// ── Build state ────────────────────────────────────────────────────────────
let buildState: BuildState = {
	version: BUILD_STATE_VERSION,
	downloadedBgms: {},
	downloadedMarks: [],
	failedBgms: {},
	failedMarks: {},
	lastUpdated: 0,
}

async function loadBuildState(): Promise<void> {
	if (!existsSync(stateFilePath))
		return
	try {
		const parsed = JSON.parse(readFileSync(stateFilePath, 'utf-8')) as Partial<BuildState> & { downloadedBgms?: unknown }
		const canReuseBgmState = parsed.version === BUILD_STATE_VERSION
			&& parsed.downloadedBgms != null
			&& typeof parsed.downloadedBgms === 'object'
			&& !Array.isArray(parsed.downloadedBgms)
		buildState = {
			version: BUILD_STATE_VERSION,
			downloadedBgms: canReuseBgmState ? parsed.downloadedBgms as Record<string, AudioResource> : {},
			downloadedMarks: Array.isArray(parsed.downloadedMarks) ? parsed.downloadedMarks : [],
			failedBgms: parsed.failedBgms ?? {},
			failedMarks: parsed.failedMarks ?? {},
			lastUpdated: parsed.lastUpdated ?? 0,
		}
		if (!canReuseBgmState && parsed.downloadedBgms != null) {
			console.log('[STATE] Audio state format changed — legacy MP3 download state will be rebuilt from source.')
		}
		console.log(`[STATE] Resumed: ${Object.keys(buildState.downloadedBgms).length} BGMs, ${buildState.downloadedMarks.length} marks already downloaded`)
		const failedBgms = Object.keys(buildState.failedBgms).length
		const failedMarks = Object.keys(buildState.failedMarks).length
		if (failedBgms > 0 || failedMarks > 0) {
			console.log(`[STATE] Previous failures: ${failedBgms} BGMs, ${failedMarks} marks — will retry`)
		}
	}
	catch (error) {
		console.warn(`[WARN] Could not load build state (starting fresh): ${error}`)
	}
}

async function saveBuildState(): Promise<void> {
	buildState.lastUpdated = Date.now()
	await writeFile(stateFilePath, JSON.stringify(buildState, null, 2), { encoding: 'utf-8' })
}

// ── Directory setup ────────────────────────────────────────────────────────
async function prepareDirs(): Promise<void> {
	await Promise.all([mkdir(outputDir), mkdir(bgmDir), mkdir(markDir)])
	await loadBuildState()

	// Clean up leftover temp files from any previously interrupted run
	const tempFiles = fg.sync(path.join(bgmDir, '_tmp_*'))
	if (tempFiles.length > 0) {
		console.log(`[CLEANUP] Removing ${tempFiles.length} leftover temp file(s) from a previous interrupted run...`)
		await Promise.all(tempFiles.map(f => rm(f, { force: true }).catch(() => {})))
	}

	// Sync state with what is actually on disk
	const actualMarks = new Set(fg.sync(path.join(markDir, '*.png')).map(f => path.basename(f)))

	// Drop state entries whose files have been deleted externally. Audio files are
	// intentionally state-authoritative so legacy MP3s cannot be mistaken for a
	// source-preserved representation after the state schema migration.
	buildState.downloadedMarks = buildState.downloadedMarks.filter(f => actualMarks.has(f))
	for (const [musicId, audio] of Object.entries(buildState.downloadedBgms)) {
		if (!audio?.file || !existsSync(path.join(bgmDir, audio.file)))
			delete buildState.downloadedBgms[musicId]
	}

	// Mark images are content-addressed by their stable filename and can still be
	// recovered from disk if the local state file was lost.
	for (const f of actualMarks) {
		if (!buildState.downloadedMarks.includes(f))
			buildState.downloadedMarks.push(f)
	}

	await saveBuildState()
}

// ── Filename helpers ───────────────────────────────────────────────────────
function getMarkFilename(item: Pick<OutputDataItem, 'mark'>): string {
	return `${item.mark}.png`
}

function getBgmAudio(item: Pick<OutputDataItem, 'filename'>): AudioResource | undefined {
	return buildState.downloadedBgms[item.filename]
}

function isMarkDownloaded(item: OutputDataItem): boolean {
	return buildState.downloadedMarks.includes(getMarkFilename(item))
}

function isBgmDownloaded(item: OutputDataItem): boolean {
	const audio = getBgmAudio(item)
	return audio != null && existsSync(path.join(bgmDir, audio.file))
}

// ── File cleanup helper ────────────────────────────────────────────────────
async function removeIfExists(filePath: string, label?: string): Promise<void> {
	if (existsSync(filePath)) {
		await rm(filePath, { force: true })
		console.log(`  [CLEANUP] Removed${label ? ` ${label}` : ''}: ${path.basename(filePath)}`)
	}
}

async function removeStaleBgmRepresentations(item: Pick<OutputDataItem, 'filename'>, keepFilename: string): Promise<void> {
	const files = await readdir(bgmDir)
	const staleFiles = files.filter((file) => {
		if (file === keepFilename || file.startsWith('_tmp_'))
			return false
		return path.basename(file, path.extname(file)) === item.filename
	})
	await Promise.all(staleFiles.map(file => removeIfExists(path.join(bgmDir, file), 'stale BGM representation')))
}

async function getAudioCodec(filePath: string): Promise<string> {
	const { stdout } = await execFileAsync('ffprobe', [
		'-v',
		'error',
		'-select_streams',
		'a:0',
		'-show_entries',
		'stream=codec_name',
		'-of',
		'default=noprint_wrappers=1:nokey=1',
		filePath,
	])
	const codec = stdout.trim()
	if (!codec)
		throw new Error('ffprobe could not determine the audio codec')
	return codec
}

// ── Download: mark image ───────────────────────────────────────────────────
async function downloadMark(item: OutputDataItem): Promise<void> {
	const markFilename = getMarkFilename(item)
	const markPath = path.join(markDir, markFilename)
	const tempPath = `${markPath}.tmp`
	const markUrl = `https://maplestory-music.github.io/mark/${markFilename}`

	try {
		const response = await ofetch(markUrl, { responseType: 'arrayBuffer' })
		await writeFile(tempPath, Buffer.from(response))

		const { size } = await stat(tempPath)
		if (size === 0)
			throw new Error('Downloaded mark file is empty (0 bytes)')

		await rename(tempPath, markPath)
		if (!buildState.downloadedMarks.includes(markFilename))
			buildState.downloadedMarks.push(markFilename)
		delete buildState.failedMarks[markFilename]
	}
	catch (error) {
		await removeIfExists(tempPath, 'temp mark')
		await removeIfExists(markPath, 'invalid mark')
		buildState.downloadedMarks = buildState.downloadedMarks.filter(f => f !== markFilename)

		const existing = buildState.failedMarks[markFilename]
		buildState.failedMarks[markFilename] = {
			error: error instanceof Error ? error.message : String(error),
			attempts: (existing?.attempts ?? 0) + 1,
			lastAttempt: Date.now(),
		}
		throw error
	}
}

// ── Download: BGM via yt-dlp ───────────────────────────────────────────────
async function downloadBgm(item: OutputDataItem): Promise<void> {
	// Use a temp base name and let yt-dlp preserve the selected source representation.
	// yt-dlp appends the actual source container as .%(ext)s.
	const tempBase = path.join(bgmDir, `_tmp_${item.filename}`)
	let targetPath: string | null = null

	await delay(2000) // Gentle rate-limit protection between downloads

	try {
		await ytdlp(`https://www.youtube.com/watch?v=${item.youtube}`, {
			output: `${tempBase}.%(ext)s`,
			format: 'bestaudio/best',
			noPlaylist: true,
			retries: 3,
			// YouTube extraction without a JS runtime is deprecated; yt-dlp only
			// enables deno by default, so point it at the image's own Node.
			jsRuntimes: 'node',
		})

		const tempPrefix = `_tmp_${item.filename}.`
		const candidates = (await readdir(bgmDir))
			.filter(file => file.startsWith(tempPrefix) && !file.endsWith('.part') && !file.endsWith('.ytdl'))
		if (candidates.length !== 1) {
			throw new Error(`yt-dlp finished with ${candidates.length} candidate output(s), expected exactly one`)
		}

		const tempFilename = candidates[0]!
		const tempPath = path.join(bgmDir, tempFilename)
		const container = path.extname(tempFilename)
			.slice(1)
			.toLowerCase()
		if (!container)
			throw new Error(`yt-dlp output has no file extension: ${tempFilename}`)

		const { size } = await stat(tempPath)
		if (size < 4096) {
			throw new Error(`Output file is suspiciously small (${size} bytes) — likely corrupt`)
		}

		const codec = await getAudioCodec(tempPath)
		const bgmFilename = `${item.filename}.${container}`
		targetPath = path.join(bgmDir, bgmFilename)
		await rename(tempPath, targetPath)
		const audio: AudioResource = {
			file: bgmFilename,
			codec,
			container,
		}
		await removeStaleBgmRepresentations(item, bgmFilename)
		buildState.downloadedBgms[item.filename] = audio
		item.audio = audio
		delete buildState.failedBgms[item.filename]
	}
	catch (error) {
		// Remove all temp files left by yt-dlp (including .part files)
		const tempFiles = fg.sync(`${tempBase}*`)
		await Promise.all(tempFiles.map(f => rm(f, { force: true }).catch(() => {})))
		// Remove potentially corrupt target file. A legacy representation is left
		// untouched unless the new source-preserving download has fully succeeded.
		if (targetPath != null)
			await removeIfExists(targetPath, 'invalid BGM')
		delete buildState.downloadedBgms[item.filename]
		item.audio = null

		const existing = buildState.failedBgms[item.filename]
		buildState.failedBgms[item.filename] = {
			error: error instanceof Error ? error.message : String(error),
			attempts: (existing?.attempts ?? 0) + 1,
			lastAttempt: Date.now(),
		}
		throw error
	}
}

// ── Duration probe via ffprobe ─────────────────────────────────────────────
async function getBgmDuration(item: OutputDataItem): Promise<number> {
	const audio = getBgmAudio(item)
	if (audio == null)
		throw new Error('No downloaded audio representation found')
	const bgmPath = path.join(bgmDir, audio.file)
	const { stdout } = await execFileAsync('ffprobe', [
		'-v',
		'error',
		'-show_entries',
		'format=duration',
		'-of',
		'default=noprint_wrappers=1:nokey=1',
		bgmPath,
	])
	const duration = Number.parseFloat(stdout.trim())
	return Number.isFinite(duration) ? duration : 0
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
	assertRunningInContainer('pnpm build')
	console.log('=== MapleStory BGM Resource Builder ===\n')
	await prepareDirs()

	console.log('Fetching BGM database...')
	const outputData: OutputDataItem[] = (
		await ofetch<MapleBgmItem[]>(
			'https://raw.githubusercontent.com/maplestory-music/maplebgm-db/prod/bgm.min.json',
			{ responseType: 'json' },
		)
	)
		.filter(item => item.youtube)
		.map<OutputDataItem>(item => ({ ...item, audio: null, duration: 0 }))

	for (const item of outputData)
		item.audio = getBgmAudio(item) ?? null

	console.log(`Total items with YouTube source: ${outputData.length}\n`)

	const errorLogs: { type: 'bgm' | 'mark', filename: string, message: string, attempts: number }[] = []

	// ── Step 1: Download marks and BGMs ───────────────────────────────────
	const toDownloadList = outputData.filter(item => !isMarkDownloaded(item) || !isBgmDownloaded(item))

	if (toDownloadList.length === 0) {
		console.log('[Step 1/4] All files already downloaded, skipping.\n')
	}
	else {
		console.log(`[Step 1/4] Downloading ${toDownloadList.length} item(s)...\n`)

		for (const [idx, item] of toDownloadList.entries()) {
			const pos = `(${idx + 1}/${toDownloadList.length})`
			const needMark = !isMarkDownloaded(item)
			const needBgm = !isBgmDownloaded(item)
			const tags = [needMark && 'mark', needBgm && 'bgm'].filter(Boolean).join(', ')

			console.log(`  ${pos} ${item.filename} [${tags}]`)

			const tasks: Promise<void>[] = []
			if (needMark)
				tasks.push(downloadMark(item))
			if (needBgm)
				tasks.push(downloadBgm(item))

			const results = await Promise.allSettled(tasks)

			// Persist state after every item — enables resuming after interruption
			await saveBuildState()

			let taskIdx = 0
			if (needMark) {
				const result = results[taskIdx++]!
				if (result.status === 'rejected') {
					const msg = result.reason instanceof Error ? result.reason.message : String(result.reason)
					console.error(`    [ERROR] Mark "${item.mark}": ${msg}`)
					errorLogs.push({
						type: 'mark',
						filename: item.mark,
						message: msg,
						attempts: buildState.failedMarks[getMarkFilename(item)]?.attempts ?? 1,
					})
				}
			}
			if (needBgm) {
				const result = results[taskIdx++]!
				if (result.status === 'rejected') {
					const msg = result.reason instanceof Error ? result.reason.message : String(result.reason)
					console.error(`    [ERROR] BGM "${item.filename}": ${msg}`)
					errorLogs.push({
						type: 'bgm',
						filename: item.filename,
						message: msg,
						attempts: buildState.failedBgms[item.filename]?.attempts ?? 1,
					})
				}
			}
		}

		const failCount = errorLogs.length
		console.log(failCount === 0
			? `\n  All ${toDownloadList.length} item(s) downloaded successfully.\n`
			: `\n  Done: ${toDownloadList.length - failCount} succeeded, ${failCount} failed.\n`)
	}

	// ── Step 2: Probe audio durations ──────────────────────────────────────
	const itemsWithBgm = outputData.filter(item => isBgmDownloaded(item))
	const durationBatches = chunkArray(itemsWithBgm, 50)
	console.log(`[Step 2/4] Probing durations (${itemsWithBgm.length} items)...`)

	for (const [batchIdx, batch] of durationBatches.entries()) {
		process.stdout.write(`  Batch ${batchIdx + 1}/${durationBatches.length}...`)
		const batchErrors: string[] = []

		await Promise.all(batch.map(async (item) => {
			try {
				item.duration = await getBgmDuration(item)
			}
			catch (error) {
				const msg = error instanceof Error ? error.message : String(error)
				batchErrors.push(`"${item.filename}": ${msg}`)
				errorLogs.push({ type: 'bgm', filename: item.filename, message: `Duration probe failed: ${msg}`, attempts: 1 })
				item.duration = 0
			}
		}))

		process.stdout.write(' done\n')
		for (const err of batchErrors) {
			console.error(`    [ERROR] Duration probe for ${err}`)
		}
	}

	console.log()

	// ── Step 3: Encode mark images ──────────────────────────────────────────
	const itemsWithMark = outputData.filter(item => isMarkDownloaded(item))
	const encodeBatches = chunkArray(itemsWithMark, 50)
	console.log(`[Step 3/4] Encoding mark images (${itemsWithMark.length} items)...`)

	const marks: Record<string, string> = {}
	for (const [batchIdx, batch] of encodeBatches.entries()) {
		process.stdout.write(`  Batch ${batchIdx + 1}/${encodeBatches.length}...`)
		const batchErrors: string[] = []

		await Promise.all(batch.map(async (item) => {
			const markFilename = getMarkFilename(item)
			const markPath = path.join(markDir, markFilename)
			try {
				const buf = new Uint8Array(readFileSync(markPath))
				marks[item.mark] = toBinaryString(deflateSync(buf))
			}
			catch (error) {
				const msg = error instanceof Error ? error.message : String(error)
				batchErrors.push(`"${item.mark}": ${msg}`)
				// Remove corrupt file so it gets re-downloaded next run
				await removeIfExists(markPath, 'corrupt mark')
				buildState.downloadedMarks = buildState.downloadedMarks.filter(f => f !== markFilename)
				errorLogs.push({ type: 'mark', filename: item.mark, message: `Encode failed: ${msg}`, attempts: 1 })
			}
		}))

		process.stdout.write(' done\n')
		for (const err of batchErrors) {
			console.error(`    [ERROR] Encode mark ${err}`)
		}
	}

	// Persist any state changes made during encoding
	await saveBuildState()
	console.log()

	// ── Step 4: Write output ────────────────────────────────────────────────
	console.log('[Step 4/4] Writing output data...')
	await writeFile(
		path.join(outputDir, 'data.json'),
		JSON.stringify({ bgms: outputData, marks, builtAt: Date.now() }),
		{ encoding: 'utf-8' },
	)

	if (errorLogs.length > 0) {
		const errorLogPath = path.join(workspaceDir, `error-${Date.now()}.log`)
		await writeFile(errorLogPath, JSON.stringify(errorLogs, null, 2), { encoding: 'utf-8' })
		console.error(`\n[WARN] ${errorLogs.length} error(s) logged to: ${path.basename(errorLogPath)}`)
		console.log('       Re-run the build to retry failed items.\n')
		process.exit(1)
	}
	else {
		console.log('\n=== Build complete! All items succeeded. ===\n')
	}
}

main()
