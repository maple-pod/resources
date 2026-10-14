import type { MapleStoryIoWzAudioSource } from './supplemental-catalog'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { validatePinnedWzAudioSource } from './supplemental-catalog'

const MAX_AUDIO_BYTES = 24 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_ATTEMPTS = 3
const EXPECTED_DURATION_TOLERANCE_SECONDS = 0.025

export interface ProbedAudio {
	codec: string
	duration: number
	sampleRate: number
}

export interface WzAudioResource extends ProbedAudio {
	file: string
	container: 'mp3'
}

export interface WzAudioDownloadOptions {
	fetchImpl?: typeof fetch
	probeAudio: (filePath: string) => Promise<ProbedAudio>
	timeoutMs?: number
	maxAttempts?: number
	retryDelayMs?: number
}

class WzAudioRequestError extends Error {
	readonly retryable: boolean

	constructor(message: string, retryable: boolean) {
		super(message)
		this.name = 'WzAudioRequestError'
		this.retryable = retryable
	}
}

export function getMapleStoryIoWzAudioUrl(source: MapleStoryIoWzAudioSource): string {
	validatePinnedWzAudioSource(source)
	const encodedPath = source.path
		.split('/')
		.map(segment => encodeURIComponent(segment))
		.join('/')
	return `https://maplestory.io/api/wz/audio/${source.region}/${source.version}/${encodedPath}`
}

function sha256(bytes: Uint8Array): string {
	return createHash('sha256')
		.update(bytes)
		.digest('hex')
}

async function readResponseBytes(response: Response): Promise<Uint8Array> {
	if (!response.body) {
		const bytes = new Uint8Array(await response.arrayBuffer())
		if (bytes.byteLength > MAX_AUDIO_BYTES)
			throw new WzAudioRequestError(`WZ audio response exceeds ${MAX_AUDIO_BYTES} bytes`, false)
		return bytes
	}

	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let byteLength = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done)
				break
			byteLength += value.byteLength
			if (byteLength > MAX_AUDIO_BYTES) {
				await reader.cancel()
				throw new WzAudioRequestError(`WZ audio response exceeds ${MAX_AUDIO_BYTES} bytes`, false)
			}
			chunks.push(value)
		}
	}
	finally {
		reader.releaseLock()
	}

	const bytes = new Uint8Array(byteLength)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return bytes
}

function verifyAudioInfo(source: MapleStoryIoWzAudioSource, info: ProbedAudio): void {
	if (info.codec !== source.codec)
		throw new WzAudioRequestError(`ffprobe codec mismatch: expected ${source.codec}, got ${info.codec}`, false)
	if (info.sampleRate !== source.sampleRate)
		throw new WzAudioRequestError(`ffprobe sample rate mismatch: expected ${source.sampleRate}, got ${info.sampleRate}`, false)
	if (!Number.isFinite(info.duration) || info.duration <= 0
		|| Math.abs(info.duration - source.duration) > EXPECTED_DURATION_TOLERANCE_SECONDS) {
		throw new WzAudioRequestError(`ffprobe duration mismatch: expected ${source.duration}, got ${info.duration}`, false)
	}
}

async function validateExistingFile(
	filePath: string,
	source: MapleStoryIoWzAudioSource,
	probeAudio: WzAudioDownloadOptions['probeAudio'],
): Promise<WzAudioResource> {
	const bytes = await readFile(filePath)
	if (sha256(bytes) !== source.sha256)
		throw new Error(`Refusing to overwrite existing non-matching WZ audio file: ${filePath}`)
	const info = await probeAudio(filePath)
	verifyAudioInfo(source, info)
	return { file: path.basename(filePath), container: 'mp3', ...info }
}

export async function downloadMapleStoryIoWzAudio(
	source: MapleStoryIoWzAudioSource,
	targetPath: string,
	options: WzAudioDownloadOptions,
): Promise<WzAudioResource> {
	const url = getMapleStoryIoWzAudioUrl(source)
	const { probeAudio } = options
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
	const retryDelayMs = options.retryDelayMs ?? 500
	const fetchImpl = options.fetchImpl ?? fetch
	if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5)
		throw new Error('WZ audio maxAttempts must be between 1 and 5')
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
		throw new Error('WZ audio timeoutMs must be positive')

	await mkdir(path.dirname(targetPath), { recursive: true })
	try {
		return await validateExistingFile(targetPath, source, probeAudio)
	}
	catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
			throw error
	}

	let lastError: unknown
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const tempPath = path.join(path.dirname(targetPath), `_tmp_${path.basename(targetPath)}_${randomUUID()}`)
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs} ms`)), timeoutMs)
		try {
			let response: Response
			try {
				response = await fetchImpl(url, { signal: controller.signal, redirect: 'error' })
			}
			catch (error) {
				throw new WzAudioRequestError(error instanceof Error ? error.message : String(error), true)
			}
			if (!response.ok) {
				const retryable = response.status === 408 || response.status === 429 || response.status >= 500
				await response.body?.cancel().catch(() => {})
				throw new WzAudioRequestError(`MapleStory.io WZ audio request failed (${response.status})`, retryable)
			}
			const contentLength = Number(response.headers.get('content-length'))
			if (Number.isFinite(contentLength) && contentLength > MAX_AUDIO_BYTES) {
				await response.body?.cancel().catch(() => {})
				throw new WzAudioRequestError(`WZ audio response exceeds ${MAX_AUDIO_BYTES} bytes`, false)
			}
			let bytes: Uint8Array
			try {
				bytes = await readResponseBytes(response)
			}
			catch (error) {
				if (error instanceof WzAudioRequestError)
					throw error
				throw new WzAudioRequestError(error instanceof Error ? error.message : String(error), true)
			}
			if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_BYTES)
				throw new WzAudioRequestError(`WZ audio response has invalid size (${bytes.byteLength} bytes)`, false)
			if (sha256(bytes) !== source.sha256)
				throw new WzAudioRequestError('WZ audio SHA-256 mismatch', false)

			await writeFile(tempPath, bytes, { flag: 'wx' })
			const info = await probeAudio(tempPath)
			verifyAudioInfo(source, info)
			await rename(tempPath, targetPath)
			return { file: path.basename(targetPath), container: 'mp3', ...info }
		}
		catch (error) {
			lastError = error
			await rm(tempPath, { force: true }).catch(() => {})
			const retryable = error instanceof WzAudioRequestError && error.retryable
			if (!retryable || attempt === maxAttempts)
				throw error
			if (retryDelayMs > 0)
				await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt))
		}
		finally {
			clearTimeout(timeout)
		}
	}
	throw lastError
}
