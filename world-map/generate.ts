import type { GameDataSource } from './schema'
import type { LocalizationAttempt, MapleBgmCatalogItem, WorldMapLocalizationConfig, WorldMapSourceConfig } from './source'
import { readFile, rm, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { ofetch } from 'ofetch'
import path from 'pathe'
import { assertRunningInContainer } from '../assert-container'
import { acquireGameData, acquireLocalizedGameData, acquireWorldMapGraph, acquireWorldMapSource, BGM_DB_URL, downloadVerifiedImage, MapleStoryIoClient, USER_AGENT, WikiClient, writeVerifiedWzImage } from './acquire'
import { enrichCanonicalMapDetails } from './enrich'
import { localizeWorldMapGraph, normalizeWorldMapGraph } from './graph'
import { localizeWorldMap } from './localize'
import { buildCatalogIndex } from './music'
import { createWorldMapIndex, normalizeWorldMap } from './normalize'
import { extractMapId } from './parse'
import { writeWorldMapRuntime } from './runtime'
import { CANONICAL_GAME_REGION } from './source'
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
	gameVersion?: number
	localizations?: readonly WorldMapLocalizationConfig[]
	localizationMapIds?: readonly string[]
	generatedAt?: string
}

export interface WorldMapGenerationResult {
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
		if (config.version != null && (!Number.isSafeInteger(config.version) || config.version <= 0))
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

export async function runWorldMapGeneration(options: WorldMapGenerationOptions = {}): Promise<WorldMapGenerationResult> {
	const plan = createWorldMapGenerationPlan(options.mode ?? 'preview')
	const sourceConfigs = options.sources ?? WORLD_MAP_SOURCES
	const localizationConfigs = options.localizations ?? WORLD_MAP_LOCALIZATIONS
	validateWorldMapSourceConfigs(sourceConfigs)
	validateWorldMapLocalizationConfigs(localizationConfigs)
	const catalogSource = options.catalogSource ?? BGM_DB_URL
	const targetOutputDir = options.outputDir ?? outputDir
	const targetWorldMapDir = path.join(targetOutputDir, 'world-map')
	const targetImageDir = path.join(targetWorldMapDir, 'images')
	const catalog = await loadCatalog(catalogSource)
	const catalogIndex = buildCatalogIndex(catalog)
	const client = options.client ?? new WikiClient()
	const gameClient = options.gameClient ?? new MapleStoryIoClient()
	const gameVersion = options.gameVersion ?? await gameClient.resolveLatestReadyVersion('GMS')
	const localizationMapIds = options.localizationMapIds ?? (plan.mode === 'preview' ? LOCALIZATION_MAP_SAMPLE_IDS : [])
	const warnings: string[] = []
	if (catalogIndex.duplicateWikiKeys.length > 0)
		warnings.push(`Catalog has duplicate Wiki filename keys; affected keys remain ambiguous: ${catalogIndex.duplicateWikiKeys.join(', ')}`)
	if (catalogIndex.duplicateGamePaths.length > 0)
		warnings.push(`Catalog has duplicate structure/filename paths; affected paths remain ambiguous: ${catalogIndex.duplicateGamePaths.join(', ')}`)
	const worlds = []
	const graphPriorityMapIds = new Set<string>(localizationMapIds)
	const summaries: WorldMapGenerationResult['worldSummaries'] = []

	for (const sourceConfig of sourceConfigs) {
		console.log(`Fetching ${sourceConfig.title} world-map source...`)
		const source = await acquireWorldMapSource(client, sourceConfig)
		const mapIds = [...source.targetPages.values()]
			.map(page => extractMapId(page.revisions?.[0]?.content ?? ''))
			.filter((mapId): mapId is string => mapId != null)
		const gameData = await acquireGameData(gameClient, sourceConfig, gameVersion, mapIds)
		const sourceWithGameData = { ...source, gameData }
		const enrichment = await enrichCanonicalMapDetails(gameClient, sourceWithGameData)
		warnings.push(...enrichment.warnings)
		sourceWithGameData.gameData = enrichment.gameData
		const baseImageInfo = source.imageInfoByFile.get(source.baseImageFile)
		if (baseImageInfo == null)
			throw new Error(`World-map generation failed for ${sourceConfig.id}: missing base image metadata`)
		let localBaseImage: string
		try {
			localBaseImage = await downloadVerifiedImage(source.baseImageFile, baseImageInfo, targetImageDir)
		}
		catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			throw new Error(`World-map generation failed for ${sourceConfig.id}: ${message}`)
		}
		const assetPathByFile = new Map([[source.baseImageFile, `world-map/images/${localBaseImage}`]])
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

	console.log(`Fetching ${plan.mode} GMS native world-map graph...`)
	const acquiredGraph = await acquireWorldMapGraph(gameClient, 'GMS', gameVersion, {
		mode: plan.mode,
		requests: WORLD_MAP_GRAPH_REQUESTS,
		priorityMapIds: [...graphPriorityMapIds],
		previewMapDetailLimit: plan.previewMapDetailLimit ?? undefined,
	})
	warnings.push(...(acquiredGraph.warnings ?? []))
	if (plan.mode === 'full')
		await rm(path.join(targetWorldMapDir, 'gms'), { recursive: true, force: true })
	const baseImages = new Map<string, Awaited<ReturnType<typeof writeVerifiedWzImage>>[]>()
	const linkImages = new Map<string, Array<Awaited<ReturnType<typeof writeVerifiedWzImage>> | null>>()
	for (const node of acquiredGraph.nodes) {
		const nodeBaseImages: Awaited<ReturnType<typeof writeVerifiedWzImage>>[] = []
		for (const [index, image] of node.baseImages.entries())
			nodeBaseImages.push(await writeVerifiedWzImage(image, targetOutputDir, `world-map/gms/${gameVersion}/${node.id}/base-${index}.png`))
		baseImages.set(node.id, nodeBaseImages)
		const nodeLinkImages: Array<Awaited<ReturnType<typeof writeVerifiedWzImage>> | null> = []
		for (const [index, link] of node.links.entries()) {
			nodeLinkImages.push(link.linkImage == null
				? null
				: await writeVerifiedWzImage(link.linkImage, targetOutputDir, `world-map/gms/${gameVersion}/${node.id}/link-${index}.png`))
		}
		linkImages.set(node.id, nodeLinkImages)
	}
	const graph = normalizeWorldMapGraph(acquiredGraph, { baseImages, linkImages }, catalog)
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
	const localizationAttempts = localizationResult.attempts
	const localizedGraph = localizeWorldMapGraph(graph, localizationAttempts)
	const localizedWorlds = worlds.map(world => localizeWorldMap(world, localizationAttempts))
	const index = createWorldMapIndex(localizedWorlds, options.generatedAt ?? new Date().toISOString(), localizedGraph)
	const bgmIds = catalogIndex.trackIds
	await validateWorldMapIndex(index, { assetRoot: targetOutputDir, bgmIds, requireGraph: true })
	const outputFile = path.join(targetWorldMapDir, 'world-maps.json')
	await writeFile(outputFile, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
	const runtime = await writeWorldMapRuntime(index, targetWorldMapDir, { bgmIds })

	for (const summary of summaries)
		console.log(`  ${summary.id}: ${summary.positions} positions, ${summary.positionsWithBgm} with Wiki BGM, ${summary.mappedKeys}/${summary.totalKeys} Wiki BGM keys mapped exactly; numeric GMS BGM ${summary.numericWithGameBgm}/${summary.numericLandmarks} present, ${summary.numericExactGameMatches} catalog matches, Wiki agree/disagree ${summary.wikiAgreements}/${summary.wikiDisagreements}, Wiki fallbacks ${summary.wikiFallbacks}, unresolved numeric ${summary.unresolvedNumericSelections}`)
	console.log(`  localized names: ${localizationAttempts.map(attempt => `${attempt.locale}=${attempt.source.region}/${attempt.source.version ?? 'unavailable'}`).join(', ')}`)
	for (const warning of warnings)
		console.warn(`[WARN] ${warning}`)
	console.log(`  generation mode: ${plan.mode}`)
	console.log(`Output: ${outputFile}`)
	console.log(`Runtime manifest: ${runtime.manifestFile}`)
	return { outputFile, runtimeManifestFile: runtime.manifestFile, warnings, worldSummaries: summaries }
}

export function parseCatalogSource(argv: readonly string[] = process.argv.slice(2)): string {
	const source = argv.find(argument => !argument.startsWith('--'))
	return source ?? BGM_DB_URL
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
	runWorldMapGeneration({ mode: parseGenerationMode(), catalogSource: parseCatalogSource() }).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	})
}
