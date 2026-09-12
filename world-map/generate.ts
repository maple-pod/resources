import type { ArchivedWzPublishedProvenance, GameDataSource, WorldMapHitPath, WorldMapIndex } from './schema'
import type { WorldMapSnapshotFingerprint, WorldMapSnapshotId, WorldMapSnapshotRequest } from './snapshot'
import type { LocalizationAttempt, MapleBgmCatalogItem, WorldMapLocalizationConfig, WorldMapSourceConfig } from './source'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { ofetch } from 'ofetch'
import path from 'pathe'
import { assertRunningInContainer } from '../assert-container'
import { acquireGameData, acquireLocalizedGameData, acquireWorldMapGraph, acquireWorldMapSource, BGM_DB_URL, downloadVerifiedImage, MAPLESTORY_IO_API, MapleStoryIoClient, USER_AGENT, WikiClient, writeVerifiedWzImage } from './acquire'
import { acquireArchivedWzWorldMapGraph, archivedMapWzSource, archivedStringWzCacheDirectory, archivedStringWzSource, configuredArchivedWzPublishedProvenance, findCachedArchivedWzMember, readCachedArchivedWzProvenance, verifyArchivedWzPublishedProvenance } from './archived-wz'
import { enrichCanonicalMapDetails } from './enrich'
import { localizeWorldMapGraph, normalizeWorldMapGraph } from './graph'
import { deriveHitPathFromPng } from './hit-path'
import { writeLegacyWorldMapCompatibility } from './legacy'
import { localizeWorldMap } from './localize'
import { acquireMapleArchiveWorldMapGraph, MAPLEARCHIVE_API, MapleArchiveClient } from './maplearchive'
import { buildCatalogIndex } from './music'
import { createWorldMapIndex, normalizeWorldMap } from './normalize'
import { extractMapId } from './parse'
import { validateWorldMapRuntimeOutputAgainstIndex, writeWorldMapRuntime } from './runtime'
import { createWorldMapSnapshotCatalog, DEFAULT_WORLD_MAP_SNAPSHOT, fingerprintWorldMapGraph, mapleStoryIoSourceForSnapshot, parseNumericVersion, parseWorldMapSnapshotId, parseWorldMapSnapshotRequest, worldMapSnapshotId } from './snapshot'
import { CANONICAL_GAME_REGION, gameDataSourceMatches } from './source'
import { validateWorldMapIndex } from './validate'

const workspaceDir = fileURLToPath(new URL('../', import.meta.url))
const outputDir = path.join(workspaceDir, 'output')

export const WORLD_MAP_SOURCES: readonly WorldMapSourceConfig[] = [
	{
		id: 'victoria-island',
		title: 'Victoria Island',
		pageTitle: 'Victoria Island',
		worldMapWikitextTitle: 'Template:WorldMap Victoria Island',
		gameWorldMapId: 'WorldMap010',
		gameRegion: 'GMS',
	},
	{
		id: 'cernium',
		title: 'Cernium',
		pageTitle: 'Cernium',
		worldMapWikitextTitle: 'Cernium',
		gameWorldMapId: 'WorldMap230',
		gameRegion: 'GMS',
	},
]

/** API region/version pairs used for optional display-name enrichment only. */
export const WORLD_MAP_LOCALIZATIONS: readonly WorldMapLocalizationConfig[] = [
	{ locale: 'ko-KR', region: 'KMS' },
	{ locale: 'ja-JP', region: 'JMS' },
	{ locale: 'zh-CN', region: 'CMS' },
	{ locale: 'zh-TW', region: 'TWMS' },
	{ locale: 'en-SG', region: 'SEA' },
]

/** Bounded native topology sample: both native roots, Victoria children, and the Cernium branch. */
export const WORLD_MAP_GRAPH_REQUESTS = [
	{ rootId: 'WorldMap', maxDepth: 2 },
	{ rootId: 'GWorldMap', maxDepth: 2 },
] as const

/** Small, stable live POC sample; the canonical GMS identity set remains complete. */
export const LOCALIZATION_MAP_SAMPLE_IDS = ['100000000', '120000000', '104020100', '410000500']

export type WorldMapGenerationMode = 'preview' | 'full'

export interface WorldMapGenerationPlan {
	mode: WorldMapGenerationMode
	previewMapDetailLimit: number | null
	localizationUsesBulkMapList: boolean
	localizeAllGraphMaps: boolean
	localizeAllLinkBearingWorldMaps: boolean
}

export function createWorldMapGenerationPlan(mode: WorldMapGenerationMode): WorldMapGenerationPlan {
	return mode === 'full'
		? {
				mode,
				previewMapDetailLimit: null,
				localizationUsesBulkMapList: true,
				localizeAllGraphMaps: true,
				localizeAllLinkBearingWorldMaps: true,
			}
		: {
				mode,
				previewMapDetailLimit: 32,
				localizationUsesBulkMapList: false,
				localizeAllGraphMaps: false,
				localizeAllLinkBearingWorldMaps: false,
			}
}

export interface WorldMapGenerationOptions {
	mode?: WorldMapGenerationMode
	catalogSource?: string
	outputDir?: string
	sources?: readonly WorldMapSourceConfig[]
	client?: WikiClient
	gameClient?: MapleStoryIoClient
	mapleArchiveClient?: MapleArchiveClient
	/** @deprecated Prefer snapshot with an explicit logical region + version. */
	gameVersion?: number | string
	snapshot?: WorldMapSnapshotRequest
	localizations?: readonly WorldMapLocalizationConfig[]
	localizationMapIds?: readonly string[]
	/** Maintainer-only raw WZ inventory audit; defaults on for the real client. */
	rawWzAudit?: boolean
	/** Ignored exact-snapshot raw WZ response cache; transient failures are never cached as success. */
	rawAuditCacheDir?: string | null
	/** Ignored exact-snapshot normalized MapleStory.IO JSON response cache; transient failures are never cached as success. */
	normalizedResponseCacheDir?: string | null
	generatedAt?: string
	workspace?: string
	archivedWzPaths?: {
		stringWzFile: string
		mapWzFile: string
		provenance?: ArchivedWzPublishedProvenance
	}
}

export interface WorldMapGenerationResult {
	snapshotId: WorldMapSnapshotId
	outputFile: string
	runtimeManifestFile: string
	warnings: string[]
	worldSummaries: {
		id: string
		positions: number
		positionsWithBgm: number
		mappedKeys: number
		totalKeys: number
		numericLandmarks: number
		numericWithGameBgm: number
		numericExactGameMatches: number
		wikiAgreements: number
		wikiDisagreements: number
		wikiFallbacks: number
		unresolvedNumericSelections: number
	}[]
}

export function validateWorldMapSourceConfigs(configs: readonly WorldMapSourceConfig[]): void {
	const ids = new Set<string>()
	for (const config of configs) {
		if (!config.id || ids.has(config.id))
			throw new Error(`Duplicate or empty world-map source id: ${config.id}`)
		if (config.gameRegion !== CANONICAL_GAME_REGION)
			throw new Error(`World-map source ${config.id} must use canonical ${CANONICAL_GAME_REGION} game data`)
		ids.add(config.id)
	}
}

export function validateWorldMapLocalizationConfigs(configs: readonly WorldMapLocalizationConfig[]): void {
	const locales = new Set<string>()
	for (const config of configs) {
		if (!config.locale || locales.has(config.locale))
			throw new Error(`Duplicate or empty localization locale: ${config.locale}`)
		if (!config.region)
			throw new Error(`Missing localization region for ${config.locale}`)
		if (config.version != null && (typeof config.version !== 'string' || config.version.length === 0))
			throw new Error(`Invalid localization version for ${config.locale}`)
		locales.add(config.locale)
	}
}

export interface LocalizationAcquisitionResult {
	attempts: LocalizationAttempt[]
	warnings: string[]
}

/** Optional locale acquisition is deliberately isolated from canonical GMS acquisition. */
export async function acquireLocalizationAttempts(
	client: MapleStoryIoClient,
	configs: readonly WorldMapLocalizationConfig[],
	mapIds: readonly string[],
	worldMapIds: readonly string[],
	options: { useBulkMapList?: boolean } = {},
): Promise<LocalizationAcquisitionResult> {
	validateWorldMapLocalizationConfigs(configs)
	const attempts: LocalizationAttempt[] = []
	const warnings: string[] = []
	for (const localization of configs) {
		let version = localization.version ?? null
		const baseSource: GameDataSource = {
			provider: 'maplestory-io',
			region: localization.region,
			version,
			apiBase: client.apiBase,
		}
		try {
			version = localization.version ?? await client.resolveLatestReadyVersion(localization.region)
			const snapshot = await acquireLocalizedGameData(client, localization.region, version, localization.locale, mapIds, worldMapIds, { useBulkMapList: options.useBulkMapList })
			attempts.push({ locale: localization.locale, source: snapshot, snapshot })
		}
		catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			attempts.push({
				locale: localization.locale,
				source: { ...baseSource, version },
				snapshot: null,
			})
			warnings.push(`Localization ${localization.locale}/${localization.region} unavailable: ${message}`)
		}
	}
	return { attempts, warnings }
}

async function loadCatalog(source: string): Promise<MapleBgmCatalogItem[]> {
	try {
		const raw = source.startsWith('http://') || source.startsWith('https://')
			? await ofetch<unknown>(source, { responseType: 'json', headers: { 'user-agent': USER_AGENT } })
			: JSON.parse(await readFile(source, 'utf8')) as unknown
		const items = Array.isArray(raw) ? raw : (raw as { bgms?: unknown }).bgms
		if (!Array.isArray(items))
			throw new Error('expected an array or a data.json object with a bgms array')
		return items as MapleBgmCatalogItem[]
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(`Could not load Maple Pod BGM catalog from ${source}: ${message}`)
	}
}

export interface ResolvedWorldMapGenerationSnapshot {
	id: WorldMapSnapshotId
	region: WorldMapSnapshotRequest['region']
	version: string
	provider: 'maplestory-io' | 'maplearchive' | 'archived-wz'
	providerRegion: string
}

async function resolveLatestMapleStoryIoSource(
	client: MapleStoryIoClient,
	region: WorldMapSnapshotRequest['region'],
): Promise<{ version: string, providerRegion: string }> {
	const providerRegions = region === 'GMS' ? ['GMS'] : ['TMS', 'TWMS']
	const candidates: Array<{ version: string, numericVersion: number, providerRegion: string }> = []
	for (const providerRegion of providerRegions) {
		try {
			const version = await client.resolveLatestReadyVersion(providerRegion)
			const numericVersion = parseNumericVersion(version)
			if (numericVersion != null)
				candidates.push({ version, numericVersion, providerRegion })
		}
		catch {
			// A logical region may span multiple provider codes; absence of one code is
			// only terminal when no provider code has a usable numeric snapshot.
		}
	}
	if (candidates.length === 0)
		throw new Error(`MapleStory.IO has no ready numeric ${region} snapshot with images`)
	candidates.sort((left, right) => right.numericVersion - left.numericVersion || left.providerRegion.localeCompare(right.providerRegion))
	return { version: candidates[0]!.version, providerRegion: candidates[0]!.providerRegion }
}

export async function resolveWorldMapGenerationSnapshot(
	client: MapleStoryIoClient,
	request: WorldMapSnapshotRequest,
	mapleArchiveClient?: MapleArchiveClient,
	options: {
		workspace?: string
		archivedWzPaths?: {
			stringWzFile: string
			mapWzFile: string
		}
	} = {},
): Promise<ResolvedWorldMapGenerationSnapshot> {
	if (request.version === 'latest') {
		const latest = await resolveLatestMapleStoryIoSource(client, request.region)
		const source = mapleStoryIoSourceForSnapshot(request.region, latest.version)
		if (source == null || source.regionCode !== latest.providerRegion)
			throw new Error(`MapleStory.IO cannot route resolved snapshot ${request.region}/${latest.version} from ${latest.providerRegion}`)
		return { id: worldMapSnapshotId(request.region, latest.version), region: request.region, version: latest.version, provider: 'maplestory-io', providerRegion: latest.providerRegion }
	}
	const source = mapleStoryIoSourceForSnapshot(request.region, request.version)
	if (source != null && await client.hasReadyVersion(source.regionCode, request.version)) {
		return {
			id: worldMapSnapshotId(request.region, request.version),
			region: request.region,
			version: request.version,
			provider: 'maplestory-io',
			providerRegion: source.regionCode,
		}
	}
	if (mapleArchiveClient != null) {
		const release = await mapleArchiveClient.findRelease(request.region, request.version)
		if (release?.has_game_data === true) {
			return {
				id: worldMapSnapshotId(request.region, request.version),
				region: request.region,
				version: request.version,
				provider: 'maplearchive',
				providerRegion: request.region.toLowerCase(),
			}
		}
	}
	const stringSource = archivedStringWzSource(request.region, request.version)
	const mapSource = archivedMapWzSource(request.region, request.version)
	if (stringSource != null && mapSource != null) {
		const workspace = options.workspace ?? path.resolve(process.cwd())
		const cachedStringWz = options.archivedWzPaths?.stringWzFile ?? (await findCachedArchivedWzMember(workspace, stringSource))
		const cachedMapWz = options.archivedWzPaths?.mapWzFile ?? (await findCachedArchivedWzMember(workspace, mapSource))
		if (cachedStringWz == null) {
			const expectedPath = path.join(archivedStringWzCacheDirectory(workspace, stringSource), stringSource.memberName)
			throw new Error(
				`Archived WZ generation for ${request.region}/${request.version} requires cached String.wz. `
				+ `Missing cached String.wz at ${expectedPath}. `
				+ `Run 'pnpm run world-map:sync -- --snapshot=${request.region}/${request.version} --member=String.wz' to materialize it.`,
			)
		}
		if (cachedMapWz == null) {
			const expectedPath = path.join(archivedStringWzCacheDirectory(workspace, mapSource), mapSource.memberName)
			throw new Error(
				`Archived WZ generation for ${request.region}/${request.version} requires cached Map.wz. `
				+ `Missing cached Map.wz at ${expectedPath}. `
				+ `Run 'pnpm run world-map:sync -- --snapshot=${request.region}/${request.version} --member=Map.wz' to materialize it.`,
			)
		}
		return {
			id: worldMapSnapshotId(request.region, request.version),
			region: request.region,
			version: request.version,
			provider: 'archived-wz',
			providerRegion: request.region,
		}
	}
	throw new Error(
		`Snapshot ${request.region}/${request.version} is not available through the HTTP acquisition adapters or configured archived-WZ sources; `
		+ 'an archived-WZ provider is required',
	)
}

function isSnapshotFingerprint(value: unknown): value is WorldMapSnapshotFingerprint {
	if (value == null || typeof value !== 'object')
		return false
	const candidate = value as Partial<Record<keyof WorldMapSnapshotFingerprint, unknown>>
	return ['topology', 'geometry', 'assets', 'worldMapNames', 'mapDetails', 'combined']
		.every(key => typeof candidate[key as keyof WorldMapSnapshotFingerprint] === 'string' && /^[a-f0-9]{64}$/iu.test(candidate[key as keyof WorldMapSnapshotFingerprint] as string))
}

export function validatePublishedSnapshotSource(id: WorldMapSnapshotId, source: GameDataSource): void {
	const { region, version } = parseWorldMapSnapshotId(id)
	const logicalRegion = source.logicalRegion ?? (source.region === 'GMS' ? 'GMS' : null)
	if (source.version !== version || logicalRegion !== region)
		throw new Error('published provenance does not match the snapshot identity')
	if (source.provider === 'maplestory-io') {
		const configured = mapleStoryIoSourceForSnapshot(region, version)
		if (configured == null || source.region !== configured.regionCode || source.apiBase !== MAPLESTORY_IO_API)
			throw new Error('published MapleStory.IO provenance does not match the configured snapshot identity')
		return
	}
	if (source.provider === 'maplearchive') {
		if (source.region !== region.toLowerCase() || source.apiBase !== MAPLEARCHIVE_API || typeof source.releaseId !== 'string' || source.releaseId.length === 0)
			throw new Error('published MapleArchive provenance does not match the configured snapshot identity')
		return
	}
	const configured = configuredArchivedWzPublishedProvenance(region, version)
	if (configured == null || source.region !== region || source.apiBase !== `https://archive.org/download/${configured.archiveItem}` || source.archivedWz == null)
		throw new Error('published archived-WZ provenance does not match the configured snapshot identity')
	if (!gameDataSourceMatches(source, {
		provider: 'archived-wz',
		region,
		logicalRegion: region,
		version,
		apiBase: source.apiBase,
		archivedWz: configured,
	})) {
		throw new Error('published archived-WZ provenance does not match the configured exact registry identity or hashes')
	}
}

function snapshotReferencedBgmIds(index: WorldMapIndex): Set<string> {
	const ids = new Set<string>()
	const add = (value: string | null | undefined) => {
		if (value != null)
			ids.add(value)
	}
	for (const node of index.graph?.nodes ?? []) {
		for (const spot of node.spots) {
			for (const map of spot.maps) {
				add(map.gameBgm?.trackId)
				add(map.selection.trackId)
			}
		}
	}
	for (const world of index.worlds) {
		for (const landmark of world.landmarks) {
			for (const id of landmark.tracks)
				add(id)
			for (const id of landmark.bgm.reconciliation.wikiTrackIds)
				add(id)
			add(landmark.gameBgm?.trackId)
			add(landmark.selection.trackId)
		}
	}
	return ids
}

interface ExistingSnapshotFingerprintsResult {
	fingerprints: Map<WorldMapSnapshotId, WorldMapSnapshotFingerprint>
	warnings: string[]
}

async function existingSnapshotFingerprints(
	catalogFile: string,
	targetOutputDir: string,
	targetWorldMapDir: string,
	currentSnapshotId: WorldMapSnapshotId,
): Promise<ExistingSnapshotFingerprintsResult> {
	const result: ExistingSnapshotFingerprintsResult = { fingerprints: new Map(), warnings: [] }
	let parsed: { entries?: unknown }
	try {
		parsed = JSON.parse(await readFile(catalogFile, 'utf8')) as { entries?: unknown }
	}
	catch (error) {
		const code = error != null && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : null
		if (code !== 'ENOENT') {
			const message = error instanceof Error ? error.message : String(error)
			result.warnings.push(`Existing snapshot catalog ignored because it could not be read: ${message}`)
		}
		return result
	}
	if (!Array.isArray(parsed.entries)) {
		result.warnings.push('Existing snapshot catalog ignored because entries is not an array')
		return result
	}

	for (const entry of parsed.entries) {
		if (entry == null || typeof entry !== 'object')
			continue
		const value = entry as { id?: unknown, fingerprint?: unknown }
		if (typeof value.id !== 'string' || !isSnapshotFingerprint(value.fingerprint))
			continue
		const expectedFingerprint = value.fingerprint
		let id: WorldMapSnapshotId
		let region: 'GMS' | 'TWMS'
		let version: string
		try {
			({ region, version } = parseWorldMapSnapshotId(value.id))
			id = worldMapSnapshotId(region, version)
		}
		catch {
			continue
		}
		// The current snapshot has just been regenerated and validated below; its
		// previous catalog fingerprint may legitimately differ after an upstream
		// data refresh, so never report that expected replacement as stale.
		if (id === currentSnapshotId)
			continue

		const snapshotDirectory = path.join(targetWorldMapDir, 'snapshots', region, version)
		try {
			const index = JSON.parse(await readFile(path.join(snapshotDirectory, 'world-maps.json'), 'utf8')) as WorldMapIndex
			if (index.graph == null)
				throw new Error('canonical world-maps.json has no graph')
			const actualFingerprint = fingerprintWorldMapGraph(index.graph)
			if (actualFingerprint.combined !== expectedFingerprint.combined
				|| Object.entries(actualFingerprint).some(([key, actual]) => actual !== expectedFingerprint[key as keyof WorldMapSnapshotFingerprint])) {
				throw new Error('canonical graph fingerprint does not match catalog')
			}

			const bgmIds = snapshotReferencedBgmIds(index)
			const manifest = await validateWorldMapRuntimeOutputAgainstIndex(snapshotDirectory, index, { bgmIds })
			validatePublishedSnapshotSource(id, manifest.source)
			const firstSource = index.graph.nodes[0]?.provenance
			if (firstSource == null || !gameDataSourceMatches(firstSource, manifest.source))
				throw new Error('canonical graph provenance does not match the published runtime provenance')
			if (!index.graph.nodes.every(node => gameDataSourceMatches(node.provenance, manifest.source)))
				throw new Error('canonical graph contains inconsistent provider provenance')
			await validateWorldMapIndex(index, {
				assetRoot: targetOutputDir,
				bgmIds,
				requireGraph: true,
				canonicalSourceRegion: firstSource.region,
			})
			result.fingerprints.set(id, actualFingerprint)
		}
		catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			result.warnings.push(`Snapshot ${id} is no longer selectable: ${message}`)
		}
	}
	return result
}

async function pathExists(file: string): Promise<boolean> {
	try {
		await stat(file)
		return true
	}
	catch {
		return false
	}
}

async function withWorldMapPublishLock<T>(outputDir: string, task: () => Promise<T>): Promise<T> {
	const lockDirectory = path.join(outputDir, '.world-map-publish.lock')
	try {
		await mkdir(lockDirectory)
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST')
			throw new Error(`Another world-map publication is already in progress: ${lockDirectory}`)
		throw error
	}
	try {
		await writeFile(path.join(lockDirectory, 'owner.json'), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, 'utf8')
		return await task()
	}
	finally {
		await rm(lockDirectory, { recursive: true, force: true })
	}
}

export async function publishFullSnapshot(
	stagingSnapshotDirectory: string,
	stagingCatalogFile: string,
	stagingImageDirectory: string,
	targetSnapshotDirectory: string,
	targetCatalogFile: string,
	targetImageDirectory: string,
	outputDir: string,
	stagingCompatibilityDirectory: string | null,
	targetWorldMapDirectory: string,
	options: { renamePath?: typeof rename } = {},
): Promise<void> {
	await mkdir(path.dirname(targetSnapshotDirectory), { recursive: true })
	const backupDirectory = await mkdtemp(path.join(outputDir, '.world-map-publish-'))
	const move = options.renamePath ?? rename
	const replacements = [
		{ staged: stagingSnapshotDirectory, target: targetSnapshotDirectory, backup: path.join(backupDirectory, 'snapshot') },
		...(await pathExists(stagingImageDirectory)
			? [{ staged: stagingImageDirectory, target: targetImageDirectory, backup: path.join(backupDirectory, 'images') }]
			: []),
		...(stagingCompatibilityDirectory == null
			? []
			: [
					{ staged: path.join(stagingCompatibilityDirectory, 'world-maps.json'), target: path.join(targetWorldMapDirectory, 'world-maps.json'), backup: path.join(backupDirectory, 'compatibility-world-maps.json') },
					{ staged: path.join(stagingCompatibilityDirectory, 'manifest.json'), target: path.join(targetWorldMapDirectory, 'manifest.json'), backup: path.join(backupDirectory, 'compatibility-manifest.json') },
					{ staged: path.join(stagingCompatibilityDirectory, 'nodes'), target: path.join(targetWorldMapDirectory, 'nodes'), backup: path.join(backupDirectory, 'compatibility-nodes') },
				]
		),
		{ staged: stagingCatalogFile, target: targetCatalogFile, backup: path.join(backupDirectory, 'catalog.json') },
	]
	const states = await Promise.all(replacements.map(async replacement => ({ ...replacement, hadTarget: await pathExists(replacement.target), moved: false })))
	let published = false
	let rollbackCompleted = true
	try {
		for (const state of states) {
			if (state.hadTarget)
				await move(state.target, state.backup)
			await move(state.staged, state.target)
			state.moved = true
		}
		published = true
	}
	catch (error) {
		const rollbackErrors: unknown[] = []
		for (const state of [...states].reverse()) {
			try {
				if (state.moved)
					await rm(state.target, { recursive: true, force: true })
				if (state.hadTarget && await pathExists(state.backup))
					await move(state.backup, state.target)
			}
			catch (rollbackError) {
				rollbackCompleted = false
				rollbackErrors.push(rollbackError)
			}
		}
		if (rollbackErrors.length > 0) {
			throw new AggregateError(
				[error, ...rollbackErrors],
				`World-map publication failed and rollback was incomplete; preserved recovery backup at ${backupDirectory}`,
			)
		}
		throw error
	}
	finally {
		if (published || rollbackCompleted)
			await rm(backupDirectory, { recursive: true, force: true })
	}
}

export async function runWorldMapGeneration(options: WorldMapGenerationOptions = {}): Promise<WorldMapGenerationResult> {
	const plan = createWorldMapGenerationPlan(options.mode ?? 'preview')
	if (options.snapshot != null && options.gameVersion != null)
		throw new Error('Use either snapshot or deprecated gameVersion, not both')
	const requestedSnapshot = options.snapshot
		?? (options.gameVersion == null ? parseWorldMapSnapshotId(DEFAULT_WORLD_MAP_SNAPSHOT) : { region: 'GMS' as const, version: String(options.gameVersion) })
	const catalogSource = options.catalogSource ?? BGM_DB_URL
	const targetOutputDir = options.outputDir ?? outputDir
	// Preview output is deliberately isolated from deployable resources so a bounded
	// run can never replace a previously generated full snapshot.
	const resourceRoot = plan.mode === 'full' ? 'world-map' : 'world-map-preview'
	const targetWorldMapDir = path.join(targetOutputDir, resourceRoot)
	const catalog = await loadCatalog(catalogSource)
	const catalogIndex = buildCatalogIndex(catalog)
	const client = options.client ?? new WikiClient()
	const gameClient = options.gameClient ?? new MapleStoryIoClient({
		rawAuditCacheDir: options.rawAuditCacheDir ?? path.join(options.workspace ?? process.cwd(), '.cache/world-map/maplestory-io-raw-audit'),
		normalizedResponseCacheDir: options.normalizedResponseCacheDir ?? path.join(options.workspace ?? process.cwd(), '.cache/world-map/maplestory-io-normalized'),
	})
	const mapleArchiveClient = options.mapleArchiveClient ?? new MapleArchiveClient()
	const snapshot = await resolveWorldMapGenerationSnapshot(gameClient, requestedSnapshot, mapleArchiveClient, {
		workspace: options.workspace,
		archivedWzPaths: options.archivedWzPaths,
	})
	const stagingOutputDir = plan.mode === 'full'
		? await (async () => {
				await mkdir(targetOutputDir, { recursive: true })
				return mkdtemp(path.join(targetOutputDir, '.world-map-generation-'))
			})()
		: null
	const generationOutputDir = stagingOutputDir ?? targetOutputDir
	const generationWorldMapDir = path.join(generationOutputDir, resourceRoot)
	const generationImageDir = path.join(generationWorldMapDir, 'images')
	try {
		const useLegacyGmsEnrichmentByDefault = snapshot.id === DEFAULT_WORLD_MAP_SNAPSHOT
		const sourceConfigs = snapshot.region === 'GMS'
			? (options.sources ?? (useLegacyGmsEnrichmentByDefault ? WORLD_MAP_SOURCES : []))
			: []
		const localizationConfigs = snapshot.region === 'GMS'
			? (options.localizations ?? (useLegacyGmsEnrichmentByDefault ? WORLD_MAP_LOCALIZATIONS : []))
			: []
		validateWorldMapSourceConfigs(sourceConfigs)
		validateWorldMapLocalizationConfigs(localizationConfigs)
		const localizationMapIds = snapshot.region === 'GMS'
			? options.localizationMapIds ?? (plan.mode === 'preview' && localizationConfigs.length > 0 ? LOCALIZATION_MAP_SAMPLE_IDS : [])
			: []
		const warnings: string[] = []
		if (catalogIndex.duplicateWikiKeys.length > 0)
			warnings.push(`Catalog has duplicate Wiki filename keys; affected keys remain ambiguous: ${catalogIndex.duplicateWikiKeys.join(', ')}`)
		if (catalogIndex.duplicateGamePaths.length > 0)
			warnings.push(`Catalog has duplicate structure/filename paths; affected paths remain ambiguous: ${catalogIndex.duplicateGamePaths.join(', ')}`)
		const worlds = []
		const graphPriorityMapIds = new Set<string>(localizationMapIds)
		const summaries: WorldMapGenerationResult['worldSummaries'] = []

		// The legacy Wiki-correlated worlds[] contract is GMS-specific. Versioned TWMS
		// snapshots intentionally publish the native graph only instead of mixing regions.
		for (const sourceConfig of sourceConfigs) {
			console.log(`Fetching ${sourceConfig.title} world-map source...`)
			const source = await acquireWorldMapSource(client, sourceConfig)
			const mapIds = [...source.targetPages.values()]
				.map(page => extractMapId(page.revisions?.[0]?.content ?? ''))
				.filter((mapId): mapId is string => mapId != null)
			const gameData = await acquireGameData(gameClient, sourceConfig, snapshot.version, mapIds)
			const sourceWithGameData = { ...source, gameData }
			const enrichment = await enrichCanonicalMapDetails(gameClient, sourceWithGameData)
			warnings.push(...enrichment.warnings)
			sourceWithGameData.gameData = enrichment.gameData
			const baseImageInfo = source.imageInfoByFile.get(source.baseImageFile)
			if (baseImageInfo == null)
				throw new Error(`World-map generation failed for ${sourceConfig.id}: missing base image metadata`)
			let localBaseImage: string
			try {
				localBaseImage = await downloadVerifiedImage(source.baseImageFile, baseImageInfo, generationImageDir)
			}
			catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				throw new Error(`World-map generation failed for ${sourceConfig.id}: ${message}`)
			}
			const assetPathByFile = new Map([[source.baseImageFile, `${resourceRoot}/images/${localBaseImage}`]])
			const normalized = normalizeWorldMap(sourceWithGameData, { assetPathByFile, catalog })
			warnings.push(...normalized.warnings.map(message => `${sourceConfig.id}: ${message}`))
			worlds.push(normalized.world)
			for (const landmark of normalized.world.landmarks) {
				if (landmark.target.mapId != null)
					graphPriorityMapIds.add(landmark.target.mapId)
			}
			const totalKeys = normalized.world.landmarks.reduce((sum, landmark) => sum + landmark.bgm.sourceKeys.length, 0)
			const unmappedKeys = normalized.world.landmarks.reduce((sum, landmark) => sum + landmark.bgm.unmappedKeys.length, 0)
			const numericLandmarks = normalized.world.landmarks.filter(landmark => landmark.target.mapId != null)
			summaries.push({
				id: sourceConfig.id,
				positions: normalized.world.landmarks.length,
				positionsWithBgm: normalized.world.landmarks.filter(landmark => landmark.bgm.sourceKeys.length > 0).length,
				mappedKeys: totalKeys - unmappedKeys,
				totalKeys,
				numericLandmarks: numericLandmarks.length,
				numericWithGameBgm: numericLandmarks.filter(landmark => landmark.gameBgm != null).length,
				numericExactGameMatches: numericLandmarks.filter(landmark => landmark.gameBgm?.trackId != null).length,
				wikiAgreements: numericLandmarks.filter(landmark => landmark.bgm.reconciliation.status === 'agree').length,
				wikiDisagreements: numericLandmarks.filter(landmark => landmark.bgm.reconciliation.status === 'disagree').length,
				wikiFallbacks: normalized.world.landmarks.filter(landmark => landmark.selection.source === 'wiki').length,
				unresolvedNumericSelections: numericLandmarks.filter(landmark => landmark.selection.trackId == null).length,
			})
		}

		console.log(`Fetching ${plan.mode} ${snapshot.id} native world-map graph...`)
		let graphRequests: readonly { rootId: string, maxDepth: number }[] = WORLD_MAP_GRAPH_REQUESTS
		if (plan.mode === 'preview' && snapshot.provider === 'maplestory-io') {
			const availableWorldMapIds = new Set(await gameClient.listWorldMapIds(snapshot.providerRegion, snapshot.version))
			graphRequests = WORLD_MAP_GRAPH_REQUESTS.filter(request => availableWorldMapIds.has(request.rootId))
			if (graphRequests.length === 0)
				throw new Error(`Snapshot ${snapshot.id} contains none of the configured preview World Map roots`)
		}
		const graphAcquisitionOptions = {
			mode: plan.mode,
			requests: graphRequests,
			logicalRegion: snapshot.region,
			priorityMapIds: [...graphPriorityMapIds],
			previewMapDetailLimit: plan.previewMapDetailLimit ?? undefined,
			rawWzAudit: options.rawWzAudit ?? options.gameClient == null,
		} as const
		let acquiredGraph
		if (snapshot.provider === 'maplestory-io') {
			acquiredGraph = await acquireWorldMapGraph(gameClient, snapshot.providerRegion, snapshot.version, graphAcquisitionOptions)
		}
		else if (snapshot.provider === 'maplearchive') {
			acquiredGraph = await acquireMapleArchiveWorldMapGraph(mapleArchiveClient, snapshot.region, snapshot.version, graphAcquisitionOptions)
		}
		else {
			const stringSource = archivedStringWzSource(snapshot.region, snapshot.version)
			const mapSource = archivedMapWzSource(snapshot.region, snapshot.version)
			if (stringSource == null || mapSource == null)
				throw new Error(`No archived WZ sources are configured for ${snapshot.id}`)
			const archivedWzPaths = options.archivedWzPaths ?? {
				stringWzFile: (await findCachedArchivedWzMember(options.workspace ?? process.cwd(), stringSource))!,
				mapWzFile: (await findCachedArchivedWzMember(options.workspace ?? process.cwd(), mapSource))!,
				archiveItem: mapSource.archiveItem,
				provenance: await readCachedArchivedWzProvenance(options.workspace ?? process.cwd(), stringSource, mapSource),
			}
			if (plan.mode === 'full') {
				const configuredProvenance = configuredArchivedWzPublishedProvenance(snapshot.region, snapshot.version)
				if (configuredProvenance == null || archivedWzPaths.provenance == null)
					throw new Error(`Full archived-WZ generation for ${snapshot.id} requires provenance matching the configured exact registry`)
				await verifyArchivedWzPublishedProvenance(archivedWzPaths, archivedWzPaths.provenance, configuredProvenance)
			}
			acquiredGraph = await acquireArchivedWzWorldMapGraph({
				...archivedWzPaths,
				archiveItem: archivedWzPaths.provenance?.archiveItem ?? mapSource.archiveItem,
			}, snapshot.region, snapshot.version, graphAcquisitionOptions)
		}
		if (plan.mode === 'full' && (snapshot.provider === 'maplestory-io' || snapshot.provider === 'maplearchive')) {
			if (acquiredGraph.completeness == null || !acquiredGraph.completeness.complete) {
				const completeness = acquiredGraph.completeness ?? {
					complete: false,
					worldMapIndexComplete: false,
					worldMapIndexFailures: {},
					worldMapUnindexedFailures: {},
					worldMapFailures: {},
					mapDetailFailures: {},
					worldMapNamesFailure: null,
					rawWzInventoryComplete: null,
					rawWzInventoryFailure: null,
					rawWzAbsentWorldMapIds: [],
					rawWzUnindexedWorldMapIds: [],
					rawWzWorldMapAuditFailures: {},
					rawWzWorldMapMismatches: {},
					rawWzMapStringsFailure: null,
					rawWzMapStringFailures: {},
				}
				throw new Error(`Full ${snapshot.provider} generation for ${snapshot.id} is incomplete; snapshot was not marked selectable: ${JSON.stringify(completeness)}`)
			}
		}
		if (plan.mode === 'full' && snapshot.provider === 'archived-wz' && acquiredGraph.archivedWz == null)
			throw new Error(`Full archived-WZ generation for ${snapshot.id} requires explicit published archive/member provenance`)
		warnings.push(...(acquiredGraph.warnings ?? []))
		const snapshotDirectory = path.join(generationWorldMapDir, 'snapshots', snapshot.region, snapshot.version)
		const nativeAssetPathPrefix = `${resourceRoot}/snapshots/${snapshot.region}/${snapshot.version}/assets`
		const baseImages = new Map<string, Awaited<ReturnType<typeof writeVerifiedWzImage>>[]>()
		const linkImages = new Map<string, Array<Awaited<ReturnType<typeof writeVerifiedWzImage>> | null>>()
		const linkHitPaths = new Map<string, Array<WorldMapHitPath | null>>()
		for (const node of acquiredGraph.nodes) {
			const nodeBaseImages: Awaited<ReturnType<typeof writeVerifiedWzImage>>[] = []
			for (const [index, image] of node.baseImages.entries())
				nodeBaseImages.push(await writeVerifiedWzImage(image, generationOutputDir, `${nativeAssetPathPrefix}/${node.id}/base-${index}.png`))
			baseImages.set(node.id, nodeBaseImages)
			const firstBase = nodeBaseImages[0]
			const nodeLinkImages: Array<Awaited<ReturnType<typeof writeVerifiedWzImage>> | null> = []
			const nodeLinkHitPaths: Array<WorldMapHitPath | null> = []
			for (const [index, link] of node.links.entries()) {
				if (link.linkImage == null) {
					nodeLinkImages.push(null)
					nodeLinkHitPaths.push(null)
				}
				else {
					const publishedLinkImage = await writeVerifiedWzImage(link.linkImage, generationOutputDir, `${nativeAssetPathPrefix}/${node.id}/link-${index}.png`)
					nodeLinkImages.push(publishedLinkImage)
					const screenOrigin = {
						x: (firstBase?.origin.x ?? 0) - link.linkImage.origin.x,
						y: (firstBase?.origin.y ?? 0) - link.linkImage.origin.y,
					}
					const publishedFile = path.join(generationOutputDir, publishedLinkImage.file)
					const publishedBytes = await readFile(publishedFile)
					const hitPath = await deriveHitPathFromPng(publishedBytes, screenOrigin)
					nodeLinkHitPaths.push(hitPath)
				}
			}
			linkImages.set(node.id, nodeLinkImages)
			linkHitPaths.set(node.id, nodeLinkHitPaths)
		}
		const graph = normalizeWorldMapGraph(acquiredGraph, { baseImages, linkImages, linkHitPaths }, catalog)
		if (plan.mode === 'full') {
			const publishedSource = graph.nodes[0]?.provenance
			if (publishedSource == null)
				throw new Error(`Full generation for ${snapshot.id} produced no canonical provider provenance`)
			validatePublishedSnapshotSource(snapshot.id, publishedSource)
		}
		let localizationAttempts: LocalizationAttempt[] = []
		if (snapshot.region === 'GMS') {
			const localizationWorldMapIds = plan.localizeAllLinkBearingWorldMaps
				? graph.nodes.filter(node => node.links.length > 0).map(node => node.worldMapId)
				: [...new Set([
						...sourceConfigs.map(source => source.gameWorldMapId),
						'WorldMap',
						'GWorldMap',
						'WGWorldMap',
					])].filter(worldMapId => graph.nodes.some(node => node.worldMapId === worldMapId))
			const graphMapIds = plan.localizeAllGraphMaps
				? [...new Set(graph.nodes.flatMap(node => node.spots.flatMap(spot => spot.mapNumbers)))]
				: [...graphPriorityMapIds].slice(0, 32)
			const localizationResult = await acquireLocalizationAttempts(
				gameClient,
				localizationConfigs,
				graphMapIds,
				localizationWorldMapIds,
				{ useBulkMapList: plan.localizationUsesBulkMapList },
			)
			warnings.push(...localizationResult.warnings)
			localizationAttempts = localizationResult.attempts
		}
		const localizedGraph = snapshot.region === 'GMS' ? localizeWorldMapGraph(graph, localizationAttempts) : graph
		const localizedWorlds = worlds.map(world => localizeWorldMap(world, localizationAttempts))
		const generatedAt = options.generatedAt ?? new Date().toISOString()
		const index = createWorldMapIndex(localizedWorlds, generatedAt, localizedGraph)
		const bgmIds = catalogIndex.trackIds
		await validateWorldMapIndex(index, { assetRoot: generationOutputDir, bgmIds, requireGraph: true, canonicalSourceRegion: acquiredGraph.region })
		await mkdir(snapshotDirectory, { recursive: true })
		const outputFile = path.join(snapshotDirectory, 'world-maps.json')
		await writeFile(outputFile, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
		const runtime = await writeWorldMapRuntime(index, snapshotDirectory, { bgmIds, resourceRoot, nativeAssetPathPrefix })
		if (plan.mode === 'full' && snapshot.id === DEFAULT_WORLD_MAP_SNAPSHOT)
			await writeLegacyWorldMapCompatibility(index, generationWorldMapDir, { bgmIds, resourceRoot, nativeAssetPathPrefix })

		const catalogFile = path.join(targetWorldMapDir, 'catalog.json')
		await mkdir(generationWorldMapDir, { recursive: true })
		const stagedCatalogFile = path.join(generationWorldMapDir, 'catalog.json')
		if (plan.mode === 'full') {
			await withWorldMapPublishLock(targetOutputDir, async () => {
				// Re-read and validate carry-forward state only after holding the publish lock.
				// Otherwise two full generations finishing together can each publish a
				// catalog computed from the same stale predecessor and lose one snapshot.
				const existing = await existingSnapshotFingerprints(
					catalogFile,
					targetOutputDir,
					targetWorldMapDir,
					snapshot.id,
				)
				warnings.push(...existing.warnings)
				existing.fingerprints.set(snapshot.id, fingerprintWorldMapGraph(localizedGraph))
				const snapshotCatalog = createWorldMapSnapshotCatalog(generatedAt, existing.fingerprints)
				await writeFile(stagedCatalogFile, `${JSON.stringify(snapshotCatalog, null, 2)}\n`, 'utf8')
				await publishFullSnapshot(
					snapshotDirectory,
					stagedCatalogFile,
					generationImageDir,
					path.join(targetWorldMapDir, 'snapshots', snapshot.region, snapshot.version),
					catalogFile,
					path.join(targetWorldMapDir, 'images'),
					targetOutputDir,
					snapshot.id === DEFAULT_WORLD_MAP_SNAPSHOT ? generationWorldMapDir : null,
					targetWorldMapDir,
				)
			})
		}
		else {
			const snapshotCatalog = createWorldMapSnapshotCatalog(generatedAt)
			await writeFile(stagedCatalogFile, `${JSON.stringify(snapshotCatalog, null, 2)}\n`, 'utf8')
		}

		for (const summary of summaries)
			console.log(`  ${summary.id}: ${summary.positions} positions, ${summary.positionsWithBgm} with Wiki BGM, ${summary.mappedKeys}/${summary.totalKeys} Wiki BGM keys mapped exactly; numeric GMS BGM ${summary.numericWithGameBgm}/${summary.numericLandmarks} present, ${summary.numericExactGameMatches} catalog matches, Wiki agree/disagree ${summary.wikiAgreements}/${summary.wikiDisagreements}, Wiki fallbacks ${summary.wikiFallbacks}, unresolved numeric ${summary.unresolvedNumericSelections}`)
		if (localizationAttempts.length > 0)
			console.log(`  localized names: ${localizationAttempts.map(attempt => `${attempt.locale}=${attempt.source.region}/${attempt.source.version ?? 'unavailable'}`).join(', ')}`)
		for (const warning of warnings)
			console.warn(`[WARN] ${warning}`)
		console.log(`  generation mode: ${plan.mode}`)
		console.log(`  snapshot: ${snapshot.id} via ${snapshot.provider} ${acquiredGraph.region}/${snapshot.version}`)
		const publishedOutputFile = plan.mode === 'full'
			? path.join(targetWorldMapDir, 'snapshots', snapshot.region, snapshot.version, 'world-maps.json')
			: outputFile
		const publishedRuntimeManifestFile = plan.mode === 'full'
			? path.join(targetWorldMapDir, 'snapshots', snapshot.region, snapshot.version, 'manifest.json')
			: runtime.manifestFile
		console.log(`Output: ${publishedOutputFile}`)
		console.log(`Runtime manifest: ${publishedRuntimeManifestFile}`)
		console.log(`Snapshot catalog: ${catalogFile}`)
		return { snapshotId: snapshot.id, outputFile: publishedOutputFile, runtimeManifestFile: publishedRuntimeManifestFile, warnings, worldSummaries: summaries }
	}
	finally {
		if (stagingOutputDir != null)
			await rm(stagingOutputDir, { recursive: true, force: true })
	}
}

export function parseCatalogSource(argv: readonly string[] = process.argv.slice(2)): string {
	const source = argv.find(argument => !argument.startsWith('--'))
	return source ?? BGM_DB_URL
}

export function parseGenerationSnapshot(argv: readonly string[] = process.argv.slice(2)): WorldMapSnapshotRequest {
	const argument = argv.find(value => value.startsWith('--snapshot='))
	return argument == null
		? parseWorldMapSnapshotId(DEFAULT_WORLD_MAP_SNAPSHOT)
		: parseWorldMapSnapshotRequest(argument.slice('--snapshot='.length))
}

export function parseGenerationMode(argv: readonly string[] = process.argv.slice(2)): WorldMapGenerationMode {
	const argument = argv.find(value => value.startsWith('--mode='))
	const mode = argument?.slice('--mode='.length) ?? 'preview'
	if (mode !== 'preview' && mode !== 'full')
		throw new Error(`Invalid world-map generation mode: ${mode}`)
	return mode
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	assertRunningInContainer('pnpm run world-map:generate')
	runWorldMapGeneration({ mode: parseGenerationMode(), snapshot: parseGenerationSnapshot(), catalogSource: parseCatalogSource() }).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	})
}
