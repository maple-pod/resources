import type { RawWzImageNode, RawWzImageParser } from './raw-wz'
import type { ArchivedWzPublishedProvenance, WorldMapAsset } from './schema'
import type { AcquiredWorldMapSource, GameDataSnapshot, GameMapDetail, GameMapSearchCandidate, GameWorldMap, GameWorldMapImage, GameWorldMapSpot, LocalizedGameDataSnapshot, WikiImageInfo, WikiPage, WorldMapSourceConfig } from './source'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { ofetch } from 'ofetch'
import path from 'pathe'
import sharp from 'sharp'
import { getRevision, normalizeWikiTitle, parseBaseImage, parsePoints } from './parse'
import { parseRawWzImage } from './raw-wz'

export const WIKI_API = 'https://maplestorywiki.net/api.php'
export const BGM_DB_URL = 'https://raw.githubusercontent.com/maplestory-music/maplebgm-db/prod/bgm.min.json'
export const USER_AGENT = 'maple-pod-resources-world-map/1.0 (https://github.com/maple-pod/resources)'
export const REQUEST_DELAY_MS = 1000
export const IMAGE_INFO_BATCH_SIZE = 5
export const IMAGE_DOWNLOAD_DELAY_MS = 500
export const REQUEST_TIMEOUT_MS = 15000
export const MAX_RETRIES = 2
export const RETRY_BACKOFF_MS = 250
const MAP_DETAIL_FETCH_CONCURRENCY = 8
const MAP_DETAIL_REQUEST_RATE = 4
export const MAPLESTORY_IO_API = 'https://maplestory.io/api'

export type Sleep = (ms: number) => Promise<void>

export interface RetryTimingOptions {
	timeoutMs?: number
	maxRetries?: number
	retryBackoffMs?: number
	sleep?: Sleep
}

interface WikiQueryResponse {
	query: {
		pages: WikiApiPage[]
	}
}

interface WikiApiRevision {
	revid: number
	timestamp: string
	slots?: { main?: { content?: string } }
}

interface WikiApiPage extends Omit<WikiPage, 'revisions'> {
	revisions?: WikiApiRevision[]
}

export interface WikiClientOptions {
	delayMs?: number
	userAgent?: string
	fetcher?: typeof ofetch
}

export interface MapleStoryIoClientOptions {
	delayMs?: number
	userAgent?: string
	fetcher?: typeof ofetch
	rawFetcher?: typeof ofetch.raw
	apiBase?: string
	/** Bounded request timing; injectable for deterministic offline tests. */
	timeoutMs?: number
	maxRetries?: number
	retryBackoffMs?: number
	sleep?: Sleep
	/** Ignored exact-snapshot cache for raw WZ audit nodes; null disables it. */
	rawAuditCacheDir?: string | null
	/** Ignored exact-snapshot cache for normalized MapleStory.IO JSON responses; null disables it. */
	normalizedResponseCacheDir?: string | null
	/** Injectable raw-image parser for offline tests; production uses libwz WASM. */
	rawImageParser?: RawWzImageParser
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

class RequestTimeoutError extends Error {
	readonly code = 'ETIMEDOUT'

	constructor(context: string) {
		super(`Request timed out for ${context}`)
		this.name = 'RequestTimeoutError'
	}
}

class HttpStatusError extends Error {
	readonly status: number

	constructor(status: number) {
		super(`HTTP ${status}`)
		this.name = 'HttpStatusError'
		this.status = status
	}
}

function numericProperty(value: unknown): number | null {
	return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function errorStatus(error: unknown): number | null {
	if (error == null || typeof error !== 'object')
		return null
	const value = error as { status?: unknown, statusCode?: unknown, response?: { status?: unknown }, cause?: { status?: unknown, statusCode?: unknown } }
	return numericProperty(value.status)
		?? numericProperty(value.statusCode)
		?? numericProperty(value.response?.status)
		?? numericProperty(value.cause?.status)
		?? numericProperty(value.cause?.statusCode)
}

function errorCode(error: unknown): string | null {
	if (error == null || typeof error !== 'object')
		return null
	const value = error as { code?: unknown, cause?: { code?: unknown } }
	return typeof value.code === 'string' ? value.code : typeof value.cause?.code === 'string' ? value.cause.code : null
}

export type MapleStoryIoFailureKind = 'not-found' | 'transient' | 'invalid'
export type WorldMapGraphFailureKind = MapleStoryIoFailureKind | 'unrenderable'

export class MapleStoryIoRequestError extends Error {
	readonly kind: MapleStoryIoFailureKind
	readonly status: number | null

	constructor(context: string, original: unknown) {
		const message = original instanceof Error ? original.message : String(original)
		super(`MapleStory.IO request failed for ${context}: ${message}`)
		this.name = 'MapleStoryIoRequestError'
		this.kind = errorStatus(original) === 404
			? 'not-found'
			: isTransientRequestError(original) ? 'transient' : 'invalid'
		this.status = errorStatus(original)
	}
}

export function mapleStoryIoFailureKind(error: unknown): MapleStoryIoFailureKind {
	if (error instanceof MapleStoryIoRequestError)
		return error.kind
	return errorStatus(error) === 404
		? 'not-found'
		: isTransientRequestError(error) ? 'transient' : 'invalid'
}

export function isTransientRequestError(error: unknown): boolean {
	if (error instanceof RequestTimeoutError)
		return true
	if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError'))
		return true
	const status = errorStatus(error)
	if (status === 429 || (status != null && status >= 500 && status <= 599))
		return true
	return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(errorCode(error) ?? '')
}

function validateRetryTiming(options: Required<RetryTimingOptions>): void {
	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0 || !Number.isInteger(options.maxRetries) || options.maxRetries < 0 || !Number.isFinite(options.retryBackoffMs) || options.retryBackoffMs < 0)
		throw new Error('Invalid timeout/retry timing options')
}

async function retryRequest<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	options: Required<RetryTimingOptions>,
	beforeAttempt: Sleep,
	context: string,
): Promise<T> {
	validateRetryTiming(options)
	for (let attempt = 0; ; attempt++) {
		await beforeAttempt(0)
		try {
			const controller = new AbortController()
			let timer: ReturnType<typeof setTimeout> | undefined
			try {
				return await awaitWithTimeout(
					operation(controller.signal),
					options.timeoutMs,
					context,
					controller,
					(value) => {
						timer = value
					},
				)
			}
			finally {
				if (timer != null)
					clearTimeout(timer)
			}
		}
		catch (error) {
			if (attempt >= options.maxRetries || !isTransientRequestError(error))
				throw error
			await options.sleep(options.retryBackoffMs * 2 ** attempt)
		}
	}
}

async function awaitWithTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
	context: string,
	controller: AbortController,
	setTimer: (timer: ReturnType<typeof setTimeout>) => void,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout>
	const timeout = new Promise<T>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort()
			reject(new RequestTimeoutError(context))
		}, timeoutMs)
	})
	setTimer(timer!)
	return Promise.race([operation, timeout])
}

function titleKey(title: string): string {
	return normalizeWikiTitle(title).toLowerCase()
}

export class WikiClient {
	private readonly delayMs: number
	private readonly userAgent: string
	private readonly fetcher: typeof ofetch

	constructor(options: WikiClientOptions = {}) {
		this.delayMs = options.delayMs ?? REQUEST_DELAY_MS
		this.userAgent = options.userAgent ?? USER_AGENT
		this.fetcher = options.fetcher ?? ofetch
	}

	async query(query: Record<string, string>): Promise<WikiPage[]> {
		await delay(this.delayMs)
		const url = new URL(WIKI_API)
		for (const [key, value] of Object.entries({
			action: 'query',
			format: 'json',
			formatversion: '2',
			...query,
		}))
			url.searchParams.set(key, value)
		try {
			const response = await this.fetcher<WikiQueryResponse>(url.toString(), {
				headers: { 'user-agent': this.userAgent },
			})
			return response.query.pages.map(page => ({
				...page,
				revisions: page.revisions?.map(revision => ({
					revid: revision.revid,
					timestamp: revision.timestamp,
					content: revision.slots?.main?.content ?? '',
				})),
			}))
		}
		catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			throw new Error(`Wiki API request failed: ${message}`)
		}
	}

	async fetchRevision(title: string): Promise<WikiPage> {
		const pages = await this.query({
			titles: title,
			prop: 'revisions',
			rvprop: 'ids|timestamp|content',
			rvslots: 'main',
		})
		const page = pages[0]
		if (page == null || page.missing)
			throw new Error(`Required Wiki page not found: ${title}`)
		getRevision(page, title)
		return page
	}

	async fetchRevisions(titles: readonly string[]): Promise<Map<string, WikiPage>> {
		const result = new Map<string, WikiPage>()
		for (let i = 0; i < titles.length; i += 50) {
			const requested = titles.slice(i, i + 50)
			const pages = await this.query({
				titles: requested.join('|'),
				prop: 'revisions',
				rvprop: 'ids|timestamp|content',
				rvslots: 'main',
			})
			for (const page of pages) {
				if (page.missing)
					continue
				getRevision(page, page.title)
				result.set(titleKey(page.title), page)
			}
		}
		const missing = titles.filter(title => !result.has(titleKey(title)))
		if (missing.length > 0)
			throw new Error(`Required Wiki target pages were not fetched: ${missing.join(', ')}`)
		return result
	}

	async fetchImageInfo(files: readonly string[]): Promise<Map<string, WikiImageInfo>> {
		const result = new Map<string, WikiImageInfo>()
		const titles = [...new Set(files)].map(file => `File:${file}`)
		for (let i = 0; i < titles.length; i += IMAGE_INFO_BATCH_SIZE) {
			const pages = await this.query({
				titles: titles.slice(i, i + IMAGE_INFO_BATCH_SIZE).join('|'),
				prop: 'imageinfo',
				iiprop: 'url|size|mime|sha1|timestamp|dimensions',
			})
			for (const page of pages) {
				const info = page.imageinfo?.[0]
				if (info != null)
					result.set(page.title.replace(/^File:/i, ''), info)
			}
		}
		const missing = [...new Set(files)].filter(file => !result.has(file))
		if (missing.length > 0)
			throw new Error(`Required Wiki image metadata was not fetched: ${missing.join(', ')}`)
		return result
	}
}

interface ReadyVersion {
	isReady: boolean
	hasImages: boolean
	mapleVersionId: string
	region: string
}

interface MapleStoryIoWorldMapResponse {
	worldMapName?: string
	parentWorld?: string | null
	baseImage?: Array<{ image?: string, origin?: { x?: number, y?: number, isEmpty?: boolean } }>
	links?: Array<{ toolTip?: string | null, linksTo?: string, linkImage?: { image?: string, origin?: { x?: number, y?: number, isEmpty?: boolean } } | null }>
	maps?: Array<{ spot?: { x?: number, y?: number }, type?: number | string | null, mapNumbers?: number[] }>
}

interface MapleStoryIoMapResponse {
	id?: number
	mapMark?: string
	name?: string
	streetName?: string
	backgroundMusic?: string | null
}

interface MapleStoryIoWzNodeResponse {
	children?: unknown
	type?: unknown
	value?: unknown
}

const RAW_WZ_AUDIT_CACHE_SCHEMA_VERSION = 1 as const
const RAW_WZ_CACHE_INLINE_VALUE_LIMIT = 8192
const RAW_WZ_BULK_CANVAS_SENTINEL = '__bulk-canvas__'
const RAW_WZ_CACHED_VALUE_SENTINEL = '__cached-nonempty-value__'
const RAW_WZ_AUDIT_CONCURRENCY = 4
const NORMALIZED_RESPONSE_CACHE_SCHEMA_VERSION = 1 as const

interface RawWzAuditCacheEntry {
	status: 'ok' | 'not-found' | 'transient' | 'invalid'
	response?: MapleStoryIoWzNodeResponse
	valueSha256?: string
	valueLength?: number
	rawImageFile?: string
	rawImageSha256?: string
	rawImageLength?: number
	error?: string
	entrySha256: string
}

interface RawWzAuditCacheManifest {
	schemaVersion: typeof RAW_WZ_AUDIT_CACHE_SCHEMA_VERSION
	provider: 'maplestory-io'
	apiBase: string
	region: string
	version: string
	entries: Record<string, RawWzAuditCacheEntry>
}

interface RawWzAuditCacheState {
	file: string
	manifest: RawWzAuditCacheManifest
	writeQueue: Promise<void>
}

interface NormalizedResponseCacheEntry {
	status: 'ok' | 'not-found' | 'transient' | 'invalid'
	response?: unknown
	responseSha256?: string
	error?: string
	entrySha256: string
}

interface NormalizedResponseCacheManifest {
	schemaVersion: typeof NORMALIZED_RESPONSE_CACHE_SCHEMA_VERSION
	provider: 'maplestory-io'
	apiBase: string
	region: string
	version: string
	entries: Record<string, NormalizedResponseCacheEntry>
}

interface NormalizedResponseCacheState {
	file: string
	manifest: NormalizedResponseCacheManifest
	writeQueue: Promise<void>
}

export interface MapleStoryIoRawMapStrings {
	name: string | null
	streetName: string | null
}

export interface MapleStoryIoRawMapDetail {
	mapMark: string | null
	backgroundMusic: string | null
	resolvedMapId: string
}

export interface MapleStoryIoRawMapStringAudit {
	values: Record<string, MapleStoryIoRawMapStrings>
	failures: Record<string, MapleStoryIoFailureKind>
}

export interface MapleStoryIoRawWorldMapAudit {
	failures: Record<string, MapleStoryIoFailureKind>
	mismatches: Record<string, string[]>
}

export function worldMapStringKey(worldMapId: string): string | null {
	if (worldMapId === 'WorldMap')
		return '0'
	const numeric = /^WorldMap(\d+)$/u.exec(worldMapId)
	if (numeric != null)
		return numeric[1]!
	// Some clients store non-numeric screen IDs directly under String/WorldMap.img.
	// We still require the key to exist in that exact snapshot before requesting it.
	return /^[A-Za-z][A-Za-z0-9]*$/u.test(worldMapId) && worldMapId.includes('WorldMap') ? worldMapId : null
}

function sha256Text(value: string): string {
	return createHash('sha256')
		.update(value)
		.digest('hex')
}

function imagePayloadHashes(value: string): Set<string> {
	const payload = value.replace(/^data:image\/png;base64,/iu, '')
	return new Set([sha256Text(value), sha256Text(payload)])
}

function isRawWzInternalValue(value: unknown): boolean {
	return value === RAW_WZ_BULK_CANVAS_SENTINEL || value === RAW_WZ_CACHED_VALUE_SENTINEL
}

export class MapleStoryIoClient {
	private readonly delayMs: number
	private readonly userAgent: string
	private readonly fetcher: typeof ofetch
	private readonly rawFetcher: typeof ofetch.raw
	private readonly apiBaseUrl: string
	private readonly retryTiming: Required<RetryTimingOptions>
	private readonly sleep: Sleep
	private readyVersionsCache: Promise<ReadyVersion[]> | null = null
	private readonly worldMapCache = new Map<string, Promise<GameWorldMap>>()
	private readonly mapCache = new Map<string, Promise<GameMapDetail>>()
	private readonly worldMapListCache = new Map<string, Promise<string[]>>()
	private readonly mapListCache = new Map<string, Promise<GameMapSearchCandidate[]>>()
	private readonly worldMapStringKeysCache = new Map<string, Promise<string[]>>()
	private readonly worldMapNameCache = new Map<string, Promise<string | null>>()
	private readonly rawWzNodeCache = new Map<string, Promise<MapleStoryIoWzNodeResponse | null>>()
	private readonly rawWzValueSha256Cache = new Map<string, string | null>()
	private readonly rawMapStringCategoriesCache = new Map<string, Promise<string[]>>()
	private readonly rawMapStringCategoryIdsCache = new Map<string, Promise<string[]>>()
	private readonly rawMapStringCategoryMapCache = new Map<string, Promise<Map<string, string>>>()
	private readonly rawMapDetailCache = new Map<string, Promise<MapleStoryIoRawMapDetail | null>>()
	private readonly rawAuditCacheDir: string | null
	private readonly rawAuditCacheStates = new Map<string, Promise<RawWzAuditCacheState | null>>()
	private readonly normalizedResponseCacheDir: string | null
	private readonly normalizedResponseCache = new Map<string, Promise<unknown>>()
	private readonly normalizedResponseCacheStates = new Map<string, Promise<NormalizedResponseCacheState | null>>()
	private readonly rawImageParser: RawWzImageParser
	private readonly rawWzImageCache = new Map<string, Promise<RawWzImageNode | null>>()
	private rawRequestStartQueue: Promise<void> = Promise.resolve()
	private mapDetailRequestStartQueue: Promise<void> = Promise.resolve()

	constructor(options: MapleStoryIoClientOptions = {}) {
		this.delayMs = options.delayMs ?? REQUEST_DELAY_MS
		this.userAgent = options.userAgent ?? USER_AGENT
		this.fetcher = options.fetcher ?? ofetch
		this.rawFetcher = options.rawFetcher ?? ofetch.raw
		this.apiBaseUrl = options.apiBase ?? MAPLESTORY_IO_API
		this.sleep = options.sleep ?? delay
		this.rawAuditCacheDir = options.rawAuditCacheDir ?? null
		this.normalizedResponseCacheDir = options.normalizedResponseCacheDir ?? null
		this.rawImageParser = options.rawImageParser ?? parseRawWzImage
		this.retryTiming = {
			timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
			maxRetries: options.maxRetries ?? MAX_RETRIES,
			retryBackoffMs: options.retryBackoffMs ?? RETRY_BACKOFF_MS,
			sleep: this.sleep,
		}
		validateRetryTiming(this.retryTiming)
	}

	get apiBase(): string {
		return this.apiBaseUrl
	}

	private async waitForRawRequestStart(): Promise<void> {
		const previous = this.rawRequestStartQueue
		let release!: () => void
		this.rawRequestStartQueue = new Promise<void>((resolve) => {
			release = resolve
		})
		await previous
		try {
			// Raw audit work has up to RAW_WZ_AUDIT_CONCURRENCY workers. Preserve
			// roughly the previous aggregate request rate while spacing starts
			// uniformly instead of releasing a burst after every per-worker delay.
			await this.sleep(Math.ceil(this.delayMs / RAW_WZ_AUDIT_CONCURRENCY))
		}
		finally {
			release()
		}
	}

	private async waitForMapDetailRequestStart(): Promise<void> {
		const previous = this.mapDetailRequestStartQueue
		let release!: () => void
		this.mapDetailRequestStartQueue = new Promise<void>((resolve) => {
			release = resolve
		})
		await previous
		try {
			// Keep the aggregate request-start rate stable even when more workers are
			// allowed in flight to hide upstream response latency.
			await this.sleep(Math.ceil(this.delayMs / MAP_DETAIL_REQUEST_RATE))
		}
		finally {
			release()
		}
	}

	private async get<T>(url: string, context: string, beforeAttempt?: Sleep): Promise<T> {
		try {
			return await retryRequest(
				signal => this.fetcher<T>(url, { headers: { 'user-agent': this.userAgent }, signal }),
				this.retryTiming,
				beforeAttempt ?? (async () => this.sleep(this.delayMs)),
				context,
			)
		}
		catch (error) {
			throw new MapleStoryIoRequestError(context, error)
		}
	}

	private async getOptional<T>(url: string, context: string): Promise<T | null> {
		try {
			return await retryRequest(
				signal => this.fetcher<T>(url, { headers: { 'user-agent': this.userAgent }, signal }),
				this.retryTiming,
				async () => this.sleep(this.delayMs),
				context,
			)
		}
		catch (error) {
			if (errorStatus(error) === 404)
				return null
			throw new MapleStoryIoRequestError(context, error)
		}
	}

	private async getRawOptional<T>(url: string, context: string): Promise<T | null> {
		try {
			return await retryRequest(
				signal => this.fetcher<T>(url, { headers: { 'user-agent': this.userAgent }, signal }),
				this.retryTiming,
				async () => this.waitForRawRequestStart(),
				context,
			)
		}
		catch (error) {
			if (errorStatus(error) === 404)
				return null
			throw new MapleStoryIoRequestError(context, error)
		}
	}

	private normalizedResponseCacheFile(region: string, version: string): string | null {
		if (this.normalizedResponseCacheDir == null)
			return null
		return path.join(this.normalizedResponseCacheDir, encodeURIComponent(region), encodeURIComponent(version), 'manifest.json')
	}

	private normalizedResponseCacheKey(url: string): string {
		return url.startsWith(this.apiBaseUrl) ? url.slice(this.apiBaseUrl.length) : url
	}

	private normalizedResponseCacheSourceKey(region: string, version: string): string {
		return `${this.apiBaseUrl}\u0000${region}\u0000${version}`
	}

	private normalizedResponseCacheEntryHash(entry: Omit<NormalizedResponseCacheEntry, 'entrySha256'>): string {
		return createHash('sha256')
			.update(JSON.stringify(entry))
			.digest('hex')
	}

	private normalizedResponseHash(response: unknown): string {
		return createHash('sha256')
			.update(JSON.stringify(response) ?? 'undefined')
			.digest('hex')
	}

	private async normalizedResponseCacheState(region: string, version: string): Promise<NormalizedResponseCacheState | null> {
		const file = this.normalizedResponseCacheFile(region, version)
		if (file == null)
			return null
		const key = this.normalizedResponseCacheSourceKey(region, version)
		const cached = this.normalizedResponseCacheStates.get(key)
		if (cached != null)
			return cached
		const request = (async () => {
			let manifest: NormalizedResponseCacheManifest | null = null
			try {
				const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<NormalizedResponseCacheManifest>
				if (parsed.schemaVersion === NORMALIZED_RESPONSE_CACHE_SCHEMA_VERSION
					&& parsed.provider === 'maplestory-io'
					&& parsed.apiBase === this.apiBaseUrl
					&& parsed.region === region
					&& parsed.version === version
					&& parsed.entries != null
					&& typeof parsed.entries === 'object'
					&& !Array.isArray(parsed.entries)) {
					manifest = {
						schemaVersion: NORMALIZED_RESPONSE_CACHE_SCHEMA_VERSION,
						provider: 'maplestory-io',
						apiBase: this.apiBaseUrl,
						region,
						version,
						entries: parsed.entries as Record<string, NormalizedResponseCacheEntry>,
					}
				}
			}
			catch {
				// A missing or malformed cache is safely rebuilt from the exact source.
			}
			return { file, manifest: manifest ?? {
				schemaVersion: NORMALIZED_RESPONSE_CACHE_SCHEMA_VERSION,
				provider: 'maplestory-io',
				apiBase: this.apiBaseUrl,
				region,
				version,
				entries: {},
			}, writeQueue: Promise.resolve() }
		})()
		this.normalizedResponseCacheStates.set(key, request)
		return request
	}

	private async readNormalizedResponseCacheEntry(region: string, version: string, cacheKey: string): Promise<{ hit: boolean, status?: 'ok' | 'not-found', response?: unknown }> {
		const state = await this.normalizedResponseCacheState(region, version)
		if (state == null)
			return { hit: false }
		const entry = state.manifest.entries[cacheKey]
		if (entry == null || !['ok', 'not-found', 'transient', 'invalid'].includes(entry.status))
			return { hit: false }
		const { entrySha256, ...unsigned } = entry
		if (entrySha256 !== this.normalizedResponseCacheEntryHash(unsigned)) {
			delete state.manifest.entries[cacheKey]
			return { hit: false }
		}
		if (entry.status === 'ok' && entry.responseSha256 !== this.normalizedResponseHash(entry.response)) {
			delete state.manifest.entries[cacheKey]
			return { hit: false }
		}
		return entry.status === 'ok'
			? { hit: true, status: 'ok', response: entry.response }
			: entry.status === 'not-found'
				? { hit: true, status: 'not-found' }
				: { hit: false }
	}

	private async writeNormalizedResponseCacheEntry(
		region: string,
		version: string,
		cacheKey: string,
		response: unknown,
		failure?: { status: 'transient' | 'invalid' | 'not-found', error?: string },
	): Promise<void> {
		const state = await this.normalizedResponseCacheState(region, version)
		if (state == null)
			return
		const unsigned: Omit<NormalizedResponseCacheEntry, 'entrySha256'> = failure != null
			? { status: failure.status, ...(failure.error == null ? {} : { error: failure.error }) }
			: { status: 'ok', response, responseSha256: this.normalizedResponseHash(response) }
		state.manifest.entries[cacheKey] = { ...unsigned, entrySha256: this.normalizedResponseCacheEntryHash(unsigned) }
		state.writeQueue = state.writeQueue.then(async () => {
			await mkdir(path.dirname(state.file), { recursive: true })
			const temporary = `${state.file}.tmp-${process.pid}-${Date.now()}`
			await writeFile(temporary, `${JSON.stringify(state.manifest, null, 2)}\n`, 'utf8')
			await rename(temporary, state.file)
		})
		await state.writeQueue
	}

	private async getNormalizedSnapshotResponse<T>(region: string, version: string, url: string, context: string, beforeAttempt?: Sleep): Promise<T> {
		const cacheKey = this.normalizedResponseCacheKey(url)
		const requestKey = `${this.normalizedResponseCacheSourceKey(region, version)}\u0000${cacheKey}`
		const cached = this.normalizedResponseCache.get(requestKey)
		if (cached != null)
			return await cached as T
		const request = (async () => {
			const persistent = await this.readNormalizedResponseCacheEntry(region, version, cacheKey)
			if (persistent.hit) {
				if (persistent.status === 'not-found')
					throw new MapleStoryIoRequestError(context, new HttpStatusError(404))
				return persistent.response as T
			}
			try {
				const response = await this.get<T>(url, context, beforeAttempt)
				try {
					await this.writeNormalizedResponseCacheEntry(region, version, cacheKey, response)
				}
				catch {
					// Normalized cache persistence is an optimization; source acquisition remains authoritative.
				}
				return response
			}
			catch (error) {
				try {
					const kind = mapleStoryIoFailureKind(error)
					await this.writeNormalizedResponseCacheEntry(region, version, cacheKey, null, {
						status: kind === 'not-found' ? 'not-found' : kind,
						error: error instanceof Error ? error.message : String(error),
					})
				}
				catch {
					// Normalized cache persistence is an optimization; source acquisition remains authoritative.
				}
				throw error
			}
		})()
		this.normalizedResponseCache.set(requestKey, request)
		return await request as T
	}

	private async readyVersions(): Promise<ReadyVersion[]> {
		if (this.readyVersionsCache == null)
			this.readyVersionsCache = this.get<ReadyVersion[]>(`${this.apiBaseUrl}/wz`, 'version list')
		return this.readyVersionsCache
	}

	async hasReadyVersion(region: string, version: string): Promise<boolean> {
		if (typeof version !== 'string' || version.length === 0)
			return false
		return (await this.readyVersions()).some(candidate => candidate.region === region
			&& candidate.isReady
			&& candidate.hasImages
			&& candidate.mapleVersionId === version)
	}

	async resolveLatestReadyVersion(region: string): Promise<string> {
		const numericVersions = (await this.readyVersions())
			.filter(version => version.region === region && version.isReady && version.hasImages && /^\d+$/.test(version.mapleVersionId))
			.map(version => ({ raw: version.mapleVersionId, numeric: Number(version.mapleVersionId) }))
			.filter(candidate => Number.isSafeInteger(candidate.numeric) && candidate.numeric > 0)
		if (numericVersions.length === 0)
			throw new Error(`MapleStory.IO has no ready numeric ${region} version with images`)
		numericVersions.sort((left, right) => right.numeric - left.numeric)
		return numericVersions[0]!.raw
	}

	async listWorldMapStringKeys(region: string, version: string): Promise<string[]> {
		const cacheKey = `${region}\u0000${version}`
		const cached = this.worldMapStringKeysCache.get(cacheKey)
		if (cached != null)
			return cached
		const request = this.listWorldMapStringKeysUncached(region, version)
		this.worldMapStringKeysCache.set(cacheKey, request)
		return request
	}

	private rawAuditCacheSourceKey(region: string, version: string): string {
		return `${this.apiBaseUrl}\u0000${region}\u0000${version}`
	}

	private rawAuditCacheFile(region: string, version: string): string | null {
		if (this.rawAuditCacheDir == null)
			return null
		return path.join(this.rawAuditCacheDir, encodeURIComponent(region), encodeURIComponent(version), 'manifest.json')
	}

	private rawImageCacheKey(segments: readonly string[]): string {
		return `@raw-image/${segments.join('/')}`
	}

	private rawImageCacheFile(state: RawWzAuditCacheState, cacheKey: string): string {
		return path.join(path.dirname(state.file), 'raw-images', `${sha256Text(cacheKey)}.img`)
	}

	private rawAuditCacheEntryHash(entry: Omit<RawWzAuditCacheEntry, 'entrySha256'>): string {
		return createHash('sha256')
			.update(JSON.stringify(entry))
			.digest('hex')
	}

	private async readRawImageCacheEntry(region: string, version: string, segments: readonly string[]): Promise<{ hit: boolean, bytes: Uint8Array | null }> {
		const state = await this.rawAuditCacheState(region, version)
		if (state == null)
			return { hit: false, bytes: null }
		const cacheKey = this.rawImageCacheKey(segments)
		const entry = state.manifest.entries[cacheKey]
		if (entry == null || !['ok', 'not-found', 'transient', 'invalid'].includes(entry.status))
			return { hit: false, bytes: null }
		const { entrySha256, ...unsigned } = entry
		if (entrySha256 !== this.rawAuditCacheEntryHash(unsigned)) {
			delete state.manifest.entries[cacheKey]
			return { hit: false, bytes: null }
		}
		if (entry.status === 'not-found')
			return { hit: true, bytes: null }
		if (entry.status !== 'ok' || entry.rawImageFile !== `raw-images/${sha256Text(cacheKey)}.img` || entry.rawImageSha256 == null || typeof entry.rawImageLength !== 'number')
			return { hit: false, bytes: null }
		const rawImageLength = entry.rawImageLength
		if (!Number.isSafeInteger(rawImageLength) || rawImageLength < 1)
			return { hit: false, bytes: null }
		try {
			const bytes = await readFile(path.join(path.dirname(state.file), entry.rawImageFile))
			const hash = createHash('sha256')
				.update(bytes)
				.digest('hex')
			if (bytes.length !== entry.rawImageLength || hash !== entry.rawImageSha256)
				throw new Error('raw image cache hash/length mismatch')
			return { hit: true, bytes }
		}
		catch {
			delete state.manifest.entries[cacheKey]
			return { hit: false, bytes: null }
		}
	}

	private async writeRawImageCacheEntry(
		region: string,
		version: string,
		segments: readonly string[],
		bytes: Uint8Array | null,
		failure?: { status: 'transient' | 'invalid', error: string },
	): Promise<void> {
		const state = await this.rawAuditCacheState(region, version)
		if (state == null)
			return
		const cacheKey = this.rawImageCacheKey(segments)
		const unsigned: Omit<RawWzAuditCacheEntry, 'entrySha256'> = failure != null
			? { status: failure.status, error: failure.error }
			: bytes == null
				? { status: 'not-found' }
				: {
						status: 'ok',
						rawImageFile: `raw-images/${sha256Text(cacheKey)}.img`,
						rawImageSha256: createHash('sha256')
							.update(bytes)
							.digest('hex'),
						rawImageLength: bytes.byteLength,
					}
		state.manifest.entries[cacheKey] = { ...unsigned, entrySha256: this.rawAuditCacheEntryHash(unsigned) }
		state.writeQueue = state.writeQueue.then(async () => {
			await mkdir(path.dirname(state.file), { recursive: true })
			if (bytes != null) {
				const imageFile = this.rawImageCacheFile(state, cacheKey)
				await mkdir(path.dirname(imageFile), { recursive: true })
				const temporaryImage = `${imageFile}.tmp-${process.pid}-${Date.now()}`
				await writeFile(temporaryImage, bytes)
				await rename(temporaryImage, imageFile)
			}
			const temporary = `${state.file}.tmp-${process.pid}-${Date.now()}`
			await writeFile(temporary, `${JSON.stringify(state.manifest, null, 2)}\n`, 'utf8')
			await rename(temporary, state.file)
		})
		await state.writeQueue
	}

	private async rawAuditCacheState(region: string, version: string): Promise<RawWzAuditCacheState | null> {
		const file = this.rawAuditCacheFile(region, version)
		if (file == null)
			return null
		const key = this.rawAuditCacheSourceKey(region, version)
		const cached = this.rawAuditCacheStates.get(key)
		if (cached != null)
			return cached
		const request = (async () => {
			let manifest: RawWzAuditCacheManifest | null = null
			try {
				const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<RawWzAuditCacheManifest>
				if (parsed.schemaVersion === RAW_WZ_AUDIT_CACHE_SCHEMA_VERSION
					&& parsed.provider === 'maplestory-io'
					&& parsed.apiBase === this.apiBaseUrl
					&& parsed.region === region
					&& parsed.version === version
					&& parsed.entries != null
					&& typeof parsed.entries === 'object'
					&& !Array.isArray(parsed.entries)) {
					manifest = {
						schemaVersion: RAW_WZ_AUDIT_CACHE_SCHEMA_VERSION,
						provider: 'maplestory-io',
						apiBase: this.apiBaseUrl,
						region,
						version,
						entries: parsed.entries as Record<string, RawWzAuditCacheEntry>,
					}
				}
			}
			catch {
				// A missing or malformed cache is safely rebuilt from the exact source.
			}
			return { file, manifest: manifest ?? {
				schemaVersion: RAW_WZ_AUDIT_CACHE_SCHEMA_VERSION,
				provider: 'maplestory-io',
				apiBase: this.apiBaseUrl,
				region,
				version,
				entries: {},
			}, writeQueue: Promise.resolve() }
		})()
		this.rawAuditCacheStates.set(key, request)
		return request
	}

	private rawWzValueSha256Key(region: string, version: string, cachePath: string): string {
		return `${this.rawAuditCacheSourceKey(region, version)}\u0000${cachePath}`
	}

	private async readRawAuditCacheEntry(region: string, version: string, cachePath: string): Promise<{ hit: boolean, response: MapleStoryIoWzNodeResponse | null }> {
		const state = await this.rawAuditCacheState(region, version)
		if (state == null)
			return { hit: false, response: null }
		const entry = state.manifest.entries[cachePath]
		if (entry == null || !['ok', 'not-found', 'transient', 'invalid'].includes(entry.status))
			return { hit: false, response: null }
		const { entrySha256, ...unsigned } = entry
		if (entrySha256 !== this.rawAuditCacheEntryHash(unsigned)) {
			delete state.manifest.entries[cachePath]
			return { hit: false, response: null }
		}
		if (entry.status === 'ok')
			this.rawWzValueSha256Cache.set(this.rawWzValueSha256Key(region, version, cachePath), entry.valueSha256 ?? null)
		return { hit: entry.status === 'ok' || entry.status === 'not-found', response: entry.status === 'ok' ? entry.response ?? null : null }
	}

	private async writeRawAuditCacheEntry(
		region: string,
		version: string,
		cachePath: string,
		response: MapleStoryIoWzNodeResponse | null,
		failure?: { status: 'transient' | 'invalid', error: string },
	): Promise<void> {
		const state = await this.rawAuditCacheState(region, version)
		if (state == null)
			return
		const originalValue = typeof response?.value === 'string' ? response.value : null
		const valueSha256 = originalValue == null
			? undefined
			: createHash('sha256')
					.update(originalValue)
					.digest('hex')
		const valueLength = originalValue == null ? undefined : originalValue.length
		this.rawWzValueSha256Cache.set(this.rawWzValueSha256Key(region, version, cachePath), valueSha256 ?? null)
		const cachedResponse = response == null || originalValue == null || originalValue.length <= RAW_WZ_CACHE_INLINE_VALUE_LIMIT
			? response ?? undefined
			: { ...response, value: '__cached-nonempty-value__' }
		const unsigned: Omit<RawWzAuditCacheEntry, 'entrySha256'> = failure != null
			? { status: failure.status, error: failure.error }
			: response == null
				? { status: 'not-found' }
				: { status: 'ok', response: cachedResponse, valueSha256, valueLength }
		state.manifest.entries[cachePath] = { ...unsigned, entrySha256: this.rawAuditCacheEntryHash(unsigned) }
		state.writeQueue = state.writeQueue.then(async () => {
			await mkdir(path.dirname(state.file), { recursive: true })
			const temporary = `${state.file}.tmp-${process.pid}-${Date.now()}`
			await writeFile(temporary, `${JSON.stringify(state.manifest, null, 2)}\n`, 'utf8')
			await rename(temporary, state.file)
		})
		await state.writeQueue
	}

	private async fetchRawWzNode(region: string, version: string, segments: readonly string[], context: string, options: { requireExactValue?: boolean } = {}): Promise<MapleStoryIoWzNodeResponse | null> {
		const encodedPath = segments.map(segment => encodeURIComponent(segment)).join('/')
		const cacheKey = `${region}\u0000${version}\u0000${encodedPath}\u0000${options.requireExactValue === true ? 'exact-value' : 'normal'}`
		const cached = this.rawWzNodeCache.get(cacheKey)
		if (cached != null)
			return cached
		const request = (async () => {
			const persistent = await this.readRawAuditCacheEntry(region, version, segments.join('/'))
			if (persistent.hit && (options.requireExactValue !== true || persistent.response == null || !isRawWzInternalValue(persistent.response.value)))
				return persistent.response
			try {
				const response = await this.getRawOptional<MapleStoryIoWzNodeResponse>(`${this.apiBaseUrl}/wz/${region}/${encodeURIComponent(version)}/${encodedPath}`, context)
				const value = typeof response?.value === 'string' ? response.value : null
				this.rawWzValueSha256Cache.set(this.rawWzValueSha256Key(region, version, segments.join('/')), value == null ? null : sha256Text(value))
				try {
					await this.writeRawAuditCacheEntry(region, version, segments.join('/'), response)
				}
				catch {
					// Raw cache persistence is an optimization; source acquisition remains authoritative.
				}
				return response
			}
			catch (error) {
				try {
					await this.writeRawAuditCacheEntry(region, version, segments.join('/'), null, {
						status: mapleStoryIoFailureKind(error) === 'invalid' ? 'invalid' : 'transient',
						error: error instanceof Error ? error.message : String(error),
					})
				}
				catch {
					// Raw cache persistence is an optimization; source acquisition remains authoritative.
				}
				throw error
			}
		})()
		this.rawWzNodeCache.set(cacheKey, request)
		return request
	}

	private async getRawImageOptional(url: string, context: string): Promise<Uint8Array | null> {
		try {
			return await retryRequest(
				signal => this.fetcher<unknown>(url, { headers: { 'user-agent': this.userAgent }, signal, responseType: 'arrayBuffer' as never }).then((response) => {
					if (response == null)
						return null
					if (response instanceof Uint8Array)
						return response
					if (response instanceof ArrayBuffer)
						return new Uint8Array(response)
					if (ArrayBuffer.isView(response))
						return new Uint8Array(response.buffer, response.byteOffset, response.byteLength)
					throw new Error('MapleStory.IO rawImage response is not binary')
				}),
				this.retryTiming,
				async () => this.waitForRawRequestStart(),
				context,
			)
		}
		catch (error) {
			if (errorStatus(error) === 404)
				return null
			throw new MapleStoryIoRequestError(context, error)
		}
	}

	private async fetchRawWzImage(region: string, version: string, segments: readonly string[], imageName: string, expectedRootNames: readonly string[], context: string): Promise<RawWzImageNode | null> {
		const cacheKey = `${region}\u0000${version}\u0000${this.rawImageCacheKey(segments)}`
		const cached = this.rawWzImageCache.get(cacheKey)
		if (cached != null)
			return cached
		const request = (async () => {
			const persistent = await this.readRawImageCacheEntry(region, version, segments)
			if (persistent.hit) {
				if (persistent.bytes == null)
					return null
				try {
					return await this.rawImageParser(persistent.bytes, imageName, expectedRootNames)
				}
				catch {
					// A parser/library incompatibility must use the exact leaf fallback.
					return null
				}
			}
			const encodedPath = segments.map(segment => encodeURIComponent(segment)).join('/')
			let bytes: Uint8Array | null
			try {
				bytes = await this.getRawImageOptional(`${this.apiBaseUrl}/wz/export/${region}/${encodeURIComponent(version)}/${encodedPath}?rawImage=true`, context)
				try {
					await this.writeRawImageCacheEntry(region, version, segments, bytes)
				}
				catch {
					// Raw image cache persistence is an optimization; source acquisition remains authoritative.
				}
				if (bytes == null)
					return null
			}
			catch (error) {
				try {
					await this.writeRawImageCacheEntry(region, version, segments, null, {
						status: mapleStoryIoFailureKind(error) === 'invalid' ? 'invalid' : 'transient',
						error: error instanceof Error ? error.message : String(error),
					})
				}
				catch {
					// Raw image cache persistence is an optimization; source acquisition remains authoritative.
				}
				return null
			}
			try {
				return await this.rawImageParser(bytes, imageName, expectedRootNames)
			}
			catch {
				// The exact-source bytes remain reusable; only parsing falls back.
				return null
			}
		})()
		this.rawWzImageCache.set(cacheKey, request)
		return request
	}

	private rawWzValueSha256(region: string, version: string, segments: readonly string[]): string | null {
		return this.rawWzValueSha256Cache.get(this.rawWzValueSha256Key(region, version, segments.join('/'))) ?? null
	}

	/**
	 * Raw WZ inventory authority. The normalized /map/worldmap endpoint remains
	 * the screen payload transport because this endpoint exposes the WZ tree and
	 * base Canvas bytes, not the normalized link/spot shape used by the graph.
	 */
	async listRawWorldMapIds(region: string, version: string): Promise<string[]> {
		const response = await this.fetchRawWzNode(region, version, ['Map', 'WorldMap'], 'raw Map/WorldMap inventory')
		if (response == null)
			throw new MapleStoryIoRequestError('raw Map/WorldMap inventory', Object.assign(new Error('HTTP 404'), { status: 404 }))
		if (!Array.isArray(response.children) || response.children.some(child => typeof child !== 'string'))
			throw new Error('MapleStory.IO returned malformed raw Map/WorldMap inventory')
		return [...new Set(response.children
			.filter((child): child is string => child.endsWith('.img'))
			.map(child => child.slice(0, -'.img'.length)))]
	}

	/**
	 * Distinguishes actual WorldMap screens from control tables that happen to
	 * live under Map/WorldMap (for example SearchExcept.img). This is only used
	 * to classify an already-unrenderable normalized index entry when exact raw
	 * WZ inventory auditing is enabled; it never substitutes for a renderable
	 * normalized screen.
	 */
	async rawWorldMapHasScreenShape(region: string, version: string, id: string): Promise<boolean> {
		const response = await this.fetchRawWzNode(region, version, ['Map', 'WorldMap', `${id}.img`], `raw Map/WorldMap/${id}.img`)
		if (response == null)
			throw new MapleStoryIoRequestError(`raw Map/WorldMap/${id}.img`, Object.assign(new Error('HTTP 404'), { status: 404 }))
		if (!Array.isArray(response.children) || response.children.some(child => typeof child !== 'string'))
			throw new Error(`MapleStory.IO returned malformed raw Map/WorldMap/${id}.img`)
		const children = new Set(response.children as string[])
		return children.has('BaseImg') || children.has('MapLink') || children.has('MapList')
	}

	/**
	 * Reads exact raw WZ BaseImg canvases for a same-snapshot fallback when the
	 * normalized world-map transport omits an otherwise renderable Canvas.
	 */
	async fetchRawWorldMapBaseImages(region: string, version: string, id: string): Promise<GameWorldMapImage[]> {
		const rootPath = ['Map', 'WorldMap', `${id}.img`]
		const rawVector = (node: MapleStoryIoWzNodeResponse | RawWzImageNode | null | undefined): { x: number, y: number } | null => {
			const value = node?.value
			if (value == null || typeof value !== 'object' || Array.isArray(value))
				return null
			const vector = value as { x?: unknown, y?: unknown, isEmpty?: unknown }
			return typeof vector.x === 'number' && Number.isInteger(vector.x) && typeof vector.y === 'number' && Number.isInteger(vector.y) && vector.isEmpty !== true
				? { x: vector.x, y: vector.y }
				: null
		}
		const rawCanvas = (node: MapleStoryIoWzNodeResponse | RawWzImageNode | null | undefined): boolean =>
			node?.type === 12 && typeof node.value === 'string' && node.value.length > 0
		const publishableCanvasValue = (node: MapleStoryIoWzNodeResponse | null): string | null => {
			const value = node?.value
			return rawCanvas(node) && typeof value === 'string' && !isRawWzInternalValue(value) ? value : null
		}
		const sortIds = (ids: readonly string[]): string[] => [...ids].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
		const images: GameWorldMapImage[] = []

		const bulk = await this.fetchRawWzImage(
			region,
			version,
			rootPath,
			`${id}.img`,
			['BaseImg', 'baseImage'],
			`raw bulk Map/WorldMap/${id}.img`,
		)
		const bulkBaseName = bulk?.children.BaseImg != null ? 'BaseImg' : bulk?.children.baseImage != null ? 'baseImage' : null
		const bulkBase = bulkBaseName == null ? null : bulk?.children[bulkBaseName]
		if (bulkBaseName != null && bulkBase != null) {
			for (const baseId of sortIds(Object.keys(bulkBase.children))) {
				const canvas = bulkBase.children[baseId]
				const origin = rawVector(canvas?.children.origin)
				if (rawCanvas(canvas) && origin != null) {
					const exactCanvas = await this.fetchRawWzNode(
						region,
						version,
						[...rootPath, bulkBaseName, baseId],
						`raw BaseImg exact Canvas ${id}/${baseId}`,
						{ requireExactValue: true },
					)
					const image = publishableCanvasValue(exactCanvas)
					if (image != null)
						images.push({ image, origin })
				}
			}
			if (images.length > 0)
				return images
		}

		for (const baseName of ['BaseImg', 'baseImage']) {
			const container = await this.fetchRawWzNode(region, version, [...rootPath, baseName], `raw ${baseName} ${id}`)
			if (container == null)
				continue
			if (!Array.isArray(container.children) || container.children.some(child => typeof child !== 'string'))
				throw new Error(`MapleStory.IO returned malformed raw ${baseName} for ${id}`)
			for (const baseId of sortIds(container.children as string[])) {
				const canvas = await this.fetchRawWzNode(region, version, [...rootPath, baseName, baseId], `raw ${baseName} child ${id}/${baseId}`, { requireExactValue: true })
				const image = publishableCanvasValue(canvas)
				if (image == null)
					continue
				const originNode = await this.fetchRawWzNode(region, version, [...rootPath, baseName, baseId, 'origin'], `raw ${baseName} origin ${id}/${baseId}`)
				const origin = rawVector(originNode)
				if (origin != null)
					images.push({ image, origin })
			}
			if (images.length > 0)
				return images
		}
		return images
	}

	/**
	 * Audits the raw WZ tree for nodes already proven to exist in the exact
	 * Map/WorldMap inventory. The normalized endpoint remains the graph
	 * transport, but raw BaseImg, MapLink, and MapList structure is authoritative
	 * for existence and for fields that can be compared without guessing.
	 */
	async auditRawWorldMaps(region: string, version: string, nodes: readonly GameWorldMap[]): Promise<MapleStoryIoRawWorldMapAudit> {
		const failures: Record<string, MapleStoryIoFailureKind> = {}
		const mismatches: Record<string, string[]> = {}
		const failurePriority: Record<MapleStoryIoFailureKind, number> = { 'not-found': 1, 'transient': 2, 'invalid': 3 }
		const recordFailure = (id: string, error: unknown): void => {
			const kind = typeof error === 'string' ? error as MapleStoryIoFailureKind : mapleStoryIoFailureKind(error)
			if (failures[id] == null || failurePriority[kind] > failurePriority[failures[id]!])
				failures[id] = kind
		}
		const sortedChildren = (node: MapleStoryIoWzNodeResponse, context: string): string[] => {
			if (!Array.isArray(node.children) || node.children.some(child => typeof child !== 'string'))
				throw new Error(`MapleStory.IO returned malformed ${context} children`)
			return [...new Set(node.children as string[])].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
		}
		const rawString = (node: MapleStoryIoWzNodeResponse | null): string | null => typeof node?.value === 'string' ? node.value.trim() || null : null
		const rawInteger = (node: MapleStoryIoWzNodeResponse | null): number | null => {
			const value = node?.value
			if (typeof value === 'number' && Number.isSafeInteger(value))
				return value
			if (typeof value === 'string' && /^-?\d+$/u.test(value)) {
				const numeric = Number(value)
				return Number.isSafeInteger(numeric) ? numeric : null
			}
			return null
		}
		const rawVector = (node: MapleStoryIoWzNodeResponse | null): { x: number, y: number } | null => {
			if (node?.value == null || typeof node.value !== 'object' || Array.isArray(node.value))
				return null
			const value = node.value as { x?: unknown, y?: unknown, isEmpty?: unknown }
			return typeof value.x === 'number' && Number.isInteger(value.x) && typeof value.y === 'number' && Number.isInteger(value.y) && value.isEmpty !== true
				? { x: value.x, y: value.y }
				: null
		}
		const rawCanvas = (node: MapleStoryIoWzNodeResponse | null): boolean => node?.type === 12 && typeof node.value === 'string' && node.value.length > 0
		const sortedMapNumbers = (values: readonly string[]): string[] => [...values].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
		const mapNumbersKey = (values: readonly string[]): string => JSON.stringify(sortedMapNumbers(values))
		const addMismatch = (id: string, message: string) => {
			(mismatches[id] ??= []).push(message)
		}
		const auditNode = async (node: GameWorldMap): Promise<void> => {
			const id = node.id
			try {
				const rootPath = ['Map', 'WorldMap', `${id}.img`]
				const bulkImage = await this.fetchRawWzImage(
					region,
					version,
					rootPath,
					`${id}.img`,
					['BaseImg', 'baseImage', 'MapLink', 'links', 'MapList', 'maps'],
					`raw bulk Map/WorldMap/${id}.img`,
				)
				const bulkNodeAt = (segments: readonly string[]): RawWzImageNode | null | undefined => {
					if (bulkImage == null || segments.length < rootPath.length || segments.slice(0, rootPath.length).some((segment, index) => segment !== rootPath[index]))
						return undefined
					let current: RawWzImageNode | null = bulkImage
					for (const segment of segments.slice(rootPath.length)) {
						current = current.children[segment] ?? null
						if (current == null)
							return null
					}
					return current
				}
				const bulkToRawNode = (value: RawWzImageNode): MapleStoryIoWzNodeResponse => ({
					children: Object.keys(value.children),
					type: value.type,
					...(value.value === undefined ? {} : { value: value.value }),
				})
				const fetchAuditNode = async (segments: readonly string[], context: string, exactLeaf = false): Promise<MapleStoryIoWzNodeResponse | null> => {
					const bulkNode = bulkNodeAt(segments)
					if (bulkNode === undefined || exactLeaf)
						return await this.fetchRawWzNode(region, version, segments, context)
					// Canvas bytes and their exact hash are intentionally still read from
					// the raw leaf endpoint. Scalar/structural siblings come from bulk.
					if (bulkNode != null && bulkNode.type === 12 && segments.length > rootPath.length)
						return await this.fetchRawWzNode(region, version, segments, context)
					return bulkNode == null ? null : bulkToRawNode(bulkNode)
				}
				const safeFetch = async <T>(id: string, segments: readonly string[], context: string, exactLeaf = false): Promise<{ ok: true, value: T | null } | { ok: false, value: null }> => {
					try {
						return { ok: true, value: await fetchAuditNode(segments, context, exactLeaf) as T | null }
					}
					catch (error) {
						recordFailure(id, error)
						return { ok: false, value: null }
					}
				}
				const required = async (id: string, segments: readonly string[], context: string): Promise<MapleStoryIoWzNodeResponse | null> => {
					const result = await safeFetch<MapleStoryIoWzNodeResponse>(id, segments, context)
					if (!result.ok)
						return null
					if (result.value == null) {
						recordFailure(id, new MapleStoryIoRequestError(context, Object.assign(new Error('HTTP 404'), { status: 404 })))
						return null
					}
					return result.value
				}
				const children = async (id: string, segments: readonly string[], context: string): Promise<string[] | null> => {
					const value = await required(id, segments, context)
					if (value == null)
						return null
					try {
						return sortedChildren(value, context)
					}
					catch (error) {
						recordFailure(id, error)
						return null
					}
				}
				const rootChildren = await children(id, rootPath, `raw Map/WorldMap/${id}.img`)
				if (rootChildren == null)
					return
				const baseName = rootChildren.includes('BaseImg') ? 'BaseImg' : rootChildren.includes('baseImage') ? 'baseImage' : null
				if (baseName == null) {
					addMismatch(id, 'raw BaseImg is missing')
				}
				else {
					const baseChildren = await children(id, [...rootPath, baseName], `raw Map/WorldMap/${id}.img/${baseName}`)
					if (baseChildren == null) {
						// The other root branches remain independently auditable.
					}
					else {
						const rawCanvases: Array<{ baseId: string, canvas: MapleStoryIoWzNodeResponse }> = []
						for (const baseId of baseChildren) {
							const child = await required(id, [...rootPath, baseName, baseId], `raw BaseImg child ${id}/${baseId}`)
							if (child != null && rawCanvas(child))
								rawCanvases.push({ baseId, canvas: child })
						}
						if (rawCanvases.length === 0)
							addMismatch(id, 'raw BaseImg has no Canvas')
						else if (rawCanvases.length !== node.baseImages.length)
							addMismatch(id, `raw BaseImg Canvas count ${rawCanvases.length} differs from normalized ${node.baseImages.length}`)
						for (const [index, { baseId }] of rawCanvases.entries()) {
							const expectedImage = node.baseImages[index]?.image
							const rawValueSha256 = this.rawWzValueSha256(region, version, [...rootPath, baseName, baseId])
							if (expectedImage != null && rawValueSha256 != null && !imagePayloadHashes(expectedImage).has(rawValueSha256))
								addMismatch(id, `raw BaseImg Canvas bytes differ from normalized at index ${index}`)
							const origin = await safeFetch<MapleStoryIoWzNodeResponse>(id, [...rootPath, baseName, baseId, 'origin'], `raw BaseImg origin ${id}/${baseId}`)
							if (origin.ok) {
								const rawOrigin = rawVector(origin.value)
								const expectedOrigin = node.baseImages[index]?.origin
								if (expectedOrigin != null && (rawOrigin == null || rawOrigin.x !== expectedOrigin.x || rawOrigin.y !== expectedOrigin.y))
									addMismatch(id, `raw BaseImg origin differs from normalized at index ${index}`)
							}
						}
					}
				}

				const linkName = rootChildren.includes('MapLink') ? 'MapLink' : rootChildren.includes('links') ? 'links' : null
				const rawLinksResult = linkName == null ? [] : await children(id, [...rootPath, linkName], `raw MapLink ${id}`)
				const rawLinks = rawLinksResult ?? []
				if (rawLinksResult != null && rawLinks.length !== node.links.length)
					addMismatch(id, `raw MapLink count ${rawLinks.length} differs from normalized ${node.links.length}`)
				const linkOccurrences = new Map<string, number>()
				for (const rawLinkId of rawLinks) {
					const linkPath = [...rootPath, linkName ?? 'MapLink', rawLinkId]
					const rawLink = await required(id, linkPath, `raw MapLink ${id}/${rawLinkId}`)
					if (rawLink == null)
						continue
					const linkChildren = await children(id, linkPath, `raw MapLink ${id}/${rawLinkId}`)
					if (linkChildren == null)
						continue
					const linkParent = linkChildren.includes('link') ? 'link' : null
					const target = await safeFetch<MapleStoryIoWzNodeResponse>(id, [...linkPath, ...(linkParent == null ? [] : [linkParent]), 'linkMap'], `raw MapLink target ${id}/${rawLinkId}`)
					const rawTarget = target.ok ? rawString(target.value) : null
					if (target.ok && rawTarget == null)
						addMismatch(id, `raw MapLink target is missing for ${rawLinkId}`)
					const occurrence = rawTarget == null ? 0 : (linkOccurrences.get(rawTarget) ?? 0)
					if (rawTarget != null)
						linkOccurrences.set(rawTarget, occurrence + 1)
					const expected = rawTarget == null
						? undefined
						: node.links.filter(link => link.linksTo === rawTarget)[occurrence]
					if (expected == null && rawTarget != null)
						addMismatch(id, `raw MapLink target ${rawTarget} has no normalized match`)
					const toolTip = await safeFetch<MapleStoryIoWzNodeResponse>(id, [...linkPath, 'toolTip'], `raw MapLink tooltip ${id}/${rawLinkId}`)
					if (toolTip.ok && expected != null) {
						const rawToolTip = rawString(toolTip.value)
						if (rawToolTip !== (expected.toolTip ?? null))
							addMismatch(id, `raw MapLink tooltip ${rawToolTip ?? '<null>'} differs from normalized ${expected.toolTip ?? '<null>'}`)
					}
					const linkImagePath = [...linkPath, ...(linkParent == null ? [] : [linkParent]), 'linkImg']
					const linkImage = await safeFetch<MapleStoryIoWzNodeResponse>(id, linkImagePath, `raw MapLink image ${id}/${rawLinkId}`)
					if (linkImage.ok && expected != null) {
						const rawLinkImage = linkImage.value
						if (rawLinkImage != null && !rawCanvas(rawLinkImage)) {
							addMismatch(id, `raw MapLink image presence/type differs for ${rawLinkId}`)
							continue
						}
						const linkOrigin = rawLinkImage == null
							? null
							: await safeFetch<MapleStoryIoWzNodeResponse>(id, [...linkImagePath, 'origin'], `raw MapLink image origin ${id}/${rawLinkId}`, true)
						let rawRenderable: boolean | null = rawLinkImage == null ? false : null
						let rawOrigin: { x: number, y: number } | null = null
						if (linkOrigin?.ok) {
							rawOrigin = rawVector(linkOrigin.value)
							const originValue = linkOrigin.value?.value
							const originIsEmpty = originValue != null && typeof originValue === 'object' && !Array.isArray(originValue) && (originValue as { isEmpty?: unknown }).isEmpty === true
							rawRenderable = originIsEmpty ? false : rawOrigin == null ? null : true
						}
						if (rawRenderable != null && rawRenderable !== (expected.linkImage != null))
							addMismatch(id, `raw MapLink image presence/type differs for ${rawLinkId}`)
						if (rawRenderable === true && expected.linkImage != null) {
							const rawValueSha256 = this.rawWzValueSha256(region, version, linkImagePath)
							if (rawValueSha256 != null && !imagePayloadHashes(expected.linkImage.image).has(rawValueSha256))
								addMismatch(id, `raw MapLink image bytes differ for ${rawLinkId}`)
							if (linkOrigin?.ok && (rawOrigin == null || rawOrigin.x !== expected.linkImage.origin.x || rawOrigin.y !== expected.linkImage.origin.y))
								addMismatch(id, `raw MapLink image origin differs for ${rawLinkId}`)
						}
					}
				}

				const mapListName = rootChildren.includes('MapList') ? 'MapList' : rootChildren.includes('maps') ? 'maps' : null
				const rawSpotsResult = mapListName == null ? [] : await children(id, [...rootPath, mapListName], `raw MapList ${id}`)
				const rawSpots = rawSpotsResult ?? []
				if (rawSpotsResult != null && rawSpots.length !== node.maps.length)
					addMismatch(id, `raw MapList count ${rawSpots.length} differs from normalized ${node.maps.length}`)
				const matchedNormalizedSpotIndexes = new Set<number>()
				for (const rawSpotId of rawSpots) {
					const spotPath = [...rootPath, mapListName ?? 'MapList', rawSpotId]
					// The MapList parent already authoritatively inventories this child.
					// The spot/type/mapNo leaves below still detect deterministic absence,
					// transient failures, malformed values, and normalized mismatches.
					const spot = await safeFetch<MapleStoryIoWzNodeResponse>(id, [...spotPath, 'spot'], `raw MapList spot coordinate ${id}/${rawSpotId}`)
					const type = await safeFetch<MapleStoryIoWzNodeResponse>(id, [...spotPath, 'type'], `raw MapList type ${id}/${rawSpotId}`)
					const mapNo = await safeFetch<MapleStoryIoWzNodeResponse>(id, [...spotPath, 'mapNo'], `raw MapList mapNo ${id}/${rawSpotId}`)
					let rawMapNumbers: string[] | null = null
					if (mapNo.ok) {
						let rawMapNoIds: string[] | null = []
						if (mapNo.value != null) {
							try {
								rawMapNoIds = sortedChildren(mapNo.value, `raw MapList mapNo ${id}/${rawSpotId}`)
							}
							catch (error) {
								recordFailure(id, error)
								rawMapNoIds = null
							}
						}
						if (rawMapNoIds != null) {
							const values: string[] = []
							let valuesComplete = true
							for (const mapNoId of rawMapNoIds) {
								const value = await safeFetch<MapleStoryIoWzNodeResponse>(id, [...spotPath, 'mapNo', mapNoId], `raw MapList mapNo value ${id}/${rawSpotId}/${mapNoId}`)
								if (!value.ok) {
									valuesComplete = false
								}
								else if (typeof value.value?.value === 'number' || typeof value.value?.value === 'string') {
									values.push(String(value.value.value))
								}
								else {
									recordFailure(id, new Error(`MapleStory.IO returned malformed raw MapList mapNo value ${id}/${rawSpotId}/${mapNoId}`))
									valuesComplete = false
								}
							}
							if (valuesComplete)
								rawMapNumbers = values
						}
						else if (mapNo.value == null) {
							rawMapNumbers = []
						}
					}
					if (rawMapNumbers == null)
						continue
					const key = mapNumbersKey(rawMapNumbers)
					const rawSpotValue = spot.ok ? rawVector(spot.value) : null
					const rawTypeValue = type.ok ? rawInteger(type.value) : null
					const typeMatches = (candidate: GameWorldMapSpot): boolean => type.ok
						&& ((candidate.type != null && rawTypeValue === candidate.type)
							|| (candidate.type == null && (type.value == null || type.value.value == null)))
					const spotMatches = (candidate: GameWorldMapSpot): boolean => rawSpotValue != null
						&& candidate.spot.x === rawSpotValue.x
						&& candidate.spot.y === rawSpotValue.y
					const candidates = node.maps
						.map((candidate, index) => ({ candidate, index }))
						.filter(({ candidate, index }) => !matchedNormalizedSpotIndexes.has(index) && mapNumbersKey(candidate.mapNumbers) === key)
					const match = candidates.find(({ candidate }) => spotMatches(candidate) && typeMatches(candidate))
						?? candidates.find(({ candidate }) => spotMatches(candidate))
						?? candidates.find(({ candidate }) => typeMatches(candidate))
						?? candidates[0]
					if (match == null) {
						addMismatch(id, `raw MapList mapNo ${key} has no normalized match for ${rawSpotId}`)
						continue
					}
					matchedNormalizedSpotIndexes.add(match.index)
					const expected = match.candidate
					if (spot.ok && (rawSpotValue == null || rawSpotValue.x !== expected.spot.x || rawSpotValue.y !== expected.spot.y))
						addMismatch(id, `raw MapList spot coordinate differs for ${rawSpotId}`)
					if (type.ok && !typeMatches(expected))
						addMismatch(id, `raw MapList type differs for ${rawSpotId}`)
					if (JSON.stringify(sortedMapNumbers(rawMapNumbers)) !== JSON.stringify(sortedMapNumbers(expected.mapNumbers)))
						addMismatch(id, `raw MapList mapNo differs for ${rawSpotId}`)
				}
			}
			catch (error) {
				recordFailure(id, error)
			}
		}
		let next = 0
		const worker = async (): Promise<void> => {
			while (next < nodes.length) {
				const node = nodes[next++]!
				await auditNode(node)
			}
		}
		// Keep raw cross-check request pressure bounded independently from the
		// public-baseline worker count. This changes wall time, not request count.
		await Promise.all(Array.from({ length: Math.min(RAW_WZ_AUDIT_CONCURRENCY, Math.max(1, nodes.length)) }, () => worker()))
		return { failures, mismatches }
	}

	/**
	 * Direct String/Map.img authority for a known WZ string category. The raw
	 * API partitions map IDs by category (for example victoria/100000000), so
	 * callers must provide that exact category instead of guessing from a map
	 * title. Generation currently keeps the normalized same-snapshot /map list
	 * as its bulk transport and can use this method for audited raw joins.
	 */
	async fetchRawMapStrings(region: string, version: string, category: string, mapIds: readonly string[]): Promise<Record<string, MapleStoryIoRawMapStrings>> {
		if (!/^\w[\w.-]*$/u.test(category))
			throw new Error(`Invalid raw String/Map.img category: ${category}`)
		const result: Record<string, MapleStoryIoRawMapStrings> = {}
		for (const mapId of [...new Set(mapIds)]) {
			if (!/^\d+$/u.test(mapId))
				continue
			const node = await this.fetchRawWzNode(region, version, ['String', 'Map.img', category, mapId], `raw String/Map.img/${category}/${mapId}`)
			if (node == null)
				continue
			const readValue = async (property: 'mapName' | 'streetName'): Promise<string | null> => {
				const leaf = await this.fetchRawWzNode(region, version, ['String', 'Map.img', category, mapId, property], `raw String/Map.img/${category}/${mapId}/${property}`)
				if (leaf == null)
					return null
				if (typeof leaf.value !== 'string')
					throw new Error(`MapleStory.IO returned malformed raw String/Map.img/${category}/${mapId}/${property}`)
				const value = leaf.value.trim()
				return value.length === 0 ? null : value
			}
			result[mapId] = { name: await readValue('mapName'), streetName: await readValue('streetName') }
		}
		return result
	}

	private async listRawMapStringCategories(region: string, version: string): Promise<string[]> {
		const cacheKey = `${region}\u0000${version}`
		const cached = this.rawMapStringCategoriesCache.get(cacheKey)
		if (cached != null)
			return cached
		const request = (async () => {
			const response = await this.fetchRawWzNode(region, version, ['String', 'Map.img'], 'raw String/Map.img category inventory')
			if (response == null)
				throw new MapleStoryIoRequestError('raw String/Map.img category inventory', Object.assign(new Error('HTTP 404'), { status: 404 }))
			if (!Array.isArray(response.children) || response.children.some(child => typeof child !== 'string'))
				throw new Error('MapleStory.IO returned malformed raw String/Map.img category inventory')
			return [...new Set(response.children as string[])]
		})()
		this.rawMapStringCategoriesCache.set(cacheKey, request)
		return request
	}

	private async listRawMapStringCategoryIds(region: string, version: string, category: string): Promise<string[]> {
		const cacheKey = `${region}\u0000${version}\u0000${category}`
		const cached = this.rawMapStringCategoryIdsCache.get(cacheKey)
		if (cached != null)
			return cached
		const request = (async () => {
			const response = await this.fetchRawWzNode(region, version, ['String', 'Map.img', category], `raw String/Map.img/${category} map inventory`)
			if (response == null)
				throw new MapleStoryIoRequestError(`raw String/Map.img/${category} map inventory`, Object.assign(new Error('HTTP 404'), { status: 404 }))
			if (!Array.isArray(response.children) || response.children.some(child => typeof child !== 'string'))
				throw new Error(`MapleStory.IO returned malformed raw String/Map.img/${category} map inventory`)
			return [...new Set((response.children as string[]).filter(child => /^\d+$/u.test(child)))]
		})()
		this.rawMapStringCategoryIdsCache.set(cacheKey, request)
		return request
	}

	private async rawMapStringCategoryMap(region: string, version: string): Promise<Map<string, string>> {
		const cacheKey = `${region}\u0000${version}`
		const cached = this.rawMapStringCategoryMapCache.get(cacheKey)
		if (cached != null)
			return cached
		const request = (async () => {
			const result = new Map<string, string>()
			const categories = await this.listRawMapStringCategories(region, version)
			let next = 0
			const worker = async (): Promise<void> => {
				while (next < categories.length) {
					const category = categories[next++]!
					for (const mapId of await this.listRawMapStringCategoryIds(region, version, category)) {
						if (!result.has(mapId))
							result.set(mapId, category)
					}
				}
			}
			await Promise.all(Array.from({ length: Math.min(4, Math.max(1, categories.length)) }, () => worker()))
			return result
		})()
		this.rawMapStringCategoryMapCache.set(cacheKey, request)
		return request
	}

	/**
	 * Enumerates String/Map.img categories once per exact provider snapshot,
	 * caches mapId-to-category membership, then fetches only requested leaves.
	 * A missing raw leaf remains nullable; transient or malformed leaves are
	 * returned as structured failures so full generation can refuse authority.
	 */
	async fetchRawMapStringsByMapIds(region: string, version: string, mapIds: readonly string[]): Promise<MapleStoryIoRawMapStringAudit> {
		const values: Record<string, MapleStoryIoRawMapStrings> = {}
		const failures: Record<string, MapleStoryIoFailureKind> = {}
		const requested = [...new Set(mapIds)].filter(mapId => /^\d+$/u.test(mapId))
		const bulkImage = await this.fetchRawWzImage(
			region,
			version,
			['String', 'Map.img'],
			'Map.img',
			[],
			'raw bulk String/Map.img',
		)
		if (bulkImage != null) {
			try {
				const candidateMapNodes = Object.entries(bulkImage.children).flatMap(([name, category]) =>
					/^\d+$/u.test(name)
						? [category]
						: Object.entries(category.children)
								.filter(([mapId]) => /^\d+$/u.test(mapId))
								.map(([, map]) => map),
				)
				const hasPlausibleMapStringShape = candidateMapNodes.some((map) => {
					const name = map.children.mapName
					const streetName = map.children.streetName
					const present = [name, streetName].filter(value => value != null)
					return present.length > 0
						&& present.every(value => typeof value.value === 'string')
				})
				if (!hasPlausibleMapStringShape)
					throw new Error('bulk String/Map.img has no plausible category/map string shape')
				const mapNode = (mapId: string): RawWzImageNode | null => {
					for (const category of Object.values(bulkImage.children)) {
						const value = category.children[mapId]
						if (value != null)
							return value
					}
					return bulkImage.children[mapId] ?? null
				}
				const readString = (mapId: string, node: RawWzImageNode | undefined, field: string): string | null => {
					if (node == null)
						return null
					if (typeof node.value !== 'string')
						throw new Error(`MapleStory.IO returned malformed bulk String/Map.img/${mapId}/${field}`)
					const value = node.value.trim()
					return value.length === 0 ? null : value
				}
				for (const mapId of requested) {
					const map = mapNode(mapId)
					values[mapId] = {
						name: readString(mapId, map?.children.mapName, 'mapName'),
						streetName: readString(mapId, map?.children.streetName, 'streetName'),
					}
				}
				return { values, failures }
			}
			catch {
				// The bulk image is an optimization. Exact category/leaf requests
				// below remain authoritative when its shape or scalar types are bad.
			}
		}
		const categories = await this.rawMapStringCategoryMap(region, version)
		let next = 0
		const worker = async (): Promise<void> => {
			while (next < requested.length) {
				const mapId = requested[next++]!
				const category = categories.get(mapId)
				if (category == null) {
					values[mapId] = { name: null, streetName: null }
					continue
				}
				try {
					const [nameNode, streetNode] = await Promise.all([
						this.fetchRawWzNode(region, version, ['String', 'Map.img', category, mapId, 'mapName'], `raw String/Map.img/${category}/${mapId}/mapName`),
						this.fetchRawWzNode(region, version, ['String', 'Map.img', category, mapId, 'streetName'], `raw String/Map.img/${category}/${mapId}/streetName`),
					])
					const readValue = (node: MapleStoryIoWzNodeResponse | null, field: string): string | null => {
						if (node == null)
							return null
						if (typeof node.value !== 'string')
							throw new Error(`MapleStory.IO returned malformed raw String/Map.img/${category}/${mapId}/${field}`)
						const value = node.value.trim()
						return value.length === 0 ? null : value
					}
					values[mapId] = { name: readValue(nameNode, 'mapName'), streetName: readValue(streetNode, 'streetName') }
				}
				catch (error) {
					failures[mapId] = mapleStoryIoFailureKind(error)
				}
			}
		}
		await Promise.all(Array.from({ length: Math.min(4, Math.max(1, requested.length)) }, () => worker()))
		return { values, failures }
	}

	private async listWorldMapStringKeysUncached(region: string, version: string): Promise<string[]> {
		const response = await this.fetchRawWzNode(region, version, ['String', 'WorldMap.img'], 'String/WorldMap.img')
		if (response == null)
			return []
		if (!Array.isArray(response.children) || response.children.some(key => typeof key !== 'string'))
			throw new Error('MapleStory.IO returned malformed String/WorldMap.img root')
		return [...new Set(response.children as string[])]
	}

	async fetchWorldMapName(region: string, version: string, worldMapId: string): Promise<string | null> {
		const stringKey = worldMapStringKey(worldMapId)
		if (stringKey == null)
			return null
		const cacheKey = `${region}\u0000${version}\u0000${stringKey}`
		const cached = this.worldMapNameCache.get(cacheKey)
		if (cached != null)
			return cached
		const request = this.fetchWorldMapNameUncached(region, version, stringKey)
		this.worldMapNameCache.set(cacheKey, request)
		return request
	}

	private async fetchWorldMapNameUncached(region: string, version: string, stringKey: string): Promise<string | null> {
		const response = await this.getOptional<MapleStoryIoWzNodeResponse>(`${this.apiBaseUrl}/wz/${region}/${encodeURIComponent(version)}/String/WorldMap.img/${encodeURIComponent(stringKey)}/name`, `String/WorldMap.img/${stringKey}/name`)
		if (response == null)
			return null
		if (typeof response.value !== 'string')
			throw new Error(`MapleStory.IO returned malformed String/WorldMap.img/${stringKey}/name`)
		const value = response.value.trim()
		return value.length === 0 ? null : value
	}

	async fetchWorldMapNames(region: string, version: string, worldMapIds: readonly string[]): Promise<Record<string, string>> {
		const availableKeys = new Set(await this.listWorldMapStringKeys(region, version))
		const result: Record<string, string> = {}
		for (const worldMapId of [...new Set(worldMapIds)]) {
			const stringKey = worldMapStringKey(worldMapId)
			if (stringKey == null || !availableKeys.has(stringKey))
				continue
			const name = await this.fetchWorldMapName(region, version, worldMapId)
			if (name != null)
				result[worldMapId] = name
		}
		return result
	}

	async listWorldMapIds(region: string, version: string): Promise<string[]> {
		const cacheKey = `${region}\u0000${version}`
		const cached = this.worldMapListCache.get(cacheKey)
		if (cached != null)
			return cached
		const request = this.listWorldMapIdsUncached(region, version)
		this.worldMapListCache.set(cacheKey, request)
		return request
	}

	private async listWorldMapIdsUncached(region: string, version: string): Promise<string[]> {
		const response = await this.getNormalizedSnapshotResponse<unknown>(region, version, `${this.apiBaseUrl}/${region}/${encodeURIComponent(version)}/map/worldmap`, 'world map list')
		if (!Array.isArray(response) || response.some(id => typeof id !== 'string'))
			throw new Error('MapleStory.IO returned malformed world map list')
		return [...new Set(response.filter((id): id is string => typeof id === 'string' && id.length > 0))]
	}

	async listMaps(region: string, version: string): Promise<GameMapSearchCandidate[]> {
		const cacheKey = `${region}\u0000${version}`
		const cached = this.mapListCache.get(cacheKey)
		if (cached != null)
			return cached
		const request = this.listMapsUncached(region, version)
		this.mapListCache.set(cacheKey, request)
		return request
	}

	private async listMapsUncached(region: string, version: string): Promise<GameMapSearchCandidate[]> {
		const response = await this.getNormalizedSnapshotResponse<unknown>(region, version, `${this.apiBaseUrl}/${region}/${encodeURIComponent(version)}/map`, 'map list')
		if (!Array.isArray(response))
			throw new Error('MapleStory.IO returned malformed map list')
		return response.map((candidate: unknown) => {
			if (candidate == null || typeof candidate !== 'object')
				throw new Error('MapleStory.IO returned malformed map list item')
			const value = candidate as { id?: unknown, name?: unknown, streetName?: unknown }
			if (!/^\d+$/.test(String(value.id ?? '')) || (value.name != null && typeof value.name !== 'string') || (value.streetName != null && typeof value.streetName !== 'string'))
				throw new Error('MapleStory.IO returned malformed map list item')
			return {
				id: String(value.id),
				name: value.name == null ? null : value.name,
				streetName: value.streetName == null ? null : value.streetName,
			}
		})
	}

	async fetchWorldMap(region: string, version: string, id: string): Promise<GameWorldMap> {
		const cacheKey = `${region}\u0000${version}\u0000${id}`
		const cached = this.worldMapCache.get(cacheKey)
		if (cached != null)
			return cached
		const request = this.fetchWorldMapUncached(region, version, id)
		this.worldMapCache.set(cacheKey, request)
		return request
	}

	private async fetchWorldMapUncached(region: string, version: string, id: string): Promise<GameWorldMap> {
		const response = await this.getNormalizedSnapshotResponse<MapleStoryIoWorldMapResponse>(region, version, `${this.apiBaseUrl}/${region}/${encodeURIComponent(version)}/map/worldmap/${encodeURIComponent(id)}`, `world map ${id}`)
		if ((response.worldMapName != null && (typeof response.worldMapName !== 'string' || response.worldMapName.length === 0)) || !Array.isArray(response.maps) || !Array.isArray(response.baseImage))
			throw new Error(`MapleStory.IO returned malformed world map ${id}`)
		const image = (value: { image?: string, origin?: { x?: number, y?: number, isEmpty?: boolean } }, context: string): GameWorldMapImage | null => {
			if (value.origin?.isEmpty === true || value.image == null)
				return null
			if (value.image.length === 0 || value.origin == null || !Number.isInteger(value.origin.x) || !Number.isInteger(value.origin.y))
				throw new Error(`MapleStory.IO returned malformed ${context} in world map ${id}`)
			return { image: value.image, origin: { x: value.origin.x!, y: value.origin.y! } }
		}
		const baseImages = response.baseImage.map((value, index) => image(value, `baseImage[${index}]`)).filter((value): value is GameWorldMapImage => value != null)
		const links = (response.links ?? []).map((link, index) => {
			if (typeof link.linksTo !== 'string' || link.linksTo.length === 0)
				throw new Error(`MapleStory.IO returned malformed link[${index}] in world map ${id}`)
			return {
				toolTip: link.toolTip == null ? null : link.toolTip,
				linksTo: link.linksTo,
				linkImage: link.linkImage == null ? null : image(link.linkImage, `linkImage[${index}]`),
			}
		})
		const maps: GameWorldMapSpot[] = response.maps.map((map, index) => {
			if (map.spot == null || !Number.isInteger(map.spot.x) || !Number.isInteger(map.spot.y) || !Array.isArray(map.mapNumbers))
				throw new Error(`MapleStory.IO returned malformed maps[${index}] in world map ${id}`)
			return {
				spot: { x: map.spot.x!, y: map.spot.y! },
				type: map.type == null ? null : map.type,
				mapNumbers: map.mapNumbers.map(String),
			}
		})
		return {
			id,
			worldMapName: response.worldMapName ?? id,
			parentWorld: response.parentWorld ?? null,
			baseImages,
			links,
			maps,
			mapNumbers: maps.flatMap(map => map.mapNumbers),
		}
	}

	async fetchRawMapDetail(region: string, version: string, id: string): Promise<MapleStoryIoRawMapDetail | null> {
		const cacheKey = `${region}\u0000${version}\u0000${id}`
		const cached = this.rawMapDetailCache.get(cacheKey)
		if (cached != null)
			return cached
		const request = this.fetchRawMapDetailFollowingLinks(region, version, id, new Set<string>())
		this.rawMapDetailCache.set(cacheKey, request)
		return request
	}

	private async fetchRawMapDetailFollowingLinks(region: string, version: string, id: string, visited: Set<string>): Promise<MapleStoryIoRawMapDetail | null> {
		if (!/^\d+$/u.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) < 0)
			throw new Error(`Invalid raw map detail id: ${id}`)
		if (visited.has(id))
			throw new Error(`Raw map detail link cycle detected at ${id}`)
		visited.add(id)
		const candidates = [...new Set([id.padStart(8, '0'), id.padStart(9, '0')])]
		for (const imageId of candidates) {
			const imagePath = ['Map', 'Map', `Map${imageId[0]}`, `${imageId}.img`]
			const infoPath = [...imagePath, 'info']
			const info = await this.fetchRawWzNode(region, version, infoPath, `raw map info ${id}`)
			if (info == null)
				continue
			if (!Array.isArray(info.children) || info.children.some(child => typeof child !== 'string'))
				throw new Error(`MapleStory.IO returned malformed raw map info ${id}`)
			const children = new Set(info.children as string[])
			if (children.has('link')) {
				const link = await this.fetchRawWzNode(region, version, [...infoPath, 'link'], `raw map info link ${id}`)
				if (link == null || (typeof link.value !== 'number' && typeof link.value !== 'string') || !/^\d+$/u.test(String(link.value)))
					throw new Error(`MapleStory.IO returned malformed raw map info link ${id}`)
				const linkedId = String(link.value)
				const linked = await this.fetchRawMapDetailFollowingLinks(region, version, linkedId, visited)
				if (linked == null)
					throw new Error(`Raw map info link target ${linkedId} for ${id} is missing`)
				return linked
			}
			const readOptionalString = async (field: 'bgm' | 'mapMark'): Promise<string | null> => {
				if (!children.has(field))
					return null
				const leaf = await this.fetchRawWzNode(region, version, [...infoPath, field], `raw map info ${field} ${id}`)
				if (leaf == null || typeof leaf.value !== 'string')
					throw new Error(`MapleStory.IO returned malformed raw map info ${field} ${id}`)
				return leaf.value
			}
			const [backgroundMusic, mapMark] = await Promise.all([readOptionalString('bgm'), readOptionalString('mapMark')])
			return { backgroundMusic, mapMark, resolvedMapId: id }
		}
		return null
	}

	async fetchMap(region: string, version: string, id: string): Promise<GameMapDetail> {
		const cacheKey = `${region}\u0000${version}\u0000${id}`
		const cached = this.mapCache.get(cacheKey)
		if (cached != null)
			return cached
		const request = this.fetchMapUncached(region, version, id)
		this.mapCache.set(cacheKey, request)
		return request
	}

	async fetchMapBgmPath(region: string, version: string, id: string): Promise<string | null> {
		const endpoint = `${this.apiBaseUrl}/${region}/${encodeURIComponent(version)}/map/${encodeURIComponent(id)}/bgm`
		try {
			const response = await retryRequest(
				async (signal) => {
					const value = await this.rawFetcher(endpoint, {
						headers: { 'user-agent': this.userAgent },
						signal,
						redirect: 'manual',
						responseType: 'text',
						ignoreResponseError: true,
					})
					if (value.status >= 400)
						throw new HttpStatusError(value.status)
					if (value.status < 300 || value.status >= 400)
						throw new Error(`MapleStory.IO returned unexpected map BGM status ${value.status} for ${id}`)
					return value
				},
				this.retryTiming,
				async () => this.waitForMapDetailRequestStart(),
				`map BGM ${id}`,
			)
			const location = response.headers.get('location')
			if (location == null)
				throw new Error(`MapleStory.IO returned map BGM redirect without location for ${id}`)
			const resolved = new URL(location, endpoint)
			const musicPrefix = new URL(`${this.apiBaseUrl}/${region}/${encodeURIComponent(version)}/music/`)
			if (resolved.origin !== musicPrefix.origin || !resolved.pathname.startsWith(musicPrefix.pathname))
				throw new Error(`MapleStory.IO returned malformed map BGM redirect for ${id}`)
			const path = decodeURIComponent(resolved.pathname.slice(musicPrefix.pathname.length))
			if (path.length === 0)
				throw new Error(`MapleStory.IO returned empty map BGM path for ${id}`)
			return path
		}
		catch (error) {
			if (errorStatus(error) === 404)
				return null
			throw new MapleStoryIoRequestError(`map BGM ${id}`, error)
		}
	}

	async fetchMapsBounded(region: string, version: string, ids: readonly string[], concurrency = MAP_DETAIL_FETCH_CONCURRENCY): Promise<PromiseSettledResult<GameMapDetail>[]> {
		if (!Number.isSafeInteger(concurrency) || concurrency < 1)
			throw new Error(`Map detail concurrency must be a positive integer: ${concurrency}`)
		const results = Array.from<PromiseSettledResult<GameMapDetail>>({ length: ids.length })
		let next = 0
		const workerCount = Math.min(concurrency, ids.length)
		const worker = async (workerIndex: number): Promise<void> => {
			// Keep the existing per-request delay/retry behavior in fetchMap(), but
			// phase-shift workers so a batch does not release all requests at once.
			if (workerIndex > 0 && this.delayMs > 0)
				await this.sleep(Math.ceil(this.delayMs * workerIndex / workerCount))
			while (next < ids.length) {
				const index = next++
				const id = ids[index]!
				try {
					results[index] = { status: 'fulfilled', value: await this.fetchMap(region, version, id) }
				}
				catch (reason) {
					results[index] = { status: 'rejected', reason }
				}
			}
		}
		await Promise.all(Array.from({ length: workerCount }, (_, workerIndex) => worker(workerIndex)))
		return results
	}

	private async fetchMapUncached(region: string, version: string, id: string): Promise<GameMapDetail> {
		const response = await this.getNormalizedSnapshotResponse<MapleStoryIoMapResponse>(
			region,
			version,
			`${this.apiBaseUrl}/${region}/${encodeURIComponent(version)}/map/${encodeURIComponent(id)}`,
			`map ${id}`,
			async () => this.waitForMapDetailRequestStart(),
		)
		if (String(response.id ?? '') !== id)
			throw new Error(`MapleStory.IO returned malformed map ${id}`)
		if (response.backgroundMusic != null && typeof response.backgroundMusic !== 'string')
			throw new Error(`MapleStory.IO returned malformed backgroundMusic for map ${id}`)
		return {
			id,
			mapMark: response.mapMark ?? null,
			name: response.name ?? null,
			streetName: response.streetName ?? null,
			backgroundMusic: response.backgroundMusic ?? null,
		}
	}

	async searchMaps(region: string, version: string, searchFor: string): Promise<GameMapSearchCandidate[]> {
		const response = await this.getNormalizedSnapshotResponse<unknown>(region, version, `${this.apiBaseUrl}/${region}/${encodeURIComponent(version)}/map?searchFor=${encodeURIComponent(searchFor)}`, `map search ${searchFor}`)
		if (!Array.isArray(response))
			throw new Error(`MapleStory.IO returned malformed map search results for ${searchFor}`)
		return response.map((candidate: unknown) => {
			if (candidate == null || typeof candidate !== 'object')
				throw new Error(`MapleStory.IO returned malformed map search result for ${searchFor}`)
			const value = candidate as { id?: unknown, name?: unknown, streetName?: unknown }
			if (!/^\d+$/.test(String(value.id ?? '')) || (value.name != null && typeof value.name !== 'string') || (value.streetName != null && typeof value.streetName !== 'string'))
				throw new Error(`MapleStory.IO returned malformed map search result for ${searchFor}`)
			return {
				id: String(value.id),
				name: value.name == null ? null : value.name,
				streetName: value.streetName == null ? null : value.streetName,
			}
		})
	}
}

export async function acquireGameData(
	client: MapleStoryIoClient,
	config: WorldMapSourceConfig,
	version: string,
	mapIds: readonly string[],
): Promise<GameDataSnapshot> {
	try {
		const worldMaps = new Map<string, GameWorldMap>()
		const pendingWorldMaps = [config.gameWorldMapId]
		while (pendingWorldMaps.length > 0) {
			const id = pendingWorldMaps.shift()!
			if (worldMaps.has(id))
				continue
			const worldMap = await client.fetchWorldMap(config.gameRegion, version, id)
			worldMaps.set(id, worldMap)
			for (const link of worldMap.links) {
				if (!worldMaps.has(link.linksTo))
					pendingWorldMaps.push(link.linksTo)
			}
		}
		const candidateMapIds = new Set(mapIds)
		for (const worldMap of worldMaps.values()) {
			if (worldMap.mapNumbers[0] != null)
				candidateMapIds.add(worldMap.mapNumbers[0])
		}
		const maps: GameMapDetail[] = []
		for (const mapId of candidateMapIds)
			maps.push(await client.fetchMap(config.gameRegion, version, mapId))
		return {
			provider: 'maplestory-io',
			region: config.gameRegion,
			version,
			apiBase: client.apiBase,
			worldMaps: [...worldMaps.values()],
			maps,
		}
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(`Game-data acquisition failed for ${config.id}: ${message}`)
	}
}

export interface WorldMapGraphRequest {
	rootId: string
	maxDepth: number
}

export type WorldMapGraphAcquisitionMode = 'preview' | 'full'

export interface WorldMapGraphAcquisitionOptions {
	mode: WorldMapGraphAcquisitionMode
	requests: readonly WorldMapGraphRequest[]
	logicalRegion?: 'GMS' | 'TWMS'
	priorityMapIds?: readonly string[]
	previewMapDetailLimit?: number
	/** Optional maintainer audit of the exact raw WZ WorldMap inventory. */
	rawWzAudit?: boolean
}

export interface AcquiredWorldMapGraph {
	provider: 'maplestory-io' | 'maplearchive' | 'archived-wz'
	region: string
	logicalRegion?: 'GMS' | 'TWMS'
	version: string
	apiBase: string
	releaseId?: string
	archivedWz?: ArchivedWzPublishedProvenance
	roots: string[]
	nodes: GameWorldMap[]
	maps: GameMapDetail[]
	/** Exact same-snapshot String/WorldMap.img names keyed by native WorldMap ID. */
	worldMapNames?: Record<string, string>
	/** Raw WZ inventory observed alongside the normalized graph acquisition. */
	rawWzWorldMapIds?: string[]
	/** Exact raw String/Map.img values keyed by map ID when audited. */
	rawWzMapStrings?: Record<string, MapleStoryIoRawMapStrings>
	warnings?: string[]
	/** Structured acquisition status; only MapleStory.IO currently populates this. */
	completeness?: WorldMapGraphCompleteness
}

export interface WorldMapGraphCompleteness {
	complete: boolean
	/** Every renderable screen returned by the exact native index succeeded; raw-proven control entries are excluded. */
	worldMapIndexComplete: boolean
	worldMapIndexFailures: Record<string, WorldMapGraphFailureKind>
	/** Extra linked/requested WorldMaps are complete unless their failure is deterministic absence. */
	worldMapUnindexedFailures: Record<string, WorldMapGraphFailureKind>
	/** All failed WorldMap fetches, including failures allowed to remain unresolved. */
	worldMapFailures: Record<string, WorldMapGraphFailureKind>
	mapDetailFailures: Record<string, MapleStoryIoFailureKind>
	worldMapNamesFailure: MapleStoryIoFailureKind | null
	rawWzInventoryComplete: boolean | null
	rawWzInventoryFailure: MapleStoryIoFailureKind | null
	rawWzAbsentWorldMapIds: string[]
	rawWzUnindexedWorldMapIds: string[]
	rawWzWorldMapAuditFailures: Record<string, MapleStoryIoFailureKind>
	rawWzWorldMapMismatches: Record<string, string[]>
	rawWzMapStringsFailure: MapleStoryIoFailureKind | null
	rawWzMapStringFailures: Record<string, MapleStoryIoFailureKind>
}

function mapListDetail(candidate: GameMapSearchCandidate): GameMapDetail {
	return {
		id: candidate.id,
		mapMark: null,
		name: candidate.name,
		streetName: candidate.streetName,
		backgroundMusic: null,
	}
}

/**
 * Preview mode traverses only explicitly bounded roots and samples representative map details.
 * Full mode enumerates MapleStory.IO's native WorldMap index, fetches every valid screen
 * sequentially, follows any additional link targets, and fetches one GMS detail per visual
 * spot so every reachable hotspot can resolve its native BGM without downloading every
 * historical/variant map in spot.mapNumbers.
 */
export async function acquireWorldMapGraph(
	client: MapleStoryIoClient,
	region: string,
	version: string,
	options: WorldMapGraphAcquisitionOptions,
): Promise<AcquiredWorldMapGraph> {
	const nodes = new Map<string, GameWorldMap>()
	const warnings: string[] = []
	const queue: Array<{ id: string, depth: number, maxDepth: number }> = []
	const worldMapIndexFailures: Record<string, WorldMapGraphFailureKind> = {}
	const worldMapUnindexedFailures: Record<string, WorldMapGraphFailureKind> = {}
	const worldMapFailures: Record<string, WorldMapGraphFailureKind> = {}
	const mapDetailFailures: Record<string, MapleStoryIoFailureKind> = {}
	let worldMapNamesFailure: MapleStoryIoFailureKind | null = null
	let listedWorldMapIds: string[] = []
	let listedWorldMapIdSet = new Set<string>()
	let rawWzWorldMapIds: string[] | undefined
	let rawWzInventoryComplete: boolean | null = null
	let rawWzInventoryFailure: MapleStoryIoFailureKind | null = null
	const rawWzAbsentWorldMapIds = new Set<string>()
	const rawWzUnindexedWorldMapIds = new Set<string>()
	let rawWzWorldMapAuditFailures: Record<string, MapleStoryIoFailureKind> = {}
	let rawWzWorldMapMismatches: Record<string, string[]> = {}
	let rawWzMapStrings: Record<string, MapleStoryIoRawMapStrings> | undefined
	let rawWzMapStringsFailure: MapleStoryIoFailureKind | null = null
	let rawWzMapStringFailures: Record<string, MapleStoryIoFailureKind> = {}
	if (options.mode === 'full') {
		listedWorldMapIds = await client.listWorldMapIds(region, version)
		listedWorldMapIdSet = new Set(listedWorldMapIds)
		if (options.rawWzAudit === true) {
			rawWzInventoryComplete = false
			try {
				rawWzWorldMapIds = await client.listRawWorldMapIds(region, version)
				rawWzInventoryComplete = true
				const rawIds = new Set(rawWzWorldMapIds)
				const missingFromRaw = listedWorldMapIds.filter(id => !rawIds.has(id))
				if (missingFromRaw.length > 0)
					warnings.push(`Raw WZ WorldMap inventory is missing normalized index entries: ${missingFromRaw.join(', ')}`)
				for (const id of rawWzWorldMapIds.filter(id => !listedWorldMapIdSet.has(id)))
					rawWzUnindexedWorldMapIds.add(id)
				if (rawWzUnindexedWorldMapIds.size > 0)
					warnings.push(`Raw WZ WorldMap inventory contains unindexed entries; normalized transport will be checked for them: ${[...rawWzUnindexedWorldMapIds].join(', ')}`)
			}
			catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				rawWzInventoryFailure = mapleStoryIoFailureKind(error)
				warnings.push(`Raw WZ WorldMap inventory unavailable; full completeness is blocked: ${message}`)
			}
		}
		for (const id of [...new Set([...listedWorldMapIds, ...(rawWzWorldMapIds ?? [])])])
			queue.push({ id, depth: 0, maxDepth: Number.POSITIVE_INFINITY })
		for (const request of options.requests)
			queue.push({ id: request.rootId, depth: 0, maxDepth: Number.POSITIVE_INFINITY })
	}
	else {
		queue.push(...options.requests.map(request => ({ id: request.rootId, depth: 0, maxDepth: request.maxDepth })))
	}

	const attempted = new Set<string>()
	while (queue.length > 0) {
		const current = queue.shift()!
		if (attempted.has(current.id))
			continue
		attempted.add(current.id)
		if (rawWzInventoryComplete === true && !new Set(rawWzWorldMapIds ?? []).has(current.id)) {
			rawWzAbsentWorldMapIds.add(current.id)
			warnings.push(`Raw WZ WorldMap inventory proves ${current.id} is absent; retaining the normalized link as an explicit unresolved reference.`)
			continue
		}
		let node: GameWorldMap
		try {
			node = await client.fetchWorldMap(region, version, current.id)
		}
		catch (error) {
			if (options.mode === 'preview')
				throw error
			const message = error instanceof Error ? error.message : String(error)
			warnings.push(`Skipped native world map ${current.id}: ${message}`)
			if (options.mode === 'full') {
				worldMapFailures[current.id] = mapleStoryIoFailureKind(error)
				if (listedWorldMapIdSet.has(current.id))
					worldMapIndexFailures[current.id] = worldMapFailures[current.id]!
				else
					worldMapUnindexedFailures[current.id] = worldMapFailures[current.id]!
			}
			continue
		}
		if (node.baseImages.length === 0) {
			const rawEligible = options.mode === 'full'
				&& options.rawWzAudit === true
				&& rawWzInventoryComplete === true
				&& new Set(rawWzWorldMapIds ?? []).has(current.id)
			let rawScreenShape: boolean | null = null
			if (rawEligible) {
				try {
					rawScreenShape = await client.rawWorldMapHasScreenShape(region, version, current.id)
				}
				catch {
					// Failure to classify the exact raw node must not weaken completeness.
				}
			}
			if (rawScreenShape === false) {
				warnings.push(`Skipped native WorldMap index control entry ${current.id}: exact raw WZ has no screen structure`)
				continue
			}
			if (rawEligible) {
				try {
					const rawBaseImages = await client.fetchRawWorldMapBaseImages(region, version, current.id)
					if (rawBaseImages.length > 0) {
						node = { ...node, baseImages: rawBaseImages }
						warnings.push(`Normalized WorldMap ${current.id} omitted renderable BaseImg Canvas data; exact raw WZ BaseImg used.`)
					}
				}
				catch {
					// Failure to recover raw Canvas data must not weaken completeness.
				}
			}
			if (node.baseImages.length === 0) {
				warnings.push(`Skipped native world map ${current.id}: no renderable base image`)
				if (options.mode === 'full') {
					worldMapFailures[current.id] = 'unrenderable'
					if (listedWorldMapIdSet.has(current.id))
						worldMapIndexFailures[current.id] = 'unrenderable'
					else
						worldMapUnindexedFailures[current.id] = 'unrenderable'
				}
				continue
			}
		}
		nodes.set(current.id, node)
		if (current.depth < current.maxDepth) {
			for (const link of node.links) {
				if (!attempted.has(link.linksTo))
					queue.push({ id: link.linksTo, depth: current.depth + 1, maxDepth: current.maxDepth })
			}
		}
	}
	if (options.mode === 'full' && options.rawWzAudit === true && rawWzInventoryComplete === true) {
		const rawWorldMapAudit = await client.auditRawWorldMaps(region, version, [...nodes.values()])
		rawWzWorldMapAuditFailures = rawWorldMapAudit.failures
		rawWzWorldMapMismatches = rawWorldMapAudit.mismatches
		for (const [id, kind] of Object.entries(rawWzWorldMapAuditFailures))
			warnings.push(`Raw WZ WorldMap audit failed for ${id} (${kind}); full completeness is blocked.`)
		for (const [id, messages] of Object.entries(rawWzWorldMapMismatches))
			warnings.push(`Raw WZ WorldMap audit mismatch for ${id}: ${messages.join('; ')}`)
	}

	const allMapIds: string[] = []
	const representativeMapIds: string[] = []
	const seenAll = new Set<string>()
	const seenRepresentative = new Set<string>()
	const addAll = (mapId: string) => {
		if (!seenAll.has(mapId)) {
			seenAll.add(mapId)
			allMapIds.push(mapId)
		}
	}
	const addRepresentative = (mapId: string) => {
		addAll(mapId)
		// Some historical region snapshots expose 0 as a native placeholder in
		// mapNumbers. Preserve it in topology, but never issue a /map/0 detail
		// request because it is not a real game map and can hang upstream.
		if (!/^\d+$/u.test(mapId) || Number(mapId) <= 0)
			return
		if (!seenRepresentative.has(mapId)) {
			seenRepresentative.add(mapId)
			representativeMapIds.push(mapId)
		}
	}
	for (const mapId of options.priorityMapIds ?? [])
		addRepresentative(mapId)
	for (const node of nodes.values()) {
		for (const spot of node.maps) {
			for (const mapId of spot.mapNumbers)
				addAll(mapId)
			if (spot.mapNumbers[0] != null)
				addRepresentative(spot.mapNumbers[0])
		}
	}
	if (options.mode === 'full' && options.rawWzAudit === true && rawWzInventoryComplete === true) {
		try {
			const rawMapStringAudit = await client.fetchRawMapStringsByMapIds(region, version, allMapIds)
			rawWzMapStrings = rawMapStringAudit.values
			rawWzMapStringFailures = rawMapStringAudit.failures
		}
		catch (error) {
			rawWzMapStringsFailure = mapleStoryIoFailureKind(error)
			const message = error instanceof Error ? error.message : String(error)
			warnings.push(`Raw String/Map.img inventory unavailable; normalized map strings retained: ${message}`)
		}
	}

	const bulkById = new Map<string, GameMapDetail>()
	if (options.mode === 'full') {
		for (const candidate of await client.listMaps(region, version)) {
			if (seenAll.has(candidate.id))
				bulkById.set(candidate.id, mapListDetail(candidate))
		}
	}

	const detailedById = new Map<string, GameMapDetail>()
	const detailIds = options.mode === 'full'
		? representativeMapIds
		: representativeMapIds.slice(0, options.previewMapDetailLimit ?? 32)
	if (options.mode === 'full') {
		const detailResults = await client.fetchMapsBounded(region, version, detailIds)
		for (const [index, result] of detailResults.entries()) {
			const mapId = detailIds[index]!
			if (result.status === 'fulfilled') {
				detailedById.set(mapId, result.value)
				continue
			}
			const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
			const failureKind = mapleStoryIoFailureKind(result.reason)
			if (options.rawWzAudit === true && failureKind !== 'not-found') {
				try {
					const rawDetail = await client.fetchRawMapDetail(region, version, mapId)
					if (rawDetail != null) {
						const bulk = bulkById.get(mapId) ?? { id: mapId, mapMark: null, name: null, streetName: null, backgroundMusic: null }
						detailedById.set(mapId, { ...bulk, mapMark: rawDetail.mapMark, backgroundMusic: rawDetail.backgroundMusic })
						warnings.push(`GMS map detail ${mapId} normalized endpoint unavailable; exact raw WZ info used: ${message}`)
						continue
					}
					// A successful exact raw-WZ lookup that finds no map image proves the
					// normalized endpoint's transient-looking failure is deterministic absence.
					warnings.push(`GMS map detail ${mapId} normalized endpoint unavailable; exact raw WZ map is absent: ${message}`)
					mapDetailFailures[mapId] = 'not-found'
					continue
				}
				catch (rawError) {
					const rawMessage = rawError instanceof Error ? rawError.message : String(rawError)
					warnings.push(`Raw WZ map detail fallback ${mapId} unavailable: ${rawMessage}`)
				}
			}
			if (failureKind !== 'not-found') {
				const bulk = bulkById.get(mapId)
				if (bulk != null) {
					try {
						const backgroundMusic = await client.fetchMapBgmPath(region, version, mapId)
						detailedById.set(mapId, { ...bulk, mapMark: null, backgroundMusic })
						warnings.push(`Map detail ${mapId} normalized/raw endpoints unavailable; exact map inventory and BGM endpoint used with mapMark unavailable: ${message}`)
						continue
					}
					catch (bgmError) {
						const bgmMessage = bgmError instanceof Error ? bgmError.message : String(bgmError)
						warnings.push(`Map BGM fallback ${mapId} unavailable: ${bgmMessage}`)
					}
				}
			}
			warnings.push(`GMS map detail ${mapId} unavailable: ${message}`)
			mapDetailFailures[mapId] = failureKind
		}
	}
	else {
		for (const mapId of detailIds)
			detailedById.set(mapId, await client.fetchMap(region, version, mapId))
	}

	const publishedMapIds = options.mode === 'full' ? allMapIds : detailIds
	const maps = publishedMapIds.map((mapId) => {
		const detail = detailedById.get(mapId)
		const normalized = detail ?? bulkById.get(mapId) ?? {
			id: mapId,
			mapMark: null,
			name: null,
			streetName: null,
			backgroundMusic: null,
		}
		const raw = rawWzMapStrings?.[mapId]
		return raw == null
			? normalized
			: { ...normalized, name: raw.name ?? normalized.name, streetName: raw.streetName ?? normalized.streetName }
	})
	let worldMapNames: Record<string, string> = {}
	try {
		worldMapNames = await client.fetchWorldMapNames(region, version, [...nodes.keys()])
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		warnings.push(`String/WorldMap.img names unavailable: ${message}`)
		worldMapNamesFailure = mapleStoryIoFailureKind(error)
	}
	const worldMapIndexComplete = Object.keys(worldMapIndexFailures).length === 0
	const rawWzAbsentIds = new Set(rawWzAbsentWorldMapIds)
	const rawWzPresentIds = new Set(rawWzWorldMapIds ?? [])
	const worldMapUnindexedComplete = Object.entries(worldMapUnindexedFailures)
		.every(([id, kind]) => rawWzAbsentIds.has(id) || (!rawWzPresentIds.has(id) && (kind === 'not-found' || kind === 'unrenderable')))
	const detailAndNamesComplete = [...Object.values(mapDetailFailures), worldMapNamesFailure]
		.every(kind => kind == null || kind === 'not-found')
	const rawWzComplete = options.rawWzAudit !== true
		|| (rawWzInventoryComplete === true
			&& Object.keys(rawWzWorldMapAuditFailures).length === 0
			&& Object.keys(rawWzWorldMapMismatches).length === 0
			&& (rawWzMapStringsFailure == null || rawWzMapStringsFailure === 'not-found')
			&& Object.values(rawWzMapStringFailures).every(kind => kind === 'not-found'))
	return {
		provider: 'maplestory-io',
		region,
		logicalRegion: options.logicalRegion,
		version,
		apiBase: client.apiBase,
		roots: [...new Set(options.requests.map(request => request.rootId))],
		nodes: [...nodes.values()],
		maps,
		worldMapNames,
		rawWzMapStrings,
		rawWzWorldMapIds,
		warnings,
		completeness: {
			complete: worldMapIndexComplete && worldMapUnindexedComplete && detailAndNamesComplete && rawWzComplete,
			worldMapIndexComplete,
			worldMapIndexFailures,
			worldMapUnindexedFailures,
			worldMapFailures,
			mapDetailFailures,
			worldMapNamesFailure,
			rawWzInventoryComplete,
			rawWzInventoryFailure,
			rawWzAbsentWorldMapIds: [...rawWzAbsentWorldMapIds].sort(),
			rawWzUnindexedWorldMapIds: [...rawWzUnindexedWorldMapIds].sort(),
			rawWzWorldMapAuditFailures,
			rawWzWorldMapMismatches,
			rawWzMapStringsFailure,
			rawWzMapStringFailures,
		},
	}
}

export async function writeVerifiedWzImage(
	image: GameWorldMapImage,
	assetRoot: string,
	file: string,
): Promise<WorldMapAsset> {
	if ((!file.startsWith('world-map/') && !file.startsWith('world-map-preview/')) || file.includes('..'))
		throw new Error(`Invalid WZ asset path: ${file}`)
	const encoded = image.image.replace(/^data:image\/png;base64,/i, '')
	const bytes = Buffer.from(encoded, 'base64')
	if (bytes.byteLength === 0)
		throw new Error(`WZ image is empty: ${file}`)
	const metadata = await sharp(bytes).metadata()
	if (!Number.isInteger(metadata.width) || !Number.isInteger(metadata.height) || metadata.width <= 0 || metadata.height <= 0)
		throw new Error(`WZ image has invalid dimensions: ${file}`)
	const sha1 = createHash('sha1')
		.update(bytes)
		.digest('hex')
	const target = path.join(assetRoot, file)
	await mkdir(path.dirname(target), { recursive: true })
	await writeFile(target, bytes)
	return {
		file,
		width: metadata.width,
		height: metadata.height,
		sha1,
		origin: image.origin,
	}
}

export async function acquireLocalizedGameData(
	client: MapleStoryIoClient,
	region: string,
	version: string,
	locale: string,
	mapIds: readonly string[],
	worldMapIds: readonly string[],
	options: { useBulkMapList?: boolean } = {},
): Promise<LocalizedGameDataSnapshot> {
	try {
		const worldMaps: GameWorldMap[] = []
		let lastWorldMapError: unknown = null
		for (const worldMapId of [...new Set(worldMapIds)]) {
			try {
				worldMaps.push(await client.fetchWorldMap(region, version, worldMapId))
			}
			catch (error) {
				lastWorldMapError = error
			}
		}
		const maps: GameMapDetail[] = []
		let lastMapError: unknown = null
		if (options.useBulkMapList) {
			try {
				const wanted = new Set(mapIds)
				for (const candidate of await client.listMaps(region, version)) {
					if (wanted.has(candidate.id))
						maps.push(mapListDetail(candidate))
				}
			}
			catch (error) {
				lastMapError = error
			}
		}
		else {
			for (const mapId of [...new Set(mapIds)]) {
				try {
					maps.push(await client.fetchMap(region, version, mapId))
				}
				catch (error) {
					lastMapError = error
				}
			}
		}
		if (worldMaps.length === 0 && maps.length === 0 && lastWorldMapError != null)
			throw lastWorldMapError
		if (worldMaps.length === 0 && maps.length === 0 && lastMapError != null)
			throw lastMapError
		return {
			provider: 'maplestory-io',
			region,
			version,
			apiBase: client.apiBase,
			locale,
			worldMaps,
			maps,
		}
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(`Localized game-data acquisition failed for ${locale}/${region}: ${message}`)
	}
}

export function localAssetName(file: string): string {
	return file.replaceAll(' ', '_').replaceAll('/', '_')
}

export interface ImageDownloadOptions extends RetryTimingOptions {
	delayMs?: number
	userAgent?: string
	fetcher?: typeof fetch
}

export async function downloadVerifiedImage(
	file: string,
	info: WikiImageInfo,
	outputDir: string,
	options: ImageDownloadOptions = {},
): Promise<string> {
	const sleep = options.sleep ?? delay
	const retryTiming: Required<RetryTimingOptions> = {
		timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
		maxRetries: options.maxRetries ?? MAX_RETRIES,
		retryBackoffMs: options.retryBackoffMs ?? RETRY_BACKOFF_MS,
		sleep,
	}
	let bytes: Buffer
	try {
		bytes = await retryRequest(
			async (signal) => {
				const response = await (options.fetcher ?? fetch)(info.url, {
					headers: { 'user-agent': options.userAgent ?? USER_AGENT },
					signal,
				})
				if (!response.ok)
					throw new HttpStatusError(response.status)
				return Buffer.from(await response.arrayBuffer())
			},
			retryTiming,
			async () => sleep(options.delayMs ?? IMAGE_DOWNLOAD_DELAY_MS),
			`image ${file}`,
		)
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(`Image download failed for ${file}: ${message}`)
	}
	if (bytes.byteLength !== info.size)
		throw new Error(`Image integrity failure for ${file}: expected ${info.size} bytes, got ${bytes.byteLength}`)
	const sha1 = createHash('sha1')
		.update(bytes)
		.digest('hex')
	if (sha1 !== info.sha1)
		throw new Error(`Image integrity failure for ${file}: expected SHA-1 ${info.sha1}, got ${sha1}`)
	if (!info.mime.startsWith('image/'))
		throw new Error(`Image metadata has a non-image MIME type for ${file}: ${info.mime}`)
	const localFile = localAssetName(file)
	await mkdir(outputDir, { recursive: true })
	await writeFile(path.join(outputDir, localFile), bytes)
	return localFile
}

export async function acquireWorldMapSource(
	client: WikiClient,
	config: WorldMapSourceConfig,
): Promise<AcquiredWorldMapSource> {
	try {
		const page = await client.fetchRevision(config.pageTitle)
		const mapSourcePage = config.worldMapWikitextTitle === config.pageTitle
			? page
			: await client.fetchRevision(config.worldMapWikitextTitle)
		const pageRevision = getRevision(page, config.pageTitle)
		const mapSourceRevision = getRevision(mapSourcePage, config.worldMapWikitextTitle)
		const baseImageFile = parseBaseImage(mapSourceRevision.content)
		const points = parsePoints(mapSourceRevision.content)
		const targetTitles = [...new Set(points.map(point => normalizeWikiTitle(point.target.split('#', 1)[0]!)).filter(Boolean))]
		const targetPages = await client.fetchRevisions(targetTitles)
		const allImageFiles = [baseImageFile, ...points.map(point => point.markerFile)]
		const imageInfoByFile = await client.fetchImageInfo(allImageFiles)
		return {
			config,
			pageRevision,
			mapSourceRevision,
			baseImageFile,
			points,
			targetPages,
			imageInfoByFile,
		}
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(`World-map acquisition failed for ${config.id}: ${message}`)
	}
}
