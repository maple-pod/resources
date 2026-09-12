import type { WorldMapGraph } from './schema'
import { createHash } from 'node:crypto'

export const WORLD_MAP_SNAPSHOT_CATALOG_SCHEMA_VERSION = 1 as const

export type WorldMapRegion = 'GMS' | 'TWMS'
export type MapleStoryIoRegionCode = 'GMS' | 'TMS' | 'TWMS'
export type WorldMapSnapshotId = `${WorldMapRegion}/${string}`
export interface WorldMapSnapshotRequest {
	region: WorldMapRegion
	version: string
}

export interface MapleStoryIoSnapshotSource {
	provider: 'maplestory-io'
	regionCode: MapleStoryIoRegionCode
	version: string
}

export interface MapleArchiveSnapshotSource {
	provider: 'maplearchive'
	regionSlug: 'gms' | 'twms'
	versionLabel: string
}

export interface WorldMapSnapshotFingerprint {
	topology: string
	geometry: string
	assets: string
	worldMapNames: string
	mapDetails: string
	combined: string
}

export interface WorldMapSnapshotCatalogEntry {
	id: WorldMapSnapshotId
	/** Stable user-facing selector label; does not require frontend chronology knowledge. */
	label: string
	region: WorldMapRegion
	version: string
	recommended: boolean
	/** True only when this exact snapshot has generated resources in the catalog output. */
	selectable: boolean
	historicallyImportant: boolean
	/** Null means we have not yet established full WZ-level distinctness. */
	worldMapDataDistinct: boolean | null
	/** Snapshot used as the evidence baseline for worldMapDataDistinct, when recorded. */
	worldMapComparedTo: WorldMapSnapshotId | null
	mapleStoryIo: MapleStoryIoSnapshotSource | null
	mapleArchive: MapleArchiveSnapshotSource | null
	fingerprint: WorldMapSnapshotFingerprint | null
	dataRef: WorldMapSnapshotId | null
	notes: string[]
}

export interface WorldMapSnapshotCatalog {
	schemaVersion: typeof WORLD_MAP_SNAPSHOT_CATALOG_SCHEMA_VERSION
	generatedAt: string
	defaultSnapshot: WorldMapSnapshotId
	entries: WorldMapSnapshotCatalogEntry[]
}

interface CuratedSnapshotDefinition extends Omit<WorldMapSnapshotCatalogEntry, 'id' | 'selectable' | 'worldMapComparedTo' | 'mapleStoryIo' | 'mapleArchive' | 'fingerprint' | 'dataRef'> {
	worldMapComparedTo?: WorldMapSnapshotId
	mapleStoryIoRegionCode?: MapleStoryIoRegionCode
	mapleArchiveRegionSlug?: 'gms' | 'twms'
}

const CURATED_SNAPSHOT_DEFINITIONS: readonly CuratedSnapshotDefinition[] = [
	{ label: 'GMS v92 — pre-Big Bang', region: 'GMS', version: '92', recommended: false, historicallyImportant: true, worldMapDataDistinct: null, mapleStoryIoRegionCode: 'GMS', mapleArchiveRegionSlug: 'gms', notes: ['Pre-Big-Bang comparison baseline.'] },
	{ label: 'GMS v93 — Big Bang', region: 'GMS', version: '93', recommended: true, historicallyImportant: true, worldMapDataDistinct: true, worldMapComparedTo: 'GMS/92', mapleStoryIoRegionCode: 'GMS', notes: ['Big Bang World Map milestone.'] },
	{ label: 'GMS v137 — Unleashed', region: 'GMS', version: '137', recommended: true, historicallyImportant: true, worldMapDataDistinct: true, worldMapComparedTo: 'GMS/93', mapleStoryIoRegionCode: 'GMS', notes: ['Unleashed World Map redesign milestone.'] },
	{ label: 'GMS v177 — pre-Limitless comparison', region: 'GMS', version: '177', recommended: false, historicallyImportant: false, worldMapDataDistinct: null, mapleStoryIoRegionCode: 'GMS', notes: ['Comparison baseline for the v178 World Map payload.'] },
	{ label: 'GMS v178 — V: Limitless', region: 'GMS', version: '178', recommended: false, historicallyImportant: true, worldMapDataDistinct: false, worldMapComparedTo: 'GMS/177', mapleStoryIoRegionCode: 'GMS', notes: ['V: Limitless UI milestone retained as historical metadata; direct MapleStory.IO comparison against GMS/177 found identical WorldMap topology, geometry, base/link image payloads, link tooltips, and String/WorldMap names (UI change is outside WZ map payload; Arcane River appears in v179). Serves as historical metadata with eventual dataRef; not recommended as a distinct world-map data revision.'] },
	{ label: 'GMS v179 — Arcane River topology', region: 'GMS', version: '179', recommended: true, historicallyImportant: true, worldMapDataDistinct: true, worldMapComparedTo: 'GMS/178', mapleStoryIoRegionCode: 'GMS', notes: ['Arcane River WorldMap nodes first observed after v178.'] },
	{ label: 'GMS v202', region: 'GMS', version: '202', recommended: false, historicallyImportant: false, worldMapDataDistinct: true, worldMapComparedTo: 'GMS/179', mapleStoryIoRegionCode: 'GMS', notes: ['Candidate modern topology checkpoint.'] },
	{ label: 'GMS v223', region: 'GMS', version: '223', recommended: false, historicallyImportant: false, worldMapDataDistinct: true, worldMapComparedTo: 'GMS/202', mapleStoryIoRegionCode: 'GMS', notes: ['Candidate NEO/Cernium topology checkpoint.'] },
	{ label: 'GMS v224', region: 'GMS', version: '224', recommended: false, historicallyImportant: false, worldMapDataDistinct: true, worldMapComparedTo: 'GMS/223', mapleStoryIoRegionCode: 'GMS', notes: ['World Map hover behavior changed; node inventory matches v223.', 'Direct MapleStory.IO comparison against GMS/223 found WorldMap topology changes in GWorldMap/WorldMap, GWorldMap geometry changes, asset changes in GWorldMap/WorldMap060/WorldMap0826/WorldMap082a, and tooltip changes; String/WorldMap names were unchanged.'] },
	{ label: 'GMS v233 — comparison baseline', region: 'GMS', version: '233', recommended: false, historicallyImportant: false, worldMapDataDistinct: true, worldMapComparedTo: 'GMS/224', mapleStoryIoRegionCode: 'GMS', notes: ['Observed World Map inventory grows from 91 IDs at v224 to 93 IDs at v233.'] },
	{ label: 'GMS v246 — New Age candidate', region: 'GMS', version: '246', recommended: true, historicallyImportant: true, worldMapDataDistinct: true, worldMapComparedTo: 'GMS/233', mapleStoryIoRegionCode: 'GMS', notes: ['New Age / Grandis reorganization candidate baseline.'] },
	{ label: 'GMS v247', region: 'GMS', version: '247', recommended: false, historicallyImportant: false, worldMapDataDistinct: true, worldMapComparedTo: 'GMS/246', mapleStoryIoRegionCode: 'GMS', notes: ['Adds WorldMap177, WorldMap300 and WorldMap310 in observed topology.'] },
	{ label: 'GMS v263', region: 'GMS', version: '263', recommended: false, historicallyImportant: false, worldMapDataDistinct: true, worldMapComparedTo: 'GMS/247', mapleStoryIoRegionCode: 'GMS', notes: ['Adds EGWorldMap/WGWorldMap and later Grandis nodes in observed topology.'] },
	{ label: 'GMS v270', region: 'GMS', version: '270', recommended: true, historicallyImportant: false, worldMapDataDistinct: true, worldMapComparedTo: 'GMS/263', mapleStoryIoRegionCode: 'GMS', notes: ['Current MapleStory.IO GMS archive baseline used by existing resources.'] },

	{ label: 'TWMS v122 — pre-Big Bang', region: 'TWMS', version: '122', recommended: false, historicallyImportant: true, worldMapDataDistinct: null, mapleArchiveRegionSlug: 'twms', notes: ['Last currently imported pre-Big-Bang TWMS build in MapleArchive; useful as a source-boundary comparison baseline.'] },
	{ label: 'TWMS v124 — Big Bang', region: 'TWMS', version: '124', recommended: true, historicallyImportant: true, worldMapDataDistinct: null, notes: ['Big Bang World Map milestone. Historical archived WZ snapshot.'] },
	{ label: 'TWMS v158', region: 'TWMS', version: '158', recommended: true, historicallyImportant: true, worldMapDataDistinct: true, worldMapComparedTo: 'TWMS/124', notes: ['First tested archived TWMS snapshot in this research with String/WorldMap.img present.', 'Direct full comparison against TWMS/124 proves distinct WorldMap topology (43 nodes vs 27), geometry, assets, and newly added String/WorldMap.img labels.'] },
	{ label: 'TWMS v171 — YOU&i', region: 'TWMS', version: '171', recommended: true, historicallyImportant: true, worldMapDataDistinct: true, worldMapComparedTo: 'TWMS/158', notes: ['YOU&i release notes explicitly mention World Map UI optimization.', 'Direct full comparison against TWMS/158 proves distinct WorldMap topology (55 nodes vs 43, adding roots BWorldMap and MWorldMap), geometry, assets, and labels.'] },
	{ label: 'TWMS v209', region: 'TWMS', version: '209', recommended: true, historicallyImportant: false, worldMapDataDistinct: true, worldMapComparedTo: 'TWMS/217', mapleStoryIoRegionCode: 'TMS', notes: ['MapleStory.IO stores this Taiwan snapshot under provider region code TMS.', 'Direct WorldMap inventory diff against TWMS/217: 79 IDs vs 85; v217 adds WorldMap0102, WorldMap0103 and WorldMap0827/08271/08272/08273.'] },
	{ label: 'TWMS v217', region: 'TWMS', version: '217', recommended: true, historicallyImportant: false, worldMapDataDistinct: true, worldMapComparedTo: 'TWMS/209', mapleStoryIoRegionCode: 'TWMS', notes: ['Earliest currently observed MapleStory.IO TWMS snapshot.'] },
	{ label: 'TWMS v221 — comparison baseline', region: 'TWMS', version: '221', recommended: false, historicallyImportant: false, worldMapDataDistinct: null, mapleStoryIoRegionCode: 'TWMS', notes: ['Last observed 85-node baseline before the v228 inventory transition.'] },
	{ label: 'TWMS v228 — RISE-era topology', region: 'TWMS', version: '228', recommended: false, historicallyImportant: false, worldMapDataDistinct: true, worldMapComparedTo: 'TWMS/221', mapleStoryIoRegionCode: 'TWMS', notes: ['Observed large node-inventory transition.'] },
	{ label: 'TWMS v231 — comparison baseline', region: 'TWMS', version: '231', recommended: false, historicallyImportant: false, worldMapDataDistinct: null, mapleStoryIoRegionCode: 'TWMS', notes: ['Comparison baseline immediately before the v232 inventory transition.'] },
	{ label: 'TWMS v232 — AWAKE-era topology', region: 'TWMS', version: '232', recommended: false, historicallyImportant: false, worldMapDataDistinct: true, worldMapComparedTo: 'TWMS/231', mapleStoryIoRegionCode: 'TWMS', notes: ['Observed additional World Map node transition.'] },
	{ label: 'TWMS v233 — comparison baseline', region: 'TWMS', version: '233', recommended: false, historicallyImportant: false, worldMapDataDistinct: null, mapleStoryIoRegionCode: 'TWMS', notes: ['Comparison baseline immediately before the v236 inventory transition.'] },
	{ label: 'TWMS v236', region: 'TWMS', version: '236', recommended: true, historicallyImportant: false, worldMapDataDistinct: true, worldMapComparedTo: 'TWMS/233', mapleStoryIoRegionCode: 'TWMS', notes: ['Observed large NEO-era topology transition.'] },
	{ label: 'TWMS v239 — comparison baseline', region: 'TWMS', version: '239', recommended: false, historicallyImportant: false, worldMapDataDistinct: null, mapleStoryIoRegionCode: 'TWMS', notes: ['Comparison baseline immediately before WorldMap260 appears at v240.'] },
	{ label: 'TWMS v240 — On Air-era topology', region: 'TWMS', version: '240', recommended: false, historicallyImportant: false, worldMapDataDistinct: true, worldMapComparedTo: 'TWMS/239', mapleStoryIoRegionCode: 'TWMS', notes: ['Observed WorldMap260 transition.'] },
	{ label: 'TWMS v249 — comparison baseline', region: 'TWMS', version: '249', recommended: false, historicallyImportant: false, worldMapDataDistinct: null, mapleStoryIoRegionCode: 'TWMS', notes: ['Comparison baseline immediately before WorldMap270 appears at v250.'] },
	{ label: 'TWMS v250', region: 'TWMS', version: '250', recommended: false, historicallyImportant: false, worldMapDataDistinct: true, worldMapComparedTo: 'TWMS/249', mapleStoryIoRegionCode: 'TWMS', notes: ['Observed WorldMap270 transition.'] },
	{ label: 'TWMS v252 — comparison baseline', region: 'TWMS', version: '252', recommended: false, historicallyImportant: false, worldMapDataDistinct: null, mapleStoryIoRegionCode: 'TWMS', notes: ['Comparison baseline immediately before CGWorldMap and WorldMap280 appear at v253.'] },
	{ label: 'TWMS v253 — Savior-era topology', region: 'TWMS', version: '253', recommended: true, historicallyImportant: false, worldMapDataDistinct: true, worldMapComparedTo: 'TWMS/252', mapleStoryIoRegionCode: 'TWMS', notes: ['Observed CGWorldMap and WorldMap280 transition.'] },
	{ label: 'TWMS v255 — comparison baseline', region: 'TWMS', version: '255', recommended: false, historicallyImportant: false, worldMapDataDistinct: null, mapleStoryIoRegionCode: 'TWMS', notes: ['Comparison baseline for the latest v256 archive snapshot.'] },
	{ label: 'TWMS v256', region: 'TWMS', version: '256', recommended: true, historicallyImportant: false, worldMapDataDistinct: false, worldMapComparedTo: 'TWMS/255', mapleStoryIoRegionCode: 'TWMS', notes: ['Latest currently observed MapleStory.IO TWMS archive baseline.', 'Direct MapleStory.IO comparison against TWMS/255 found identical WorldMap topology, geometry, base/link image payloads, link tooltips, and String/WorldMap names. It remains recommended as the latest archive representative rather than as a distinct adjacent revision.'] },
]

export const DEFAULT_WORLD_MAP_SNAPSHOT: WorldMapSnapshotId = 'GMS/270'

export function isValidWorldMapRegion(region: string): region is WorldMapRegion {
	return region === 'GMS' || region === 'TWMS'
}

export function isValidWorldMapSnapshotVersion(version: unknown): version is string {
	if (typeof version !== 'string' || version.length === 0)
		return false
	if (version === 'latest')
		return false
	return /^[A-Za-z0-9][\w.-]*$/u.test(version)
}

export function parseNumericVersion(version: string): number | null {
	if (!/^\d+$/u.test(version))
		return null
	const numeric = Number(version)
	return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null
}

export function compareSnapshotVersions(left: string, right: string): number {
	const leftNumeric = parseNumericVersion(left)
	const rightNumeric = parseNumericVersion(right)
	if (leftNumeric != null && rightNumeric != null)
		return leftNumeric - rightNumeric
	return left.localeCompare(right, undefined, { numeric: true })
}

export function worldMapSnapshotId(region: WorldMapRegion, version: string): WorldMapSnapshotId {
	if (!isValidWorldMapRegion(region) || !isValidWorldMapSnapshotVersion(version))
		throw new Error(`Invalid world-map snapshot version: ${version}`)
	return `${region}/${version}`
}

export function parseWorldMapSnapshotRequest(value: string): WorldMapSnapshotRequest {
	const match = /^(GMS|TWMS)\/([^/\s]+)$/u.exec(value)
	if (match == null)
		throw new Error(`Invalid world-map snapshot request: ${value}`)
	const region = match[1] as WorldMapRegion
	const version = match[2]!
	if (version !== 'latest' && !isValidWorldMapSnapshotVersion(version))
		throw new Error(`Invalid world-map snapshot request: ${value}`)
	return { region, version }
}

export function parseWorldMapSnapshotId(value: string): { region: WorldMapRegion, version: string } {
	const match = /^(GMS|TWMS)\/([^/\s]+)$/u.exec(value)
	if (match == null || !isValidWorldMapSnapshotVersion(match[2]!))
		throw new Error(`Invalid world-map snapshot id: ${value}`)
	return { region: match[1] as WorldMapRegion, version: match[2]! }
}

/**
 * Provider routing is explicit because MapleStory.IO uses TMS for v209 and TWMS
 * for the later Taiwan archive. Logical product identity remains TWMS.
 */
export function mapleStoryIoSourceForSnapshot(region: WorldMapRegion, version: string): MapleStoryIoSnapshotSource | null {
	worldMapSnapshotId(region, version)
	if (region === 'GMS')
		return { provider: 'maplestory-io', regionCode: 'GMS', version }
	if (region === 'TWMS') {
		const numeric = parseNumericVersion(version)
		if (numeric === 209)
			return { provider: 'maplestory-io', regionCode: 'TMS', version }
		if (numeric != null && numeric >= 217)
			return { provider: 'maplestory-io', regionCode: 'TWMS', version }
		return null
	}
	return null
}

export function curatedWorldMapSnapshotEntries(): WorldMapSnapshotCatalogEntry[] {
	const entries = CURATED_SNAPSHOT_DEFINITIONS.map((definition): WorldMapSnapshotCatalogEntry => {
		if ((definition.worldMapDataDistinct == null) !== (definition.worldMapComparedTo == null))
			throw new Error(`Snapshot ${definition.region}/${definition.version} must pair worldMapDataDistinct with worldMapComparedTo`)
		return {
			id: worldMapSnapshotId(definition.region, definition.version),
			label: definition.label,
			region: definition.region,
			version: definition.version,
			recommended: definition.recommended,
			selectable: false,
			historicallyImportant: definition.historicallyImportant,
			worldMapDataDistinct: definition.worldMapDataDistinct,
			worldMapComparedTo: definition.worldMapComparedTo ?? null,
			mapleStoryIo: definition.mapleStoryIoRegionCode == null
				? null
				: { provider: 'maplestory-io', regionCode: definition.mapleStoryIoRegionCode, version: definition.version },
			mapleArchive: definition.mapleArchiveRegionSlug == null
				? null
				: { provider: 'maplearchive', regionSlug: definition.mapleArchiveRegionSlug, versionLabel: definition.version },
			fingerprint: null,
			dataRef: null,
			notes: [...definition.notes],
		}
	})
	const ids = new Set(entries.map(entry => entry.id))
	for (const entry of entries) {
		if (entry.worldMapComparedTo != null && !ids.has(entry.worldMapComparedTo))
			throw new Error(`Snapshot ${entry.id} compares against unknown catalog snapshot ${entry.worldMapComparedTo}`)
	}
	return entries
}

function sha256(value: unknown): string {
	return createHash('sha256')
		.update(JSON.stringify(value))
		.digest('hex')
}

export function fingerprintWorldMapGraph(graph: WorldMapGraph): WorldMapSnapshotFingerprint {
	const nodes = [...graph.nodes].sort((left, right) => left.worldMapId.localeCompare(right.worldMapId))
	const topology = sha256({
		roots: [...graph.roots].sort(),
		nodes: nodes.map(node => ({
			id: node.worldMapId,
			parent: node.parentWorldMapId,
			links: node.links.map(link => link.targetWorldMapId),
			spots: node.spots.map(spot => ({ type: spot.type, mapNumbers: [...spot.mapNumbers] })),
		})),
	})
	const geometry = sha256(nodes.map(node => ({
		id: node.worldMapId,
		baseImages: node.baseImages.map(asset => ({ width: asset.width, height: asset.height, origin: asset.origin })),
		links: node.links.map(link => ({ target: link.targetWorldMapId, screenOrigin: link.screenOrigin, hitRect: link.hitRect, hitPath: link.hitPath })),
		spots: node.spots.map(spot => ({ spot: spot.spot, point: spot.point, hitRect: spot.hitRect })),
	})))
	const assets = sha256(nodes.map(node => ({
		id: node.worldMapId,
		baseImages: node.baseImages.map(asset => ({ sha1: asset.sha1, width: asset.width, height: asset.height, origin: asset.origin })),
		links: node.links.map(link => link.linkImage == null
			? null
			: { sha1: link.linkImage.sha1, width: link.linkImage.width, height: link.linkImage.height, origin: link.linkImage.origin }),
	})))
	const worldMapNames = sha256(nodes.map(node => ({
		id: node.worldMapId,
		worldMapName: node.worldMapName,
		canonicalLabel: node.canonicalLabel,
		canonicalLabelSource: node.canonicalLabelSource ?? null,
		links: node.links.map(link => ({ target: link.targetWorldMapId, canonicalLabel: link.canonicalLabel })),
	})))
	const mapDetails = sha256(nodes.map(node => ({
		id: node.worldMapId,
		spots: node.spots.map(spot => spot.maps.map(map => ({
			mapId: map.mapId,
			name: map.name,
			streetName: map.streetName,
			mapMark: map.mapMark,
			gameBgm: map.gameBgm == null
				? null
				: { path: map.gameBgm.path, structure: map.gameBgm.structure, filename: map.gameBgm.filename },
		}))),
	})))
	return {
		topology,
		geometry,
		assets,
		worldMapNames,
		mapDetails,
		combined: sha256({ topology, geometry, assets, worldMapNames, mapDetails }),
	}
}

export function createWorldMapSnapshotCatalog(
	generatedAt: string,
	generated: ReadonlyMap<WorldMapSnapshotId, WorldMapSnapshotFingerprint> = new Map(),
): WorldMapSnapshotCatalog {
	if (!Number.isFinite(Date.parse(generatedAt)))
		throw new Error(`Invalid world-map snapshot catalog generatedAt: ${generatedAt}`)
	const entries = curatedWorldMapSnapshotEntries()
	const known = new Set(entries.map(entry => entry.id))
	for (const id of generated.keys()) {
		if (known.has(id))
			continue
		const { region, version } = parseWorldMapSnapshotId(id)
		entries.push({
			id,
			label: `${region} v${version}`,
			region,
			version,
			recommended: false,
			selectable: false,
			historicallyImportant: false,
			worldMapDataDistinct: null,
			worldMapComparedTo: null,
			mapleStoryIo: mapleStoryIoSourceForSnapshot(region, version),
			mapleArchive: null,
			fingerprint: null,
			dataRef: null,
			notes: ['Explicitly generated snapshot; not part of the curated public recommendation set.'],
		})
	}
	entries.sort((left, right) => left.region.localeCompare(right.region) || compareSnapshotVersions(left.version, right.version))
	for (const entry of entries) {
		entry.fingerprint = generated.get(entry.id) ?? null
		entry.selectable = entry.fingerprint != null
	}
	return {
		schemaVersion: WORLD_MAP_SNAPSHOT_CATALOG_SCHEMA_VERSION,
		generatedAt,
		defaultSnapshot: DEFAULT_WORLD_MAP_SNAPSHOT,
		entries,
	}
}
