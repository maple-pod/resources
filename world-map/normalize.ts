import type { GameBgmEvidence, WorldMap, WorldMapGraph, WorldMapIndex, WorldMapLandmark } from './schema'
import type { AcquiredWorldMapSource, GameMapDetail, MapleBgmCatalogItem, WikiImageInfo } from './source'
import { buildCatalogIndex, gameBgmCatalogMatch, parseGameBgmPath, uniqueCatalogMatch } from './music'
import { extractBgmKeys, extractMapId, normalizeWikiTitle } from './parse'
import { WORLD_MAP_SCHEMA_VERSION } from './schema'

export interface NormalizeOptions {
	assetPathByFile: ReadonlyMap<string, string>
	catalog: readonly MapleBgmCatalogItem[]
}

export interface NormalizedWorldMapResult {
	world: WorldMap
	warnings: string[]
}

function round(value: number): number {
	return Number(value.toFixed(6))
}

function normalized(value: number, total: number): number {
	return round(value / total)
}

function getImageInfo(source: AcquiredWorldMapSource, file: string): WikiImageInfo {
	const info = source.imageInfoByFile.get(file)
	if (info == null)
		throw new Error(`Missing image metadata for ${file}`)
	return info
}

function getTargetPage(source: AcquiredWorldMapSource, title: string) {
	const page = source.targetPages.get(normalizeWikiTitle(title).toLowerCase())
	if (page == null || page.missing)
		throw new Error(`Missing required target page: ${title}`)
	return page
}

function normalizedLabel(value: string): string {
	return value.normalize('NFKC')
		.trim()
		.toLocaleLowerCase()
		.replace(/\s+/gu, ' ')
}

function labelsMatch(left: string | null, right: string): boolean {
	return left != null && normalizedLabel(left) === normalizedLabel(right)
}

function getGameData(source: AcquiredWorldMapSource) {
	if (source.gameData == null)
		throw new Error(`Missing required game-data snapshot for world "${source.config.id}"`)
	return source.gameData
}

function mapDetailsById(source: AcquiredWorldMapSource): Map<string, GameMapDetail[]> {
	const result = new Map<string, GameMapDetail[]>()
	for (const map of getGameData(source).maps)
		result.set(map.id, [...(result.get(map.id) ?? []), map])
	return result
}

function uniqueMapDetail(details: readonly GameMapDetail[] | undefined): GameMapDetail | null {
	return details?.length === 1 ? details[0]! : null
}

function mapIdWorldMap(source: AcquiredWorldMapSource, mapId: string): string | null {
	const rootId = source.config.gameWorldMapId
	const candidates = getGameData(source).worldMaps.filter(worldMap => worldMap.mapNumbers.includes(mapId))
	const childCandidates = candidates.filter(worldMap => worldMap.id !== rootId)
	return childCandidates.length === 1 ? childCandidates[0]!.id : candidates.length === 1 ? candidates[0]!.id : null
}

function linkedWorldMapId(source: AcquiredWorldMapSource, targetTitle: string): string | null {
	const gameData = getGameData(source)
	const root = gameData.worldMaps.find(worldMap => worldMap.id === source.config.gameWorldMapId)
	if (root == null)
		throw new Error(`Game-data snapshot is missing configured root worldMapId "${source.config.gameWorldMapId}"`)
	const directMatches = root.links.filter(link => labelsMatch(link.toolTip, targetTitle))
	if (directMatches.length === 1)
		return directMatches[0]!.linksTo
	if (directMatches.length > 1)
		return null

	// A few Wiki labels are aliases of a game region. Use only exact game-native
	// mapMark evidence, and only when it identifies one child node. This keeps
	// Elodin resolvable without treating display-text substrings as identity;
	// Ramuramu intentionally remains unresolved because its mapMark is not the
	// full Wiki region label and it has no child link.
	const details = mapDetailsById(source)
	const candidates = new Set<string>()
	for (const worldMap of gameData.worldMaps) {
		if (worldMap.id === root.id)
			continue
		const matches = worldMap.mapNumbers
			.map(mapId => uniqueMapDetail(details.get(mapId)))
			.filter((map): map is GameMapDetail => map != null && map.mapMark != null && labelsMatch(map.mapMark, targetTitle))
		if (matches.length > 0)
			candidates.add(worldMap.id)
	}
	return candidates.size === 1 ? [...candidates][0]! : null
}

function mapMarkForTitle(source: AcquiredWorldMapSource, title: string, worldMapId: string | null): string | null {
	const details = mapDetailsById(source)
	const mapIds = getGameData(source).worldMaps.filter(worldMap => worldMap.id === worldMapId).flatMap(worldMap => worldMap.mapNumbers)
	const maps = mapIds.map(mapId => uniqueMapDetail(details.get(mapId))).filter((map): map is GameMapDetail => map != null)
	const matches = maps.filter(map => [map.name, map.streetName, map.mapMark].some(value => value != null && labelsMatch(value, title)))
	const candidates = worldMapId == null
		? [...details.values()].flat().filter(map => [map.name, map.streetName, map.mapMark].some(value => value != null && labelsMatch(value, title)))
		: matches
	const marks = [...new Set(candidates.map(map => map.mapMark).filter((mark): mark is string => mark != null && mark !== ''))]
	return marks.length === 1 ? marks[0]! : null
}

interface ResolvedTarget {
	mapId: string | null
	name: string | null
	worldMapId: string | null
	mapMark: string | null
	identity: WorldMapLandmark['identity']
	baseId: string
}

function resolveTarget(source: AcquiredWorldMapSource, targetTitle: string, point: AcquiredWorldMapSource['points'][number]): ResolvedTarget {
	const targetPage = getTargetPage(source, targetTitle)
	const targetRevision = targetPage.revisions?.[0]
	if (targetRevision == null)
		throw new Error(`Missing required target revision: ${targetTitle}`)
	const mapId = extractMapId(targetRevision.content)
	if (mapId != null) {
		const worldMapId = mapIdWorldMap(source, mapId)
		const map = uniqueMapDetail(mapDetailsById(source).get(mapId))
		return {
			mapId,
			name: map?.name ?? null,
			worldMapId,
			mapMark: map?.mapMark ?? null,
			identity: 'map',
			baseId: `map:${mapId}`,
		}
	}
	const worldMapId = linkedWorldMapId(source, targetTitle)
	const mapMark = mapMarkForTitle(source, targetTitle, worldMapId)
	if (worldMapId != null) {
		const root = getGameData(source).worldMaps.find(worldMap => worldMap.id === source.config.gameWorldMapId)
		const name = root?.links.find(link => link.linksTo === worldMapId)?.toolTip ?? null
		return { mapId: null, name, worldMapId, mapMark, identity: 'world-map', baseId: `region:world-map:${worldMapId}` }
	}
	return {
		mapId: null,
		name: null,
		worldMapId: null,
		mapMark,
		identity: 'unresolved',
		baseId: `region:unresolved:${point.left}-${point.top}`,
	}
}

function gameBgmForMap(map: GameMapDetail | null): GameBgmEvidence | null {
	const path = map?.backgroundMusic
	if (path == null)
		return null
	const parsed = parseGameBgmPath(path)
	return parsed == null
		? { path, structure: null, filename: null, trackId: null }
		: { ...parsed, trackId: null }
}

function toLandmark(
	source: AcquiredWorldMapSource,
	point: AcquiredWorldMapSource['points'][number],
	baseImage: WikiImageInfo,
	catalogIndex: ReturnType<typeof buildCatalogIndex>,
	resolvedTarget: ResolvedTarget,
	landmarkId: string,
): { landmark: WorldMapLandmark, warnings: string[] } {
	const targetTitle = normalizeWikiTitle(point.target.split('#', 1)[0]!)
	const targetPage = getTargetPage(source, targetTitle)
	const targetRevision = targetPage.revisions?.[0]
	if (targetRevision == null)
		throw new Error(`Missing required target revision: ${targetTitle}`)
	const targetWikitext = targetRevision.content
	const mapId = resolvedTarget.mapId
	const markerInfo = getImageInfo(source, point.markerFile)
	const tracks: string[] = []
	const sourceKeys = extractBgmKeys(targetWikitext)
	const unmappedKeys: string[] = []
	const warnings: string[] = []
	for (const key of sourceKeys) {
		const trackId = uniqueCatalogMatch(catalogIndex.byWikiKey.get(key))
		if (trackId != null) {
			tracks.push(trackId)
		}
		else {
			unmappedKeys.push(key)
			warnings.push((catalogIndex.byWikiKey.get(key)?.length ?? 0) === 0
				? `Unmapped Wiki BGM key "${key}" on ${targetTitle}`
				: `Ambiguous Wiki BGM key "${key}" on ${targetTitle}`)
		}
	}
	const wikiTrackIds = [...new Set(tracks)]
	const map = mapId == null ? null : uniqueMapDetail(mapDetailsById(source).get(mapId))
	const gameBgm = gameBgmForMap(map)
	if (gameBgm != null && gameBgm.structure != null && gameBgm.filename != null) {
		const parsed = parseGameBgmPath(gameBgm.path)
		gameBgm.trackId = parsed == null ? null : gameBgmCatalogMatch(catalogIndex, parsed)
	}
	const selection: WorldMapLandmark['selection'] = { trackId: null, source: null }
	const reconciliation: WorldMapLandmark['bgm']['reconciliation'] = {
		status: 'not-compared',
		wikiTrackIds,
	}
	if (mapId != null) {
		if (gameBgm != null) {
			if (gameBgm.trackId != null) {
				selection.trackId = gameBgm.trackId
				selection.source = 'gms-map-bgm'
				reconciliation.status = wikiTrackIds.length === 1 && wikiTrackIds[0] === gameBgm.trackId && unmappedKeys.length === 0
					? 'agree'
					: wikiTrackIds.some(trackId => trackId !== gameBgm.trackId) ? 'disagree' : 'not-compared'
				if (reconciliation.status === 'disagree')
					warnings.push(`Wiki BGM disagrees with valid GMS backgroundMusic "${gameBgm.path}" on ${targetTitle}`)
			}
			else {
				reconciliation.status = 'gms-unmapped'
				warnings.push(`GMS backgroundMusic "${gameBgm.path}" has no exact unique catalog match on ${targetTitle}; canonical selection remains null`)
			}
		}
	}
	else if (mapId == null && gameBgm == null && wikiTrackIds.length === 1 && unmappedKeys.length === 0) {
		selection.trackId = wikiTrackIds[0]!
		selection.source = 'wiki'
		reconciliation.status = 'wiki-fallback'
	}
	const sourceInfo = {
		pageTitle: targetPage.title,
		revisionId: targetRevision.revid,
		revisionTimestamp: targetRevision.timestamp,
	}
	const landmark: WorldMapLandmark = {
		id: landmarkId,
		label: point.label,
		kind: mapId == null ? 'region' : 'map',
		target: {
			pageTitle: targetTitle,
			mapId,
			name: resolvedTarget.name,
			worldMapId: resolvedTarget.worldMapId,
			mapMark: resolvedTarget.mapMark,
			localizedNames: {},
		},
		identity: resolvedTarget.identity,
		position: {
			left: normalized(point.left, baseImage.width),
			top: normalized(point.top, baseImage.height),
			width: normalized(markerInfo.width, baseImage.width),
			height: normalized(markerInfo.height, baseImage.height),
		},
		tracks: [...new Set(tracks)],
		selection,
		gameBgm,
		bgm: {
			sourceKeys,
			unmappedKeys: [...new Set(unmappedKeys)],
			reconciliation,
		},
		source: sourceInfo,
	}
	return { landmark, warnings }
}

export function normalizeWorldMap(source: AcquiredWorldMapSource, options: NormalizeOptions): NormalizedWorldMapResult {
	const baseImage = getImageInfo(source, source.baseImageFile)
	const asset = options.assetPathByFile.get(source.baseImageFile)
	if (asset == null)
		throw new Error(`Missing local asset path for ${source.baseImageFile}`)
	const catalogIndex = buildCatalogIndex(options.catalog)
	const resolvedTargets = source.points.map((point) => {
		const targetTitle = normalizeWikiTitle(point.target.split('#', 1)[0]!)
		return resolveTarget(source, targetTitle, point)
	})
	const baseIdCounts = new Map<string, number>()
	for (const target of resolvedTargets)
		baseIdCounts.set(target.baseId, (baseIdCounts.get(target.baseId) ?? 0) + 1)
	const warnings: string[] = []
	const landmarks = source.points.map((point, index) => {
		const resolvedTarget = resolvedTargets[index]!
		// A Wiki page can expose multiple visual hotspots for one game map. Keep
		// each hotspot for hit-testing and disambiguate by its source pixel anchor,
		// rather than pretending they are separate logical map IDs or using order.
		const landmarkId = (baseIdCounts.get(resolvedTarget.baseId) ?? 0) > 1
			? `${resolvedTarget.baseId}~${point.left}-${point.top}`
			: resolvedTarget.baseId
		const result = toLandmark(source, point, baseImage, catalogIndex, resolvedTarget, landmarkId)
		warnings.push(...result.warnings)
		return result.landmark
	})
	const world: WorldMap = {
		id: source.config.id,
		title: source.config.title,
		image: {
			file: asset,
			width: baseImage.width,
			height: baseImage.height,
			sha1: baseImage.sha1,
		},
		source: {
			pageTitle: source.config.worldMapWikitextTitle,
			revisionId: source.mapSourceRevision.revid,
			revisionTimestamp: source.mapSourceRevision.timestamp,
		},
		gameData: source.gameData == null
			? null
			: {
					provider: source.gameData.provider,
					region: source.gameData.region,
					version: source.gameData.version,
					apiBase: source.gameData.apiBase,
				},
		landmarks,
	}
	return { world, warnings }
}

export function createWorldMapIndex(worlds: WorldMap[], generatedAt: string, graph?: WorldMapGraph): WorldMapIndex {
	return {
		schemaVersion: WORLD_MAP_SCHEMA_VERSION,
		generatedAt,
		...(graph == null ? {} : { graph }),
		worlds,
	}
}
