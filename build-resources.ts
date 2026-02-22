import { Buffer } from 'node:buffer'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir as _mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import fg from 'fast-glob'
import { deflateSync } from 'fflate'
import ffmpeg from 'fluent-ffmpeg'
import { ofetch } from 'ofetch'
import path from 'pathe'
import { create as createYtDlp } from 'youtube-dl-exec'

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
	duration: number
}

interface FailedEntry {
	error: string
	attempts: number
	lastAttempt: number
}

interface BuildState {
	downloadedBgms: string[]
	downloadedMarks: string[]
	failedBgms: Record<string, FailedEntry>
	failedMarks: Record<string, FailedEntry>
	lastUpdated: number
}

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

// ── Build state ────────────────────────────────────────────────────────────
let buildState: BuildState = {
	downloadedBgms: [],
	downloadedMarks: [],
	failedBgms: {},
	failedMarks: {},
	lastUpdated: 0,
}

async function loadBuildState(): Promise<void> {
	if (!existsSync(stateFilePath))
		return
	try {
		const parsed = JSON.parse(readFileSync(stateFilePath, 'utf-8')) as BuildState
		buildState = {
			downloadedBgms: parsed.downloadedBgms ?? [],
			downloadedMarks: parsed.downloadedMarks ?? [],
			failedBgms: parsed.failedBgms ?? {},
			failedMarks: parsed.failedMarks ?? {},
			lastUpdated: parsed.lastUpdated ?? 0,
		}
		console.log(`[STATE] Resumed: ${buildState.downloadedBgms.length} BGMs, ${buildState.downloadedMarks.length} marks already downloaded`)
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
	const actualBgms = new Set(fg.sync(path.join(bgmDir, '*.mp3')).map(f => path.basename(f)))

	// Drop state entries whose files have been deleted externally
	buildState.downloadedMarks = buildState.downloadedMarks.filter(f => actualMarks.has(f))
	buildState.downloadedBgms = buildState.downloadedBgms.filter(f => actualBgms.has(f))

	// Register files present on disk but missing from state (e.g. manual additions)
	for (const f of actualMarks) {
		if (!buildState.downloadedMarks.includes(f))
			buildState.downloadedMarks.push(f)
	}
	for (const f of actualBgms) {
		if (!buildState.downloadedBgms.includes(f))
			buildState.downloadedBgms.push(f)
	}

	await saveBuildState()
}

// ── Filename helpers ───────────────────────────────────────────────────────
function getMarkFilename(item: Pick<OutputDataItem, 'mark'>): string {
	return `${item.mark}.png`
}

function getBgmFilename(item: Pick<OutputDataItem, 'filename'>): string {
	return `${item.filename}.mp3`
}

function isMarkDownloaded(item: OutputDataItem): boolean {
	return buildState.downloadedMarks.includes(getMarkFilename(item))
}

function isBgmDownloaded(item: OutputDataItem): boolean {
	return buildState.downloadedBgms.includes(getBgmFilename(item))
}

// ── File cleanup helper ────────────────────────────────────────────────────
async function removeIfExists(filePath: string, label?: string): Promise<void> {
	if (existsSync(filePath)) {
		await rm(filePath, { force: true })
		console.log(`  [CLEANUP] Removed${label ? ` ${label}` : ''}: ${path.basename(filePath)}`)
	}
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
	const bgmFilename = getBgmFilename(item)
	const bgmPath = path.join(bgmDir, bgmFilename)
	// Use a temp base name; yt-dlp appends .%(ext)s → final will be _tmp_<name>.mp3
	const tempBase = path.join(bgmDir, `_tmp_${item.filename}`)
	const expectedTempMp3 = `${tempBase}.mp3`

	await delay(2000) // Gentle rate-limit protection between downloads

	try {
		await ytdlp(`https://www.youtube.com/watch?v=${item.youtube}`, {
			output: `${tempBase}.%(ext)s`,
			format: 'bestaudio/best',
			extractAudio: true,
			audioFormat: 'mp3',
			audioQuality: 0, // 0 = best VBR quality
			noPlaylist: true,
			retries: 3,
			formatSort: 'acodec:mp3,acodec:aac,acodec:opus',
		})

		if (!existsSync(expectedTempMp3)) {
			throw new Error(`yt-dlp finished but expected output not found: ${path.basename(expectedTempMp3)}`)
		}
		const { size } = await stat(expectedTempMp3)
		if (size < 4096) {
			throw new Error(`Output file is suspiciously small (${size} bytes) — likely corrupt`)
		}

		await rename(expectedTempMp3, bgmPath)
		if (!buildState.downloadedBgms.includes(bgmFilename))
			buildState.downloadedBgms.push(bgmFilename)
		delete buildState.failedBgms[bgmFilename]
	}
	catch (error) {
		// Remove all temp files left by yt-dlp (including .part files)
		const tempFiles = fg.sync(`${tempBase}*`)
		await Promise.all(tempFiles.map(f => rm(f, { force: true }).catch(() => {})))
		// Remove potentially corrupt target file
		await removeIfExists(bgmPath, 'invalid BGM')
		buildState.downloadedBgms = buildState.downloadedBgms.filter(f => f !== bgmFilename)

		const existing = buildState.failedBgms[bgmFilename]
		buildState.failedBgms[bgmFilename] = {
			error: error instanceof Error ? error.message : String(error),
			attempts: (existing?.attempts ?? 0) + 1,
			lastAttempt: Date.now(),
		}
		throw error
	}
}

// ── Duration probe via ffprobe ─────────────────────────────────────────────
async function getBgmDuration(item: OutputDataItem): Promise<number> {
	const bgmPath = path.join(bgmDir, getBgmFilename(item))
	return new Promise<number>((resolve, reject) => {
		ffmpeg.ffprobe(bgmPath, (err, metadata) => {
			if (err)
				reject(err)
			else
				resolve(metadata.format.duration ?? 0)
		})
	})
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
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
		.map<OutputDataItem>(item => ({ ...item, duration: 0 }))

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
						attempts: buildState.failedBgms[getBgmFilename(item)]?.attempts ?? 1,
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
				marks[item.mark] = String.fromCharCode(...deflateSync(buf))
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
