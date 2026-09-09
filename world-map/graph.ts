import type { AcquiredWorldMapGraph } from './acquire'
import type { LocalizedName, WorldMapAsset, WorldMapGraph, WorldMapGraphLink, WorldMapGraphMap, WorldMapGraphSpot } from './schema'
import type { GameMapDetail, LocalizationAttempt, LocalizedGameDataSnapshot, MapleBgmCatalogItem } from './source'
import { buildCatalogIndex, gameBgmCatalogMatch, parseGameBgmPath } from './music'

function round(value: number): number {
	return Number(value.toFixed(6))
}

function normalized(value: number, total: number): number {
	return round(value / total)
}

function sourceOf(snapshot: LocalizedGameDataSnapshot) {
	return {
		provider: snapshot.provider,
		region: snapshot.region,
		version: snapshot.version,
		apiBase: snapshot.apiBase,
	} as const
}

function unavailableName(attempt: LocalizationAttempt): LocalizedName {
	return { name: null, source: attempt.source, status: 'unavailable', join: null }
}

function attemptsOf(attempts: readonly LocalizationAttempt[] | readonly LocalizedGameDataSnapshot[]): LocalizationAttempt[] {
	return attempts.map(attempt => 'snapshot' in attempt
		? attempt
		: { locale: attempt.locale, source: sourceOf(attempt), snapshot: attempt })
}

function localizedName(attempt: LocalizationAttempt, name: string | null, join: 'mapId' | 'worldMapId'): LocalizedName {
	if (attempt.snapshot == null)
		return unavailableName(attempt)
	const usable = name != null && name.trim() !== ''
	return {
		name: usable ? name : null,
		source: sourceOf(attempt.snapshot),
		status: 'available',
		join: usable ? join : null,
	}
}

function uniqueMap(snapshot: LocalizedGameDataSnapshot, mapId: string): GameMapDetail | null {
	const matches = snapshot.maps.filter(map => map.id === mapId)
	return matches.length === 1 ? matches[0]! : null
}

function localizedLinkName(snapshot: LocalizedGameDataSnapshot, worldMapId: string, sourceLink: { toolTip: string | null, linksTo: string }, index: number, sourceLinks: Array<{ toolTip: string | null, linksTo: string }>): string | null {
	const localizedWorldMap = snapshot.worldMaps.find(worldMap => worldMap.id === worldMapId)
	if (localizedWorldMap == null)
		return null
	const sameIndex = localizedWorldMap.links[index]
	if (sameIndex?.linksTo === sourceLink.linksTo)
		return sameIndex.toolTip
	const occurrence = sourceLinks.slice(0, index + 1).filter(link => link.linksTo === sourceLink.linksTo).length - 1
	const matches = localizedWorldMap.links.filter(link => link.linksTo === sourceLink.linksTo)
	return matches.length > occurrence ? matches[occurrence]!.toolTip : null
}

function linkAssetRect(asset: WorldMapAsset | null, screenOrigin: { x: number, y: number }, base: WorldMapAsset | undefined) {
	if (asset == null || base == null)
		return null
	return {
		left: normalized(screenOrigin.x, base.width),
		top: normalized(screenOrigin.y, base.height),
		width: normalized(asset.width, base.width),
		height: normalized(asset.height, base.height),
	}
}

function mapMusic(map: GameMapDetail | null, catalog: ReturnType<typeof buildCatalogIndex>) {
	if (map?.backgroundMusic == null)
		return { gameBgm: null, selection: { trackId: null, source: null } as const }
	const parsed = parseGameBgmPath(map.backgroundMusic)
	const gameBgm = parsed == null
		? { path: map.backgroundMusic, structure: null, filename: null, trackId: null }
		: { ...parsed, trackId: gameBgmCatalogMatch(catalog, parsed) }
	return {
		gameBgm,
		selection: { trackId: gameBgm.trackId, source: gameBgm.trackId == null ? null : ('gms-map-bgm' as const) },
	}
}

function graphMap(mapId: string, detail: GameMapDetail | null, catalog: ReturnType<typeof buildCatalogIndex>): WorldMapGraphMap {
	const music = mapMusic(detail, catalog)
	return {
		mapId,
		name: detail?.name ?? null,
		streetName: detail?.streetName ?? null,
		mapMark: detail?.mapMark ?? null,
		localizedNames: {},
		gameBgm: music.gameBgm,
		selection: music.selection,
	}
}

export interface GraphAssets {
	baseImages: ReadonlyMap<string, WorldMapAsset[]>
	linkImages: ReadonlyMap<string, ReadonlyArray<WorldMapAsset | null>>
}

export function normalizeWorldMapGraph(
	acquired: AcquiredWorldMapGraph,
	assets: GraphAssets,
	catalogItems: readonly MapleBgmCatalogItem[],
): WorldMapGraph {
	const catalog = buildCatalogIndex(catalogItems)
	const detailById = new Map(acquired.maps.map(map => [map.id, map]))
	const canonicalLabels = new Map<string, string | null>()
	for (const node of acquired.nodes) {
		for (const link of node.links) {
			if (!canonicalLabels.has(link.linksTo) || canonicalLabels.get(link.linksTo) == null)
				canonicalLabels.set(link.linksTo, link.toolTip)
		}
	}
	const nodes = acquired.nodes.map((node) => {
		const baseImages = assets.baseImages.get(node.id) ?? []
		const firstBase = baseImages[0]
		if (firstBase == null)
			throw new Error(`Missing verified WZ base image assets for ${node.id}`)
		const linkAssets = assets.linkImages.get(node.id) ?? []
		const links: WorldMapGraphLink[] = node.links.map((link, index) => {
			const linkImage = linkAssets[index] ?? null
			const screenOrigin = {
				x: firstBase.origin.x - (link.linkImage?.origin.x ?? 0),
				y: firstBase.origin.y - (link.linkImage?.origin.y ?? 0),
			}
			return {
				id: `link-${index}`,
				canonicalLabel: link.toolTip,
				localizedNames: {},
				targetWorldMapId: link.linksTo,
				linkImage,
				screenOrigin,
				hitRect: linkAssetRect(linkImage, screenOrigin, firstBase),
			}
		})
		const spots: WorldMapGraphSpot[] = node.maps.map((spot, index) => ({
			id: `spot-${index}`,
			spot: spot.spot,
			type: spot.type,
			mapNumbers: [...spot.mapNumbers],
			point: {
				x: firstBase.origin.x + spot.spot.x,
				y: firstBase.origin.y + spot.spot.y,
				normalizedX: normalized(firstBase.origin.x + spot.spot.x, firstBase.width),
				normalizedY: normalized(firstBase.origin.y + spot.spot.y, firstBase.height),
			},
			hitRect: null,
			maps: spot.mapNumbers.map(mapId => graphMap(mapId, detailById.get(mapId) ?? null, catalog)),
		}))
		return {
			worldMapId: node.id,
			worldMapName: node.worldMapName,
			canonicalLabel: canonicalLabels.get(node.id) ?? null,
			localizedNames: {},
			parentWorldMapId: node.parentWorld,
			baseImages,
			links,
			spots,
			provenance: {
				provider: acquired.provider,
				region: acquired.region,
				version: acquired.version,
				apiBase: acquired.apiBase,
			},
		}
	})
	return {
		roots: acquired.nodes.filter(node => node.parentWorld === null).map(node => node.id),
		nodes,
	}
}

/** Applies display-only localization by native IDs/link order; it cannot alter graph topology. */
export function localizeWorldMapGraph(graph: WorldMapGraph, attempts: readonly LocalizationAttempt[] | readonly LocalizedGameDataSnapshot[]): WorldMapGraph {
	const normalizedAttempts = attemptsOf(attempts)
	return {
		roots: [...graph.roots],
		nodes: graph.nodes.map((node) => {
			const sourceLinks = node.links.map(link => ({ toolTip: link.canonicalLabel, linksTo: link.targetWorldMapId }))
			const localizedNames: Record<string, LocalizedName> = {}
			for (const attempt of normalizedAttempts) {
				const snapshot = attempt.snapshot
				if (snapshot == null) {
					localizedNames[attempt.locale] = unavailableName(attempt)
					continue
				}
				const parentLinks = snapshot.worldMaps.flatMap(candidate => candidate.links.filter(link => link.linksTo === node.worldMapId && link.toolTip != null))
				localizedNames[attempt.locale] = localizedName(attempt, parentLinks.length === 1 ? parentLinks[0]!.toolTip : null, 'worldMapId')
			}
			return {
				...node,
				localizedNames,
				links: node.links.map((link, index) => {
					const localizedNames: Record<string, LocalizedName> = {}
					for (const attempt of normalizedAttempts) {
						const name = attempt.snapshot == null
							? null
							: localizedLinkName(attempt.snapshot, node.worldMapId, sourceLinks[index]!, index, sourceLinks)
						localizedNames[attempt.locale] = localizedName(attempt, name, 'worldMapId')
					}
					return { ...link, localizedNames }
				}),
				spots: node.spots.map(spot => ({
					...spot,
					maps: spot.maps.map((map) => {
						const localizedNames: Record<string, LocalizedName> = {}
						for (const attempt of normalizedAttempts) {
							const detail = attempt.snapshot == null ? null : uniqueMap(attempt.snapshot, map.mapId)
							localizedNames[attempt.locale] = localizedName(attempt, detail?.name ?? null, 'mapId')
						}
						return { ...map, localizedNames }
					}),
				})),
			}
		}),
	}
}

export function graphNodeMap(graph: WorldMapGraph): Map<string, WorldMapGraph['nodes'][number]> {
	return new Map(graph.nodes.map(node => [node.worldMapId, node]))
}
