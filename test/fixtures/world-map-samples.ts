import type { GameDataSnapshot, WikiImageInfo, WikiPage, WikiRevision, WorldMapSourceConfig } from '../../world-map/source'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { extractBgmKeys, parsePoints } from '../../world-map/parse'

const IMAGE_BYTES = Buffer.from('world-map-fixture-image-v1', 'utf8')
const MARKER_BYTES = Buffer.from('world-map-fixture-marker-v1', 'utf8')
const SNAPSHOT = JSON.parse(readFileSync(new URL('./world-map-samples.json', import.meta.url), 'utf8')) as SnapshotData
const GAME_DATA_SOURCE = JSON.parse(readFileSync(new URL('./maplestory-io-gms-270.json', import.meta.url), 'utf8')) as {
	provider: 'maplestory-io'
	region: string
	version: number
	apiBase: string
	worldMaps: Array<{ id: string, parentWorld: string, links: Array<{ toolTip: string, linksTo: string }>, maps: Array<{ mapNumbers: string[] }> }>
	maps: GameDataSnapshot['maps']
}
const GAME_DATA: GameDataSnapshot = {
	...GAME_DATA_SOURCE,
	worldMaps: GAME_DATA_SOURCE.worldMaps.map(worldMap => ({
		id: worldMap.id,
		worldMapName: worldMap.id,
		parentWorld: worldMap.parentWorld || null,
		links: worldMap.links.map(link => ({ ...link, linkImage: null })),
		baseImages: [],
		maps: worldMap.maps.map(map => ({ spot: { x: 0, y: 0 }, type: null, mapNumbers: map.mapNumbers })),
		mapNumbers: worldMap.maps.flatMap(map => map.mapNumbers),
	})),
}

const GMS_BGM_STRUCTURES: Record<string, string> = {
	'FloralLife': 'Bgm00',
	'Nautilus': 'Bgm15',
	'CavaBien': 'Bgm01',
	'TheHolyLand': 'Bgm53',
	'Welcome to Ramuramu Valley': 'Bgm57',
}

interface SnapshotRevision {
	revid: number
	timestamp: string
}

interface SnapshotTargetPage extends SnapshotRevision {
	title: string
	content: string
}

interface SnapshotSample {
	id: string
	title: string
	pageTitle: string
	worldMapWikitextTitle: string
	baseImageFile: string
	pageRevision: SnapshotRevision
	mapSourceRevision: SnapshotRevision
	mapSourceWikitext: string
	markerSizes: Record<string, { width: number, height: number }>
	targetPages: SnapshotTargetPage[]
}

interface SnapshotData {
	samples: SnapshotSample[]
}

export interface WorldMapSampleFixture {
	config: WorldMapSourceConfig
	pageRevision: WikiRevision
	mapSourceRevision: WikiRevision
	baseImageFile: string
	mapSourceWikitext: string
	targetPages: Map<string, WikiPage>
	imageInfoByFile: Map<string, WikiImageInfo>
	baseImageBytes: Buffer
	assetFile: string
	catalog: Array<{ filename: string, mark?: string, source?: { structure?: string, filename?: string } }>
	gameData: GameDataSnapshot
}

function sha1(bytes: Uint8Array): string {
	return createHash('sha1')
		.update(bytes)
		.digest('hex')
}

function imageInfo(file: string, width: number, height: number, bytes: Uint8Array): WikiImageInfo {
	return {
		timestamp: '2026-01-01T00:00:00Z',
		size: bytes.byteLength,
		width,
		height,
		url: `fixture://${file}`,
		sha1: sha1(bytes),
		mime: 'image/png',
	}
}

function toFixture(sample: SnapshotSample): WorldMapSampleFixture {
	const config: WorldMapSourceConfig = {
		id: sample.id,
		title: sample.title,
		pageTitle: sample.pageTitle,
		worldMapWikitextTitle: sample.worldMapWikitextTitle,
		gameWorldMapId: sample.id === 'victoria-island' ? 'WorldMap010' : 'WorldMap230',
		gameRegion: 'GMS',
	}
	const targetPages = new Map<string, WikiPage>()
	for (const page of sample.targetPages) {
		targetPages.set(page.title.toLowerCase(), {
			title: page.title,
			revisions: [{
				revid: page.revid,
				timestamp: page.timestamp,
				content: page.content,
			}],
		})
	}
	const markerFiles = new Set(parsePoints(sample.mapSourceWikitext).map(point => point.markerFile))
	const imageInfoByFile = new Map<string, WikiImageInfo>([
		[sample.baseImageFile, imageInfo(sample.baseImageFile, 640, 470, IMAGE_BYTES)],
	])
	for (const file of markerFiles) {
		const size = sample.markerSizes[file] ?? { width: 20, height: 20 }
		imageInfoByFile.set(file, imageInfo(file, size.width, size.height, MARKER_BYTES))
	}
	const catalog = [...new Set(sample.targetPages.flatMap(page => extractBgmKeys(page.content)))].map(filename => ({
		filename,
		source: GMS_BGM_STRUCTURES[filename] == null ? undefined : { structure: GMS_BGM_STRUCTURES[filename] },
	}))
	return {
		config,
		pageRevision: { ...sample.pageRevision, content: sample.mapSourceWikitext },
		mapSourceRevision: { ...sample.mapSourceRevision, content: sample.mapSourceWikitext },
		baseImageFile: sample.baseImageFile,
		mapSourceWikitext: sample.mapSourceWikitext,
		targetPages,
		imageInfoByFile,
		baseImageBytes: IMAGE_BYTES,
		assetFile: `world-map/images/${sample.baseImageFile.replaceAll(' ', '_')}`,
		catalog,
		gameData: GAME_DATA,
	}
}

export const VICTORIA_ISLAND_FIXTURE = toFixture(SNAPSHOT.samples.find(sample => sample.id === 'victoria-island')!)
export const CERNIUM_FIXTURE = toFixture(SNAPSHOT.samples.find(sample => sample.id === 'cernium')!)
