import type { MergedTrack, UpstreamTrack } from './supplemental-catalog'
import type { ProbedAudio } from './wz-audio'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { mkdir as _mkdir, link, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import fg from 'fast-glob'
import { deflateSync } from 'fflate'
import { ofetch } from 'ofetch'
import path from 'pathe'
import { create as createYtDlp } from 'youtube-dl-exec'
import { assertRunningInContainer } from './assert-container'
import { getContentAddressedAudioFilename } from './audio-filename'
import { downloadAudioWithHlsFallback } from './bgm-download'
import { toPublishedBgm, writeBuildDataIfComplete } from './build-output'
import {
	getAudioSourceFingerprint,
	mergeSupplementalCatalog,
} from './supplemental-catalog'
import { downloadMapleStoryIoWzAudio } from './wz-audio'

const execFileAsync = promisify(execFile)

interface OutputDataItem extends UpstreamTrack {
	id?: string
	stableId?: string
	aliases?: string[]
	acquisition: MergedTrack['acquisition']
	metadataAuthority?: MergedTrack['metadataAuthority']
	catalog?: MergedTrack['catalog']
	audioProvenance?: MergedTrack['audioProvenance']
	audio: AudioResource | null
	duration: number
}

interface AudioResource {
	file: string
	codec: string
	container: string
}

interface StoredAudioResource extends AudioResource {
	sourceFingerprint?: string
}

interface FailedEntry {
	error: string
	attempts: number
	lastAttempt: number
}

interface BuildState {
	version: number
	downloadedBgms: Record<string, StoredAudioResource>
	downloadedMarks: string[]
	failedBgms: Record<string, FailedEntry>
	failedMarks: Record<string, FailedEntry>
	lastUpdated: number
}

const BUILD_STATE_VERSION = 3

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
let legacyAudioState = false
let previousPublishedTracks = new Map<string, Record<string, unknown>>()

async function loadBuildState(): Promise<void> {
	if (!existsSync(stateFilePath))
		return
	try {
		const parsed = JSON.parse(readFileSync(stateFilePath, 'utf-8')) as Partial<BuildState> & { downloadedBgms?: unknown }
		const canReuseBgmState = (parsed.version === 2 || parsed.version === BUILD_STATE_VERSION)
			&& parsed.downloadedBgms != null
			&& typeof parsed.downloadedBgms === 'object'
			&& !Array.isArray(parsed.downloadedBgms)
		legacyAudioState = canReuseBgmState && parsed.version !== BUILD_STATE_VERSION
		buildState = {
			version: BUILD_STATE_VERSION,
			downloadedBgms: canReuseBgmState ? parsed.downloadedBgms as Record<string, StoredAudioResource> : {},
			downloadedMarks: Array.isArray(parsed.downloadedMarks) ? parsed.downloadedMarks : [],
			failedBgms: parsed.failedBgms ?? {},
			failedMarks: parsed.failedMarks ?? {},
			lastUpdated: parsed.lastUpdated ?? 0,
		}
		if (!canReuseBgmState && parsed.downloadedBgms != null) {
			console.log('[STATE] Audio state format is unsupported — source fingerprints will be rebuilt.')
		}
		else if (legacyAudioState) {
			console.log('[STATE] Migrating legacy audio state against the previous data.json sources.')
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
}

// ── Filename helpers ───────────────────────────────────────────────────────
function getMarkFilename(item: Pick<OutputDataItem, 'mark'>): string {
	return `${item.mark}.png`
}

function getAudioStateKey(item: Pick<OutputDataItem, 'filename' | 'acquisition'>): string {
	return JSON.stringify([item.filename, getAudioSourceFingerprint(item.acquisition)])
}

function getBgmAudio(item: Pick<OutputDataItem, 'filename' | 'acquisition'>): AudioResource | undefined {
	const entry = buildState.downloadedBgms[getAudioStateKey(item)]
	if (entry?.sourceFingerprint !== getAudioSourceFingerprint(item.acquisition))
		return undefined
	return { file: entry.file, codec: entry.codec, container: entry.container }
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

async function probeAudioInfo(filePath: string): Promise<ProbedAudio> {
	const { stdout } = await execFileAsync('ffprobe', [
		'-v',
		'error',
		'-select_streams',
		'a:0',
		'-show_entries',
		'stream=codec_name,sample_rate:format=duration',
		'-of',
		'json',
		filePath,
	])
	const parsed = JSON.parse(stdout) as {
		streams?: Array<{ codec_name?: string, sample_rate?: string }>
		format?: { duration?: string }
	}
	const stream = parsed.streams?.[0]
	const codec = stream?.codec_name
	const sampleRate = Number(stream?.sample_rate)
	const duration = Number(parsed.format?.duration)
	if (!codec || !Number.isFinite(sampleRate) || !Number.isFinite(duration))
		throw new Error(`ffprobe returned incomplete audio details for ${path.basename(filePath)}`)
	return { codec, sampleRate, duration }
}

function readPreviousPublishedTracks(): Map<string, Record<string, unknown>> {
	try {
		const parsed = JSON.parse(readFileSync(path.join(outputDir, 'data.json'), 'utf-8')) as { bgms?: unknown }
		if (!Array.isArray(parsed.bgms))
			return new Map()
		return new Map(parsed.bgms
			.filter((item): item is Record<string, unknown> => item != null && typeof item === 'object' && !Array.isArray(item))
			.filter(item => typeof item.filename === 'string')
			.map(item => [item.filename as string, item]))
	}
	catch {
		return new Map()
	}
}

async function migrateAudioState(outputData: OutputDataItem[]): Promise<void> {
	const migrated: Record<string, StoredAudioResource> = {}
	for (const item of outputData) {
		const sourceFingerprint = getAudioSourceFingerprint(item.acquisition)
		const stateKey = getAudioStateKey(item)
		const currentEntry = buildState.downloadedBgms[stateKey]
		const legacyEntry = legacyAudioState ? buildState.downloadedBgms[item.filename] : undefined
		const entry = currentEntry ?? legacyEntry
		if (!entry || !entry.file || !existsSync(path.join(bgmDir, entry.file)))
			continue

		const hasMatchingFingerprint = entry.sourceFingerprint === sourceFingerprint
		const previousTrack = previousPublishedTracks.get(item.filename)
		const previousAudio = previousTrack?.audio as { file?: unknown } | undefined
		const isVerifiedLegacyYouTubeEntry = legacyAudioState
			&& entry.sourceFingerprint == null
			&& item.acquisition.type === 'youtube'
			&& previousTrack?.youtube === item.acquisition.videoId
			&& previousAudio?.file === entry.file
		if (!hasMatchingFingerprint && !isVerifiedLegacyYouTubeEntry)
			continue

		migrated[stateKey] = {
			file: entry.file,
			codec: entry.codec,
			container: entry.container,
			sourceFingerprint,
		}
	}
	buildState.downloadedBgms = migrated
	legacyAudioState = false
	console.log(`[STATE] Reconciled ${Object.keys(migrated).length}/${outputData.length} audio entries by source fingerprint.`)
	await saveBuildState()
}

async function getFileSha256(filePath: string): Promise<string> {
	const hash = createHash('sha256')
	for await (const chunk of createReadStream(filePath))
		hash.update(chunk)
	return hash.digest('hex')
}

async function publishAudioWithoutOverwrite(tempPath: string, targetPath: string, expectedSha256: string): Promise<void> {
	try {
		// Both paths are in output/bgm. A hard link creates the final name only
		// when it does not exist, so an existing published representation is never
		// replaced by a rename.
		await link(tempPath, targetPath)
		await rm(tempPath, { force: true })
	}
	catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
			throw error
		const existingSha256 = await getFileSha256(targetPath)
		if (existingSha256 !== expectedSha256)
			throw new Error(`Refusing to overwrite existing content-addressed audio file: ${targetPath}`)
		await rm(tempPath, { force: true })
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
	// Use a temp base name and let yt-dlp preserve the selected source representation.
	// yt-dlp appends the actual source container as .%(ext)s.
	const tempBase = path.join(bgmDir, `_tmp_${item.filename}`)
	const sourceFingerprint = getAudioSourceFingerprint(item.acquisition)

	try {
		if (item.acquisition.type === 'maplestory-io-wz-audio') {
			const targetFilename = getContentAddressedAudioFilename(
				item.filename,
				sourceFingerprint,
				item.acquisition.sha256,
				'mp3',
			)
			const targetPath = path.join(bgmDir, targetFilename)
			const resource = await downloadMapleStoryIoWzAudio(item.acquisition, targetPath, {
				probeAudio: probeAudioInfo,
			})
			const audio: AudioResource = {
				file: resource.file,
				codec: resource.codec,
				container: resource.container,
			}
			buildState.downloadedBgms[getAudioStateKey(item)] = { ...audio, sourceFingerprint }
			item.audio = audio
			delete buildState.failedBgms[item.filename]
			return
		}

		await delay(2000) // Gentle rate-limit protection between YouTube downloads
		const url = `https://www.youtube.com/watch?v=${item.acquisition.videoId}`
		const options = {
			output: `${tempBase}.%(ext)s`,
			format: 'bestaudio/best',
			noPlaylist: true,
			retries: 3,
			// YouTube extraction without a JS runtime is deprecated; yt-dlp only
			// enables deno by default, so point it at the image's own Node.
			jsRuntimes: 'node',
		} as const
		await downloadAudioWithHlsFallback(
			url,
			options,
			ytdlp,
			async () => {
				await Promise.all(fg.sync(`${tempBase}*`).map(file => rm(file, { force: true })))
			},
			() => console.warn(`  [RETRY] ${item.filename}: direct audio returned 403; trying HLS audio`),
		)

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
		const contentSha256 = await getFileSha256(tempPath)
		const bgmFilename = getContentAddressedAudioFilename(item.filename, sourceFingerprint, contentSha256, container)
		const targetPath = path.join(bgmDir, bgmFilename)
		await publishAudioWithoutOverwrite(tempPath, targetPath, contentSha256)
		const audio: AudioResource = {
			file: bgmFilename,
			codec,
			container,
		}
		buildState.downloadedBgms[getAudioStateKey(item)] = { ...audio, sourceFingerprint }
		item.audio = audio
		delete buildState.failedBgms[item.filename]
	}
	catch (error) {
		// Remove all temp files left by yt-dlp (including .part files)
		const tempFiles = fg.sync(`${tempBase}*`)
		await Promise.all(tempFiles.map(f => rm(f, { force: true }).catch(() => {})))
		delete buildState.downloadedBgms[getAudioStateKey(item)]
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
	previousPublishedTracks = readPreviousPublishedTracks()

	console.log('Fetching BGM database...')
	const upstreamItems = (
		await ofetch<UpstreamTrack[]>(
			'https://raw.githubusercontent.com/maplestory-music/maplebgm-db/prod/bgm.min.json',
			{ responseType: 'json' },
		)
	)
		.filter(item => item.youtube)

	console.log('Loading versioned supplemental catalog...')
	const catalog = JSON.parse(readFileSync(path.join(workspaceDir, 'supplemental/catalog.v1.json'), 'utf-8')) as unknown
	const promotions = JSON.parse(readFileSync(path.join(workspaceDir, 'supplemental/promotions.v1.json'), 'utf-8')) as unknown
	const mergedTracks = mergeSupplementalCatalog(upstreamItems, catalog, promotions)
	const outputData: OutputDataItem[] = mergedTracks.map((track) => {
		const {
			stableId,
			acquisition,
			metadataAuthority,
			audioProvenance,
			...publishedFields
		} = track
		return {
			...publishedFields,
			...(stableId ? { id: stableId } : {}),
			stableId,
			acquisition,
			metadataAuthority,
			audioProvenance,
			audio: null,
			duration: 0,
		}
	})

	await migrateAudioState(outputData)

	// Fingerprints identify the declared WZ source, but do not prove that
	// bytes on disk are still intact. Revalidate pinned assets on every build.
	// This path does not fetch: existing files must pass SHA-256 and ffprobe.
	for (const item of outputData) {
		if (item.acquisition.type !== 'maplestory-io-wz-audio')
			continue
		const cached = getBgmAudio(item)
		if (cached == null)
			continue
		const cachedPath = path.join(bgmDir, cached.file)
		if (!existsSync(cachedPath))
			continue
		await downloadMapleStoryIoWzAudio(item.acquisition, cachedPath, {
			probeAudio: probeAudioInfo,
			fetchImpl: async () => { throw new Error('Cached WZ verification must not access the network') },
		})
	}

	for (const item of outputData)
		item.audio = getBgmAudio(item) ?? null

	console.log(`Total merged tracks: ${outputData.length} (${upstreamItems.length} upstream + ${outputData.length - upstreamItems.length} supplemental/promotion)\n`)

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

	for (const item of outputData) {
		if (item.audio == null || item.duration <= 0 || !Number.isFinite(item.duration)) {
			errorLogs.push({
				type: 'bgm',
				filename: item.filename,
				message: 'Track is incomplete: valid audio and duration are required before publishing data.json',
				attempts: buildState.failedBgms[item.filename]?.attempts ?? 1,
			})
		}
		if (!Object.hasOwn(marks, item.mark)) {
			errorLogs.push({
				type: 'mark',
				filename: item.mark,
				message: 'Track is incomplete: encoded mark is required before publishing data.json',
				attempts: buildState.failedMarks[getMarkFilename(item)]?.attempts ?? 1,
			})
		}
	}

	// ── Step 4: Write output only after every current entry is complete ──────
	const publishedBgms = outputData.map(toPublishedBgm)
	const published = await writeBuildDataIfComplete(
		path.join(outputDir, 'data.json'),
		{ bgms: publishedBgms, marks, builtAt: Date.now() },
		errorLogs,
	)
	if (!published) {
		const errorLogPath = path.join(workspaceDir, `error-${Date.now()}.log`)
		await writeFile(errorLogPath, JSON.stringify(errorLogs, null, 2), { encoding: 'utf-8' })
		console.error(`\n[ERROR] ${errorLogs.length} incomplete resource(s) logged to: ${path.basename(errorLogPath)}`)
		console.error('       data.json was left unchanged. Re-run the build to retry failed items.\n')
		process.exitCode = 1
		return
	}
	console.log('[Step 4/4] Atomically wrote complete output data.')
	console.log('\n=== Build complete! All items succeeded. ===\n')
}

main()
