import type { WorldMapAsset } from './schema'
import type { AcquiredWorldMapSource, GameDataSnapshot, GameMapDetail, GameMapSearchCandidate, GameWorldMap, GameWorldMapImage, GameWorldMapSpot, LocalizedGameDataSnapshot, WikiImageInfo, WikiPage, WorldMapSourceConfig } from './source'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { ofetch } from 'ofetch'
import path from 'pathe'
import sharp from 'sharp'
import { getRevision, normalizeWikiTitle, parseBaseImage, parsePoints } from './parse'

export const WIKI_API = 'https://maplestorywiki.net/api.php'
export const BGM_DB_URL = 'https://raw.githubusercontent.com/maplestory-music/maplebgm-db/prod/bgm.min.json'
export const USER_AGENT = 'maple-pod-resources-world-map/1.0 (https://github.com/maple-pod/resources)'
export const REQUEST_DELAY_MS = 1000
export const IMAGE_INFO_BATCH_SIZE = 5
export const IMAGE_DOWNLOAD_DELAY_MS = 500
export const REQUEST_TIMEOUT_MS = 15000
export const MAX_RETRIES = 2
export const RETRY_BACKOFF_MS = 250
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
	apiBase?: string
	/** Bounded request timing; injectable for deterministic offline tests. */
	timeoutMs?: number
	maxRetries?: number
	retryBackoffMs?: number
	sleep?: Sleep
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

export class MapleStoryIoClient {
	private readonly delayMs: number
	private readonly userAgent: string
	private readonly fetcher: typeof ofetch
	private readonly apiBaseUrl: string
	private readonly retryTiming: Required<RetryTimingOptions>
	private readonly sleep: Sleep
	private readonly worldMapCache = new Map<string, Promise<GameWorldMap>>()
	private readonly mapCache = new Map<string, Promise<GameMapDetail>>()
	private readonly worldMapListCache = new Map<string, Promise<string[]>>()
	private readonly mapListCache = new Map<string, Promise<GameMapSearchCandidate[]>>()

	constructor(options: MapleStoryIoClientOptions = {}) {
		this.delayMs = options.delayMs ?? REQUEST_DELAY_MS
		this.userAgent = options.userAgent ?? USER_AGENT
		this.fetcher = options.fetcher ?? ofetch
		this.apiBaseUrl = options.apiBase ?? MAPLESTORY_IO_API
		this.sleep = options.sleep ?? delay
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

	private async get<T>(url: string, context: string): Promise<T> {
		try {
			return await retryRequest(
				signal => this.fetcher<T>(url, { headers: { 'user-agent': this.userAgent }, signal }),
				this.retryTiming,
				async () => this.sleep(this.delayMs),
				context,
			)
		}
		catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			throw new Error(`MapleStory.IO request failed for ${context}: ${message}`)
		}
	}

	async resolveLatestReadyVersion(region: string): Promise<number> {
		const versions = await this.get<ReadyVersion[]>(`${this.apiBaseUrl}/wz`, 'version list')
		const numericVersions = versions
			.filter(version => version.region === region && version.isReady && version.hasImages && /^\d+$/.test(version.mapleVersionId))
			.map(version => Number(version.mapleVersionId))
			.filter(Number.isSafeInteger)
		if (numericVersions.length === 0)
			throw new Error(`MapleStory.IO has no ready numeric ${region} version with images`)
		return Math.max(...numericVersions)
	}

	async listWorldMapIds(region: string, version: number): Promise<string[]> {
		const cacheKey = `${region}\u0000${version}`
		const cached = this.worldMapListCache.get(cacheKey)
		if (cached != null)
			return cached
		const request = this.listWorldMapIdsUncached(region, version)
		this.worldMapListCache.set(cacheKey, request)
		return request
	}

	private async listWorldMapIdsUncached(region: string, version: number): Promise<string[]> {
		const response = await this.get<unknown>(`${this.apiBaseUrl}/${region}/${version}/map/worldmap`, 'world map list')
		if (!Array.isArray(response) || response.some(id => typeof id !== 'string'))
			throw new Error('MapleStory.IO returned malformed world map list')
		return [...new Set(response.filter((id): id is string => typeof id === 'string' && id.length > 0))]
	}

	async listMaps(region: string, version: number): Promise<GameMapSearchCandidate[]> {
		const cacheKey = `${region}\u0000${version}`
		const cached = this.mapListCache.get(cacheKey)
		if (cached != null)
			return cached
		const request = this.listMapsUncached(region, version)
		this.mapListCache.set(cacheKey, request)
		return request
	}

	private async listMapsUncached(region: string, version: number): Promise<GameMapSearchCandidate[]> {
		const response = await this.get<unknown>(`${this.apiBaseUrl}/${region}/${version}/map`, 'map list')
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

	async fetchWorldMap(region: string, version: number, id: string): Promise<GameWorldMap> {
		const cacheKey = `${region}\u0000${version}\u0000${id}`
		const cached = this.worldMapCache.get(cacheKey)
		if (cached != null)
			return cached
		const request = this.fetchWorldMapUncached(region, version, id)
		this.worldMapCache.set(cacheKey, request)
		return request
	}

	private async fetchWorldMapUncached(region: string, version: number, id: string): Promise<GameWorldMap> {
		const response = await this.get<MapleStoryIoWorldMapResponse>(`${this.apiBaseUrl}/${region}/${version}/map/worldmap/${encodeURIComponent(id)}`, `world map ${id}`)
		if (response.worldMapName !== id || !Array.isArray(response.maps) || !Array.isArray(response.baseImage))
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
			worldMapName: response.worldMapName,
			parentWorld: response.parentWorld ?? null,
			baseImages,
			links,
			maps,
			mapNumbers: maps.flatMap(map => map.mapNumbers),
		}
	}

	async fetchMap(region: string, version: number, id: string): Promise<GameMapDetail> {
		const cacheKey = `${region}\u0000${version}\u0000${id}`
		const cached = this.mapCache.get(cacheKey)
		if (cached != null)
			return cached
		const request = this.fetchMapUncached(region, version, id)
		this.mapCache.set(cacheKey, request)
		return request
	}

	private async fetchMapUncached(region: string, version: number, id: string): Promise<GameMapDetail> {
		const response = await this.get<MapleStoryIoMapResponse>(`${this.apiBaseUrl}/${region}/${version}/map/${encodeURIComponent(id)}`, `map ${id}`)
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

	async searchMaps(region: string, version: number, searchFor: string): Promise<GameMapSearchCandidate[]> {
		const response = await this.get<unknown>(`${this.apiBaseUrl}/${region}/${version}/map?searchFor=${encodeURIComponent(searchFor)}`, `map search ${searchFor}`)
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
	version: number,
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
	priorityMapIds?: readonly string[]
	previewMapDetailLimit?: number
}

export interface AcquiredWorldMapGraph {
	provider: 'maplestory-io'
	region: string
	version: number
	apiBase: string
	roots: string[]
	nodes: GameWorldMap[]
	maps: GameMapDetail[]
	warnings?: string[]
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
	version: number,
	options: WorldMapGraphAcquisitionOptions,
): Promise<AcquiredWorldMapGraph> {
	const nodes = new Map<string, GameWorldMap>()
	const warnings: string[] = []
	const queue: Array<{ id: string, depth: number, maxDepth: number }> = []
	if (options.mode === 'full') {
		for (const id of await client.listWorldMapIds(region, version))
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
		let node: GameWorldMap
		try {
			node = await client.fetchWorldMap(region, version, current.id)
		}
		catch (error) {
			if (options.mode === 'preview')
				throw error
			const message = error instanceof Error ? error.message : String(error)
			warnings.push(`Skipped native world map ${current.id}: ${message}`)
			continue
		}
		if (node.baseImages.length === 0) {
			warnings.push(`Skipped native world map ${current.id}: no renderable base image`)
			continue
		}
		nodes.set(current.id, node)
		if (current.depth < current.maxDepth) {
			for (const link of node.links) {
				if (!attempted.has(link.linksTo))
					queue.push({ id: link.linksTo, depth: current.depth + 1, maxDepth: current.maxDepth })
			}
		}
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
	for (const mapId of detailIds) {
		try {
			detailedById.set(mapId, await client.fetchMap(region, version, mapId))
		}
		catch (error) {
			if (options.mode === 'preview')
				throw error
			const message = error instanceof Error ? error.message : String(error)
			warnings.push(`GMS map detail ${mapId} unavailable: ${message}`)
		}
	}

	const publishedMapIds = options.mode === 'full' ? allMapIds : detailIds
	const maps = publishedMapIds.map((mapId) => {
		const detail = detailedById.get(mapId)
		if (detail != null)
			return detail
		return bulkById.get(mapId) ?? {
			id: mapId,
			mapMark: null,
			name: null,
			streetName: null,
			backgroundMusic: null,
		}
	})
	return {
		provider: 'maplestory-io',
		region,
		version,
		apiBase: client.apiBase,
		roots: [...new Set(options.requests.map(request => request.rootId))],
		nodes: [...nodes.values()],
		maps,
		warnings,
	}
}

export async function writeVerifiedWzImage(
	image: GameWorldMapImage,
	assetRoot: string,
	file: string,
): Promise<WorldMapAsset> {
	if (!file.startsWith('world-map/') || file.includes('..'))
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
	version: number,
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
