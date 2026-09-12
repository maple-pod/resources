import type { GameDataSource } from './schema'

function sameArchivedWzProvenance(left: GameDataSource['archivedWz'], right: GameDataSource['archivedWz']): boolean {
	if (left == null || right == null)
		return left == null && right == null
	return left.providerRegion === right.providerRegion
		&& left.providerVersion === right.providerVersion
		&& left.archiveItem === right.archiveItem
		&& left.archiveFile === right.archiveFile
		&& left.archiveSha1.toLowerCase() === right.archiveSha1.toLowerCase()
		&& left.members.stringWz.name === right.members.stringWz.name
		&& left.members.stringWz.sha256.toLowerCase() === right.members.stringWz.sha256.toLowerCase()
		&& left.members.mapWz.name === right.members.mapWz.name
		&& left.members.mapWz.sha256.toLowerCase() === right.members.mapWz.sha256.toLowerCase()
}

export function gameDataSourceMatches(actual: GameDataSource, expected: GameDataSource): boolean {
	return actual.provider === expected.provider
		&& actual.region === expected.region
		&& actual.logicalRegion === expected.logicalRegion
		&& actual.version === expected.version
		&& actual.apiBase === expected.apiBase
		&& actual.releaseId === expected.releaseId
		&& sameArchivedWzProvenance(actual.archivedWz, expected.archivedWz)
}

export interface WikiRevision {
	revid: number
	timestamp: string
	content: string
}

export interface WikiPage {
	pageid?: number
	title: string
	missing?: boolean
	revisions?: WikiRevision[]
	imageinfo?: WikiImageInfo[]
}

export interface WikiImageInfo {
	timestamp: string
	size: number
	width: number
	height: number
	url: string
	sha1: string
	mime: string
}

export interface ParsedWorldMapPoint {
	left: number
	top: number
	markerFile: string
	target: string
	label: string
}

export const CANONICAL_GAME_REGION = 'GMS' as const

export interface WorldMapSourceConfig {
	id: string
	title: string
	pageTitle: string
	worldMapWikitextTitle: string
	/** Stable game-data acquisition anchor; the topology and joins come from MapleStory.IO. */
	gameWorldMapId: string
	gameRegion: typeof CANONICAL_GAME_REGION
}

export interface GameWorldMapLink {
	toolTip: string | null
	linksTo: string
	linkImage: GameWorldMapImage | null
}

export interface GameWorldMapImage {
	image: string
	origin: { x: number, y: number }
}

export interface GameWorldMapSpot {
	spot: { x: number, y: number }
	type: number | string | null
	mapNumbers: string[]
}

export interface GameWorldMap {
	id: string
	worldMapName: string
	parentWorld: string | null
	links: GameWorldMapLink[]
	baseImages: GameWorldMapImage[]
	maps: GameWorldMapSpot[]
	/** Flattened native map IDs retained for existing v5 enrichment joins. */
	mapNumbers: string[]
}

export interface GameMapDetail {
	id: string
	mapMark: string | null
	name: string | null
	streetName: string | null
	/** Game-native BGM path, for example `Bgm00/FloralLife`. */
	backgroundMusic: string | null
}

export interface GameMapSearchCandidate {
	id: string
	name: string | null
	streetName: string | null
}

export interface GameDataSnapshot {
	provider: 'maplestory-io'
	region: string
	version: string
	apiBase: string
	worldMaps: GameWorldMap[]
	maps: GameMapDetail[]
}

export interface LocalizedGameDataSnapshot extends GameDataSnapshot {
	locale: string
}

export interface WorldMapLocalizationConfig {
	locale: string
	region: string
	version?: string
}

export interface LocalizationAttempt {
	locale: string
	source: GameDataSource
	snapshot: LocalizedGameDataSnapshot | null
}

export interface AcquiredWorldMapSource {
	config: WorldMapSourceConfig
	pageRevision: WikiRevision
	mapSourceRevision: WikiRevision
	baseImageFile: string
	points: ParsedWorldMapPoint[]
	targetPages: Map<string, WikiPage>
	imageInfoByFile: Map<string, WikiImageInfo>
	gameData?: GameDataSnapshot
}

export interface MapleBgmCatalogItem {
	filename?: string
	id?: string
	mark?: string
	source?: {
		structure?: string
		filename?: string
	}
}
