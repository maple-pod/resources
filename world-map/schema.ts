export const WORLD_MAP_SCHEMA_VERSION = 6 as const

export type WorldMapLandmarkKind = 'map' | 'region'

export interface WikiRevisionSource {
	pageTitle: string
	revisionId: number
	revisionTimestamp: string
}

export interface NormalizedRect {
	left: number
	top: number
	width: number
	height: number
}

export interface WorldMapImage {
	/** Path relative to the published resources root. */
	file: string
	width: number
	height: number
	sha1: string
}

export interface WorldMapOrigin {
	x: number
	y: number
}

export interface WorldMapAsset extends WorldMapImage {
	origin: WorldMapOrigin
}

export interface WorldMapGraphMap {
	mapId: string
	name: string | null
	streetName: string | null
	mapMark: string | null
	localizedNames: Record<string, LocalizedName>
	gameBgm: GameBgmEvidence | null
	selection: {
		trackId: string | null
		source: 'gms-map-bgm' | null
	}
}

export interface WorldMapGraphSpot {
	id: string
	spot: WorldMapOrigin
	type: number | string | null
	mapNumbers: string[]
	point: {
		x: number
		y: number
		normalizedX: number
		normalizedY: number
	}
	/** A point has no invented WZ hitbox; consumers may use point geometry. */
	hitRect: NormalizedRect | null
	maps: WorldMapGraphMap[]
}

export interface WorldMapGraphLink {
	id: string
	canonicalLabel: string | null
	localizedNames: Record<string, LocalizedName>
	targetWorldMapId: string
	linkImage: WorldMapAsset | null
	/** Exact WZ-origin transform in base-image coordinates. */
	screenOrigin: WorldMapOrigin
	/** Normalized link-image rectangle in the first base image's coordinate space. */
	hitRect: NormalizedRect | null
}

export interface WorldMapNode {
	worldMapId: string
	worldMapName: string
	canonicalLabel: string | null
	localizedNames: Record<string, LocalizedName>
	parentWorldMapId: string | null
	baseImages: WorldMapAsset[]
	links: WorldMapGraphLink[]
	spots: WorldMapGraphSpot[]
	provenance: GameDataSource
}

export interface WorldMapGraph {
	roots: string[]
	nodes: WorldMapNode[]
}

export interface GameDataSource {
	provider: 'maplestory-io'
	region: string
	/** Null is only valid for an unavailable optional localization attempt. */
	version: number | null
	apiBase: string
}

export interface LocalizedName {
	name: string | null
	source: GameDataSource
	status: 'available' | 'unavailable'
	join: 'mapId' | 'worldMapId' | null
}

export type MusicSelectionSource = 'gms-map-bgm' | 'wiki' | null

export interface GameBgmEvidence {
	path: string
	structure: string | null
	filename: string | null
	trackId: string | null
}

export type MusicReconciliationStatus = 'not-compared' | 'agree' | 'disagree' | 'gms-unmapped' | 'wiki-fallback'

export interface WorldMapLandmark {
	/** Stable resource identity. A coordinate suffix disambiguates duplicate visual hotspots for one map. */
	id: string
	label: string
	kind: WorldMapLandmarkKind
	target: {
		pageTitle: string
		mapId: string | null
		/** Canonical GMS game-data name; never populated from a non-GMS source. */
		name: string | null
		/** Game-native WorldMap node, only when the online topology supports the join. */
		worldMapId: string | null
		/** Game-native map marker/grouping signal; it is not a WorldMap node ID. */
		mapMark: string | null
		/** Enabled non-GMS locale names. A null name is intentional and not a GMS fallback. */
		localizedNames: Record<string, LocalizedName>
	}
	/** `map`, `world-map`, or explicit unresolved editorial grouping. */
	identity: 'map' | 'world-map' | 'unresolved' | 'manual-fallback'
	position: NormalizedRect
	tracks: string[]
	/** Singular frontend selection. `tracks` remains Wiki/catalog evidence for compatibility. */
	selection: {
		trackId: string | null
		source: MusicSelectionSource
	}
	gameBgm: GameBgmEvidence | null
	bgm: {
		sourceKeys: string[]
		unmappedKeys: string[]
		reconciliation: {
			status: MusicReconciliationStatus
			wikiTrackIds: string[]
		}
	}
	source: WikiRevisionSource | null
}

export interface WorldMap {
	id: string
	title: string
	image: WorldMapImage
	source: WikiRevisionSource
	gameData: GameDataSource | null
	landmarks: WorldMapLandmark[]
}

export interface WorldMapIndex {
	schemaVersion: typeof WORLD_MAP_SCHEMA_VERSION
	generatedAt: string
	/** Canonical v6 native graph. Optional only for offline v5 regression fixtures. */
	graph?: WorldMapGraph
	worlds: WorldMap[]
}
