import type { AcquiredWorldMapGraph, WorldMapGraphAcquisitionOptions, WorldMapGraphFailureKind } from './acquire'
import type { WorldMapRegion } from './snapshot'
import type { GameMapDetail, GameWorldMap, GameWorldMapImage, GameWorldMapSpot } from './source'
import { Buffer } from 'node:buffer'
import { ofetch } from 'ofetch'

export const MAPLEARCHIVE_API = 'https://maplearchive.app/api'
export const MAPLEARCHIVE_REQUEST_DELAY_MS = 500
export const MAPLEARCHIVE_REQUEST_TIMEOUT_MS = 20_000
export const MAPLEARCHIVE_MAX_RETRIES = 2
export const MAPLEARCHIVE_MAP_DETAIL_CONCURRENCY = 6

export type MapleArchiveFailureKind = Exclude<WorldMapGraphFailureKind, 'unrenderable'>

export interface MapleArchiveRelease {
	id: string
	region_slug: string
	version_label: string
	sequence: number
	released_on: string | null
	has_patch_notes: boolean
	has_game_data: boolean
}

interface MapleArchiveSprite {
	token: string
	x: number
	y: number
	width: number
	height: number
}

interface MapleArchiveSpot {
	x: number
	y: number
	kind: number | string | null
	title?: string
	description?: string
	map_ids: number[]
	path?: MapleArchiveSprite
}

interface MapleArchiveLink {
	name: string
	tool_tip?: string | null
	image?: MapleArchiveSprite | null
}

interface MapleArchiveScreen {
	name: string
	parent?: string | null
	width: number
	height: number
	base: MapleArchiveSprite
	spots: MapleArchiveSpot[]
	links: MapleArchiveLink[]
}

interface MapleArchiveWorldMapsResponse {
	screens: MapleArchiveScreen[]
	markers: unknown[]
}

interface MapleArchiveMapRevisionResponse {
	map_id: number
	name?: string | null
	street_name?: string | null
	info?: Array<{ key?: string, value?: string | number | boolean | null }>
}

export interface MapleArchiveClientOptions {
	apiBase?: string
	delayMs?: number
	timeoutMs?: number
	maxRetries?: number
	fetcher?: typeof ofetch
	sleep?: (ms: number) => Promise<void>
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

function isTransientStatus(status: number | null): boolean {
	return status === 429 || (status != null && status >= 500 && status <= 599)
}

function statusOf(error: unknown): number | null {
	if (error == null || typeof error !== 'object')
		return null
	const value = error as { status?: unknown, statusCode?: unknown, response?: { status?: unknown } }
	for (const candidate of [value.status, value.statusCode, value.response?.status]) {
		if (typeof candidate === 'number' && Number.isInteger(candidate))
			return candidate
	}
	return null
}

export class MapleArchiveRequestError extends Error {
	readonly kind: MapleArchiveFailureKind
	readonly status: number | null

	constructor(context: string, original: unknown) {
		const message = original instanceof Error ? original.message : String(original)
		super(`MapleArchive request failed for ${context}: ${message}`)
		this.name = 'MapleArchiveRequestError'
		this.kind = statusOf(original) === 404
			? 'not-found'
			: isTransientError(original) ? 'transient' : 'invalid'
		this.status = statusOf(original)
	}
}

export function mapleArchiveFailureKind(error: unknown): MapleArchiveFailureKind {
	if (error instanceof MapleArchiveRequestError)
		return error.kind
	return statusOf(error) === 404
		? 'not-found'
		: isTransientError(error) ? 'transient' : 'invalid'
}

function isTransientError(error: unknown): boolean {
	if (isTransientStatus(statusOf(error)))
		return true
	if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
		return true
	if (error instanceof TypeError)
		return true
	const code = error != null && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : null
	return typeof code === 'string' && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)
}

function assertRecord(value: unknown, context: string): asserts value is Record<string, unknown> {
	if (value == null || typeof value !== 'object' || Array.isArray(value))
		throw new Error(`MapleArchive returned malformed ${context}`)
}

function assertString(value: unknown, context: string): asserts value is string {
	if (typeof value !== 'string' || value.length === 0)
		throw new Error(`MapleArchive returned malformed ${context}`)
}

function parseRelease(value: unknown): MapleArchiveRelease {
	assertRecord(value, 'release')
	assertString(value.id, 'release id')
	assertString(value.region_slug, 'release region_slug')
	assertString(value.version_label, 'release version_label')
	if (!Number.isSafeInteger(value.sequence) || typeof value.has_game_data !== 'boolean' || typeof value.has_patch_notes !== 'boolean')
		throw new Error('MapleArchive returned malformed release metadata')
	if (value.released_on !== null && typeof value.released_on !== 'string')
		throw new Error('MapleArchive returned malformed release date')
	return value as unknown as MapleArchiveRelease
}

function parseSprite(value: unknown, context: string): MapleArchiveSprite {
	assertRecord(value, context)
	assertString(value.token, `${context}.token`)
	for (const key of ['x', 'y', 'width', 'height']) {
		if (!Number.isFinite(value[key]))
			throw new Error(`MapleArchive returned malformed ${context}.${key}`)
	}
	return value as unknown as MapleArchiveSprite
}

function parseWorldMapsResponse(value: unknown): MapleArchiveWorldMapsResponse {
	assertRecord(value, 'world-maps payload')
	if (!Array.isArray(value.screens) || !Array.isArray(value.markers))
		throw new Error('MapleArchive returned malformed world-maps payload')
	const screens: MapleArchiveScreen[] = value.screens.map((screenValue, index) => {
		assertRecord(screenValue, `world-maps screen ${index}`)
		assertString(screenValue.name, `world-maps screen ${index}.name`)
		if (screenValue.parent !== undefined && screenValue.parent !== null && typeof screenValue.parent !== 'string')
			throw new Error(`MapleArchive returned malformed world-maps screen ${index}.parent`)
		if (!Number.isFinite(screenValue.width) || !Number.isFinite(screenValue.height) || !Array.isArray(screenValue.spots) || !Array.isArray(screenValue.links))
			throw new Error(`MapleArchive returned malformed world-maps screen ${index}`)
		const base = parseSprite(screenValue.base, `world-maps screen ${index}.base`)
		const spots: MapleArchiveSpot[] = screenValue.spots.map((spotValue, spotIndex) => {
			assertRecord(spotValue, `world-maps screen ${index}.spots[${spotIndex}]`)
			if (!Number.isFinite(spotValue.x) || !Number.isFinite(spotValue.y) || !Array.isArray(spotValue.map_ids) || spotValue.map_ids.some(id => !Number.isSafeInteger(id)))
				throw new Error(`MapleArchive returned malformed world-maps screen ${index}.spots[${spotIndex}]`)
			if (spotValue.kind !== null && typeof spotValue.kind !== 'number' && typeof spotValue.kind !== 'string')
				throw new Error(`MapleArchive returned malformed world-maps screen ${index}.spots[${spotIndex}].kind`)
			return spotValue as unknown as MapleArchiveSpot
		})
		const links: MapleArchiveLink[] = screenValue.links.map((linkValue, linkIndex) => {
			assertRecord(linkValue, `world-maps screen ${index}.links[${linkIndex}]`)
			assertString(linkValue.name, `world-maps screen ${index}.links[${linkIndex}].name`)
			if (linkValue.tool_tip !== undefined && linkValue.tool_tip !== null && typeof linkValue.tool_tip !== 'string')
				throw new Error(`MapleArchive returned malformed world-maps screen ${index}.links[${linkIndex}].tool_tip`)
			if (linkValue.image != null)
				parseSprite(linkValue.image, `world-maps screen ${index}.links[${linkIndex}].image`)
			return linkValue as unknown as MapleArchiveLink
		})
		return {
			name: screenValue.name,
			parent: screenValue.parent as string | null | undefined,
			width: Number(screenValue.width),
			height: Number(screenValue.height),
			base,
			spots,
			links,
		}
	})
	return { screens, markers: value.markers }
}

function nativeLanguage(region: WorldMapRegion): string {
	return region === 'TWMS' ? 'zh-TW' : 'en-US'
}

function archiveSlug(region: WorldMapRegion): 'gms' | 'twms' {
	return region === 'TWMS' ? 'twms' : 'gms'
}

export class MapleArchiveClient {
	readonly apiBase: string
	private readonly delayMs: number
	private readonly timeoutMs: number
	private readonly maxRetries: number
	private readonly fetcher: typeof ofetch
	private readonly sleep: (ms: number) => Promise<void>
	private readonly releaseCache = new Map<string, Promise<MapleArchiveRelease[]>>()
	private readonly worldMapsCache = new Map<string, Promise<MapleArchiveWorldMapsResponse>>()
	private readonly mapCache = new Map<string, Promise<GameMapDetail>>()
	private readonly spriteCache = new Map<string, Promise<string>>()

	constructor(options: MapleArchiveClientOptions = {}) {
		this.apiBase = (options.apiBase ?? MAPLEARCHIVE_API).replace(/\/$/u, '')
		this.delayMs = options.delayMs ?? MAPLEARCHIVE_REQUEST_DELAY_MS
		this.timeoutMs = options.timeoutMs ?? MAPLEARCHIVE_REQUEST_TIMEOUT_MS
		this.maxRetries = options.maxRetries ?? MAPLEARCHIVE_MAX_RETRIES
		this.fetcher = options.fetcher ?? ofetch
		this.sleep = options.sleep ?? delay
		if (!Number.isFinite(this.delayMs) || this.delayMs < 0 || !Number.isFinite(this.timeoutMs) || this.timeoutMs < 0 || !Number.isInteger(this.maxRetries) || this.maxRetries < 0)
			throw new Error('Invalid MapleArchive request timing options')
	}

	private async request<T>(path: string, context: string, fetchValue: (url: string) => Promise<T>): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			await this.sleep(this.delayMs)
			try {
				return await fetchValue(`${this.apiBase}${path}`)
			}
			catch (error) {
				if (attempt >= this.maxRetries || !isTransientError(error)) {
					throw new MapleArchiveRequestError(context, error)
				}
				await this.sleep(250 * 2 ** attempt)
			}
		}
	}

	private async getJson<T>(path: string, context: string): Promise<T> {
		return this.request(path, context, url => this.fetcher<T>(url, {
			responseType: 'json',
			timeout: this.timeoutMs === 0 ? undefined : this.timeoutMs,
		}))
	}

	private async getArrayBuffer(path: string, context: string): Promise<ArrayBuffer> {
		return this.request(path, context, url => this.fetcher<unknown, 'arrayBuffer'>(url, {
			responseType: 'arrayBuffer',
			timeout: this.timeoutMs === 0 ? undefined : this.timeoutMs,
		}))
	}

	async listReleases(region: WorldMapRegion): Promise<MapleArchiveRelease[]> {
		const slug = archiveSlug(region)
		const cached = this.releaseCache.get(slug)
		if (cached != null)
			return cached
		const request = this.getJson<unknown[]>(`/regions/${slug}/releases`, `${slug} release list`)
			.then((rows) => {
				if (!Array.isArray(rows))
					throw new Error(`MapleArchive returned malformed ${slug} release list`)
				return rows.map(parseRelease)
			})
		this.releaseCache.set(slug, request)
		return request
	}

	async findRelease(region: WorldMapRegion, version: string): Promise<MapleArchiveRelease | null> {
		const matches = (await this.listReleases(region)).filter(release => release.version_label === version)
		return matches.length === 1 ? matches[0]! : null
	}

	async resolveRelease(region: WorldMapRegion, version: string): Promise<MapleArchiveRelease> {
		const release = await this.findRelease(region, version)
		if (release == null)
			throw new Error(`MapleArchive has no unique ${region}/${version} release`)
		if (!release.has_game_data)
			throw new Error(`MapleArchive ${region}/${version} release has no imported game data`)
		return release
	}

	async fetchWorldMaps(region: WorldMapRegion, releaseId: string): Promise<MapleArchiveWorldMapsResponse> {
		const key = `${releaseId}\u0000${nativeLanguage(region)}`
		const cached = this.worldMapsCache.get(key)
		if (cached != null)
			return cached
		const request = this.getJson<unknown>(`/releases/${encodeURIComponent(releaseId)}/world-maps?lang=${encodeURIComponent(nativeLanguage(region))}`, `${region} world maps`)
			.then(parseWorldMapsResponse)
		this.worldMapsCache.set(key, request)
		return request
	}

	async fetchSpriteBase64(releaseId: string, token: string): Promise<string> {
		const key = `${releaseId}\u0000${token}`
		const cached = this.spriteCache.get(key)
		if (cached != null)
			return cached
		const request = this.getArrayBuffer(`/releases/${encodeURIComponent(releaseId)}/scene-sprites/${encodeURIComponent(token)}`, 'scene sprite')
			.then(value => Buffer.from(value).toString('base64'))
		this.spriteCache.set(key, request)
		return request
	}

	async fetchMap(releaseId: string, mapId: string): Promise<GameMapDetail> {
		const key = `${releaseId}\u0000${mapId}`
		const cached = this.mapCache.get(key)
		if (cached != null)
			return cached
		const request = this.getJson<unknown>(`/maps/${encodeURIComponent(mapId)}/revisions/${encodeURIComponent(releaseId)}`, `map ${mapId}`)
			.then((value) => {
				assertRecord(value, `map ${mapId}`)
				if (!Number.isSafeInteger(value.map_id) || String(value.map_id) !== mapId)
					throw new Error(`MapleArchive returned malformed map ${mapId}`)
				const response = value as unknown as MapleArchiveMapRevisionResponse
				const info = new Map((response.info ?? []).flatMap((entry) => {
					if (typeof entry.key !== 'string')
						return []
					return [[entry.key, entry.value == null ? null : String(entry.value)] as const]
				}))
				return {
					id: mapId,
					name: typeof response.name === 'string' && response.name.length > 0 ? response.name : null,
					streetName: typeof response.street_name === 'string' && response.street_name.length > 0 ? response.street_name : null,
					mapMark: info.get('mapMark') ?? null,
					backgroundMusic: info.get('bgm') ?? null,
				}
			})
		this.mapCache.set(key, request)
		return request
	}
}

function collectScreens(payload: MapleArchiveWorldMapsResponse, options: WorldMapGraphAcquisitionOptions): MapleArchiveScreen[] {
	if (options.mode === 'full')
		return [...payload.screens]
	const byId = new Map(payload.screens.map(screen => [screen.name, screen]))
	const selected = new Map<string, MapleArchiveScreen>()
	const queue = options.requests
		.filter(request => byId.has(request.rootId))
		.map(request => ({ id: request.rootId, depth: 0, maxDepth: request.maxDepth }))
	for (const current of queue) {
		if (selected.has(current.id))
			continue
		const screen = byId.get(current.id)
		if (screen == null)
			continue
		selected.set(current.id, screen)
		if (current.depth >= current.maxDepth)
			continue
		for (const link of screen.links)
			queue.push({ id: link.name, depth: current.depth + 1, maxDepth: current.maxDepth })
	}
	return [...selected.values()]
}

async function imageFromSprite(
	client: MapleArchiveClient,
	releaseId: string,
	sprite: MapleArchiveSprite,
	baseOrigin: { x: number, y: number },
	isBase: boolean,
): Promise<GameWorldMapImage> {
	return {
		image: await client.fetchSpriteBase64(releaseId, sprite.token),
		origin: isBase
			? { x: sprite.x, y: sprite.y }
			: { x: baseOrigin.x - sprite.x, y: baseOrigin.y - sprite.y },
	}
}

function validRepresentativeMapId(mapId: string): boolean {
	return /^\d+$/u.test(mapId) && Number(mapId) > 0
}

export async function acquireMapleArchiveWorldMapGraph(
	client: MapleArchiveClient,
	region: WorldMapRegion,
	version: string,
	options: WorldMapGraphAcquisitionOptions,
): Promise<AcquiredWorldMapGraph> {
	const release = await client.resolveRelease(region, version)
	const payload = await client.fetchWorldMaps(region, release.id)
	const screens = collectScreens(payload, options)
	if (screens.length === 0)
		throw new Error(`MapleArchive ${region}/${version} contains no requested World Map screens`)
	const nodes: GameWorldMap[] = []
	for (const screen of screens) {
		const baseOrigin = { x: screen.base.x, y: screen.base.y }
		const baseImage = await imageFromSprite(client, release.id, screen.base, baseOrigin, true)
		const links = []
		for (const link of screen.links) {
			links.push({
				toolTip: link.tool_tip ?? null,
				linksTo: link.name,
				linkImage: link.image == null ? null : await imageFromSprite(client, release.id, link.image, baseOrigin, false),
			})
		}
		const maps: GameWorldMapSpot[] = screen.spots.map(spot => ({
			spot: { x: spot.x, y: spot.y },
			type: spot.kind,
			mapNumbers: spot.map_ids.map(String),
		}))
		nodes.push({
			id: screen.name,
			worldMapName: screen.name,
			parentWorld: screen.parent ?? null,
			links,
			baseImages: [baseImage],
			maps,
			mapNumbers: maps.flatMap(spot => spot.mapNumbers),
		})
	}

	const representativeMapIds: string[] = []
	const allMapIds: string[] = []
	const seenRepresentative = new Set<string>()
	const seenAll = new Set<string>()
	const addAll = (mapId: string) => {
		if (!validRepresentativeMapId(mapId) || seenAll.has(mapId))
			return
		seenAll.add(mapId)
		allMapIds.push(mapId)
	}
	const addRepresentative = (mapId: string) => {
		addAll(mapId)
		if (!validRepresentativeMapId(mapId) || seenRepresentative.has(mapId))
			return
		seenRepresentative.add(mapId)
		representativeMapIds.push(mapId)
	}
	for (const mapId of options.priorityMapIds ?? [])
		addRepresentative(mapId)
	for (const node of nodes) {
		for (const spot of node.maps) {
			for (const mapId of spot.mapNumbers)
				addAll(mapId)
			if (spot.mapNumbers[0] != null)
				addRepresentative(spot.mapNumbers[0])
		}
	}
	const detailIds = options.mode === 'full'
		? allMapIds
		: representativeMapIds.slice(0, options.previewMapDetailLimit ?? 32)
	const maps: GameMapDetail[] = []
	const mapDetailFailures: Record<string, MapleArchiveFailureKind> = {}
	const warnings = [
		'MapleArchive does not expose authoritative String/WorldMap.img screen titles; node labels may fall back to inbound link tooltips.',
		'MapleArchive /api/maps is a cross-release index; exact snapshot map strings are read only from per-release map revisions.',
	]
	for (let offset = 0; offset < detailIds.length; offset += MAPLEARCHIVE_MAP_DETAIL_CONCURRENCY) {
		const batch = detailIds.slice(offset, offset + MAPLEARCHIVE_MAP_DETAIL_CONCURRENCY)
		const results = await Promise.all(batch.map(async (mapId) => {
			try {
				return { mapId, detail: await client.fetchMap(release.id, mapId), error: null }
			}
			catch (error) {
				return { mapId, detail: null, error }
			}
		}))
		for (const result of results) {
			if (result.detail != null) {
				maps.push(result.detail)
				continue
			}
			if (options.mode === 'preview')
				throw result.error
			const message = result.error instanceof Error ? result.error.message : String(result.error)
			warnings.push(`MapleArchive map detail ${result.mapId} unavailable: ${message}`)
			mapDetailFailures[result.mapId] = mapleArchiveFailureKind(result.error)
		}
	}
	const detailAndNamesComplete = Object.values(mapDetailFailures).every(kind => kind === 'not-found')
	return {
		provider: 'maplearchive',
		region: archiveSlug(region),
		logicalRegion: region,
		version,
		apiBase: client.apiBase,
		releaseId: release.id,
		roots: screens.filter(screen => screen.parent == null).map(screen => screen.name),
		nodes,
		maps,
		worldMapNames: {},
		warnings,
		completeness: {
			complete: detailAndNamesComplete,
			worldMapIndexComplete: true,
			worldMapIndexFailures: {},
			worldMapUnindexedFailures: {},
			worldMapFailures: {},
			mapDetailFailures,
			worldMapNamesFailure: null,
			rawWzInventoryComplete: null,
			rawWzInventoryFailure: null,
			rawWzAbsentWorldMapIds: [],
			rawWzUnindexedWorldMapIds: [],
			rawWzWorldMapAuditFailures: {},
			rawWzWorldMapMismatches: {},
			rawWzMapStringsFailure: null,
			rawWzMapStringFailures: {},
		},
	}
}
