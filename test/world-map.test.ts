/* eslint-disable test/no-import-node-test */
import type { AcquiredWorldMapGraph } from '../world-map/acquire'
import type { AcquiredWorldMapSource, GameWorldMap } from '../world-map/source'
import type { WorldMapSampleFixture } from './fixtures/world-map-samples'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { downloadVerifiedImage, MapleStoryIoClient } from '../world-map/acquire'
import { enrichCanonicalMapDetails } from '../world-map/enrich'
import { acquireLocalizationAttempts, createWorldMapGenerationPlan, parseGenerationMode, validateWorldMapSourceConfigs } from '../world-map/generate'
import { localizeWorldMapGraph, normalizeWorldMapGraph } from '../world-map/graph'
import { localizeWorldMap } from '../world-map/localize'
import { buildCatalogIndex, gameBgmCatalogMatch, parseGameBgmPath } from '../world-map/music'
import { normalizeWorldMap } from '../world-map/normalize'
import { extractMapIconToken, parseBaseImage, parseBgmKeys, parsePoints } from '../world-map/parse'
import { WORLD_MAP_SCHEMA_VERSION } from '../world-map/schema'
import { validateWorldMapIndex } from '../world-map/validate'
import { LOCALIZATION_FIXTURES } from './fixtures/world-map-localization'
import { CERNIUM_FIXTURE, VICTORIA_ISLAND_FIXTURE } from './fixtures/world-map-samples'

function acquired(fixture: WorldMapSampleFixture): AcquiredWorldMapSource {
	return {
		config: fixture.config,
		pageRevision: fixture.pageRevision,
		mapSourceRevision: fixture.mapSourceRevision,
		baseImageFile: fixture.baseImageFile,
		points: parsePoints(fixture.mapSourceWikitext),
		targetPages: fixture.targetPages,
		imageInfoByFile: fixture.imageInfoByFile,
		gameData: fixture.gameData,
	}
}

function withTargetContent(fixture: WorldMapSampleFixture, title: string, content: string): WorldMapSampleFixture {
	const targetPages = new Map(fixture.targetPages)
	const page = targetPages.get(title.toLowerCase())!
	targetPages.set(title.toLowerCase(), {
		...page,
		revisions: page.revisions?.map(revision => ({ ...revision, content })),
	})
	return { ...fixture, targetPages }
}

function normalizeFixture(fixture: WorldMapSampleFixture) {
	return normalizeWorldMap(acquired(fixture), {
		assetPathByFile: new Map([[fixture.baseImageFile, fixture.assetFile]]),
		catalog: fixture.catalog,
	}).world
}

async function normalizeAndValidate(fixture: WorldMapSampleFixture) {
	const source = acquired(fixture)
	const assetRoot = await mkdtemp(path.join(tmpdir(), 'world-map-test-'))
	const assetPath = path.join(assetRoot, fixture.assetFile)
	await mkdir(path.dirname(assetPath), { recursive: true })
	await writeFile(assetPath, fixture.baseImageBytes)
	const normalized = normalizeWorldMap(source, {
		assetPathByFile: new Map([[fixture.baseImageFile, fixture.assetFile]]),
		catalog: fixture.catalog,
	})
	const index = {
		schemaVersion: WORLD_MAP_SCHEMA_VERSION,
		generatedAt: '2026-09-09T00:00:00.000Z',
		worlds: [normalized.world],
	}
	const bgmIds = new Set(fixture.catalog.map(item => item.filename))
	await validateWorldMapIndex(index, { assetRoot, bgmIds })
	return { assetRoot, normalized, index }
}

function graphFixture(): { acquired: AcquiredWorldMapGraph, catalog: Array<{ filename: string, source: { structure: string } }> } {
	const baseOrigin = { x: 1000, y: 1000 }
	const victoriaTargets = [
		['Nautilus', 'WorldMap011', 407, 336],
		['Sleepywood', 'WorldMap012', 245, 192],
		['Ellinel Fairy Academy', 'WorldMap017', 328, 170],
		['Gold Beach', 'WorldMap018', 558, 262],
		['Mushroom Castle', 'WorldMap019', 34, 343],
		['Kerning Tower', 'WorldMap0101', 63, 190],
		['Secret Forest of Elodin', 'WorldMap0102', 489, 310],
		['Partem', 'WorldMap0103', 301, 309],
	] as const
	const link = (toolTip: string | null, linksTo: string, x: number, y: number) => ({
		toolTip,
		linksTo,
		linkImage: { image: 'fixture', origin: { x: baseOrigin.x - x, y: baseOrigin.y - y } },
	})
	const node = (id: string, parentWorld: string | null, links: GameWorldMap['links'], origin = baseOrigin, maps: GameWorldMap['maps'] = []): GameWorldMap => ({
		id,
		worldMapName: id,
		parentWorld,
		baseImages: [{ image: 'fixture', origin }],
		links,
		maps,
		mapNumbers: maps.flatMap(map => map.mapNumbers),
	})
	const nodes = [
		node('WorldMap', null, [link('Victoria Island', 'WorldMap010', 1, 1)]),
		node('WorldMap010', 'WorldMap', victoriaTargets.map(([label, target, x, y]) => link(label, target, x, y))),
		node('GWorldMap', null, [link('Western Grandis', 'WGWorldMap', 10, 10), link('Central Grandis', 'CGWorldMap', 20, 20), link('Eastern Grandis', 'EGWorldMap', 30, 30)]),
		node('WGWorldMap', 'GWorldMap', [link('Cernium', 'WorldMap230', 40, 40), link('Burning Cernium', 'WorldMap240', 50, 50), link('WorldMap 290', 'WorldMap290', 60, 60), link(null, 'WorldMap290', 70, 70)]),
		node('WorldMap230', 'WGWorldMap', [], { x: 320, y: 235 }, [{ spot: { x: -2, y: -3 }, type: 1, mapNumbers: ['410000500', '410000501'] }]),
		node('WorldMap240', 'WGWorldMap', []),
		node('WorldMap290', 'WGWorldMap', []),
	] satisfies GameWorldMap[]
	return {
		acquired: {
			provider: 'maplestory-io',
			region: 'GMS',
			version: 270,
			apiBase: 'https://maplestory.io/api',
			roots: ['WorldMap', 'GWorldMap'],
			nodes,
			maps: [{ id: '410000500', name: 'Cernium Square', streetName: 'Cernium', mapMark: 'Cernium', backgroundMusic: 'Bgm57/Cernium Square' }],
		},
		catalog: [{ filename: 'Cernium Square', source: { structure: 'Bgm57' } }],
	}
}

function graphAssets(acquired: AcquiredWorldMapGraph) {
	return {
		baseImages: new Map(acquired.nodes.map(node => [node.id, [{ file: `world-map/test/${node.id}-base.png`, width: 640, height: 470, sha1: '0'.repeat(40), origin: node.baseImages[0]!.origin }]])),
		linkImages: new Map(acquired.nodes.map(node => [node.id, node.links.map((link, index) => link.linkImage == null ? null : ({ file: `world-map/test/${node.id}-link-${index}.png`, width: 20, height: 20, sha1: '0'.repeat(40), origin: link.linkImage.origin }))])),
	}
}

test('separates bounded preview planning from uncapped full planning', () => {
	const preview = createWorldMapGenerationPlan('preview')
	const full = createWorldMapGenerationPlan('full')
	assert.equal(preview.previewMapDetailLimit, 32)
	assert.equal(preview.localizationUsesBulkMapList, false)
	assert.equal(preview.localizeAllGraphMaps, false)
	assert.equal(full.previewMapDetailLimit, null)
	assert.equal(full.localizationUsesBulkMapList, true)
	assert.equal(full.localizeAllGraphMaps, true)
	assert.equal(full.localizeAllLinkBearingWorldMaps, true)
	assert.equal(parseGenerationMode([]), 'preview')
	assert.equal(parseGenerationMode(['--mode=full']), 'full')
	assert.throws(() => parseGenerationMode(['--mode=everything']), /Invalid world-map generation mode/)
})

test('parses the sampled world-map source shape', () => {
	assert.equal(WORLD_MAP_SCHEMA_VERSION, 6)
	const wikitext = VICTORIA_ISLAND_FIXTURE.mapSourceWikitext
	assert.equal(parseBaseImage(wikitext), 'WorldMap Victoria Island.png')
	assert.equal(parsePoints(wikitext).length, 111)
	assert.equal(parseBgmKeys('|bgm=FloralLife<br>Nightmare').length, 2)
	assert.equal(extractMapIconToken(VICTORIA_ISLAND_FIXTURE.targetPages.get('ramuramu valley')?.revisions?.[0]?.content ?? ''), 'Ramuramu')
	assert.equal(extractMapIconToken(VICTORIA_ISLAND_FIXTURE.targetPages.get('ellinel fairy academy')?.revisions?.[0]?.content ?? ''), 'fairyAcademy')
})

test('normalizes and validates Victoria Island baseline', async () => {
	const result = await normalizeAndValidate(VICTORIA_ISLAND_FIXTURE)
	try {
		const landmarks = result.normalized.world.landmarks
		assert.equal(landmarks.length, 111)
		assert.equal(landmarks.filter(landmark => landmark.bgm.sourceKeys.length > 0).length, 102)
		assert.equal(landmarks.flatMap(landmark => landmark.bgm.sourceKeys).length, 102)
		assert.equal(landmarks.flatMap(landmark => landmark.bgm.unmappedKeys).length, 0)
		assert.equal(landmarks.filter(landmark => landmark.target.mapId === '104020100').length, 2)
		assert.deepEqual(
			landmarks.filter(landmark => landmark.target.mapId === '104020100').map(landmark => landmark.id)
				.sort(),
			['map:104020100~221-164', 'map:104020100~280-185'],
		)
		assert.ok(landmarks.filter(landmark => landmark.target.mapId === '104020100').every(landmark => landmark.target.worldMapId === 'WorldMap010' && landmark.target.mapMark === 'SixPath'))
		assert.deepEqual(
			landmarks.filter(landmark => landmark.kind === 'region').map(landmark => landmark.id),
			[
				'region:world-map:WorldMap011',
				'region:world-map:WorldMap012',
				'region:world-map:WorldMap017',
				'region:world-map:WorldMap018',
				'region:world-map:WorldMap019',
				'region:world-map:WorldMap0101',
				'region:world-map:WorldMap0102',
				'region:world-map:WorldMap0103',
				'region:unresolved:358-409',
			],
		)
		const sleepywood = landmarks.find(landmark => landmark.target.pageTitle === 'Sleepywood')!
		assert.equal(sleepywood.target.worldMapId, 'WorldMap012')
		assert.equal(sleepywood.target.mapMark, 'Dungeon')
		const ramuramu = landmarks.find(landmark => landmark.target.pageTitle === 'Ramuramu Valley')!
		assert.equal(ramuramu.target.worldMapId, null)
		assert.equal(ramuramu.target.mapMark, 'Ramuramu')
		assert.equal(ramuramu.identity, 'unresolved')
		assert.equal(result.normalized.world.gameData?.version, 270)
		assert.equal(result.normalized.world.source.revisionId, 480276)
		assert.equal(result.normalized.world.source.revisionTimestamp, '2026-01-18T06:01:19Z')
		assert.equal(result.normalized.warnings.length, 0)
	}
	finally {
		await rm(result.assetRoot, { recursive: true, force: true })
	}
})

test('normalizes and validates Cernium baseline', async () => {
	const result = await normalizeAndValidate(CERNIUM_FIXTURE)
	try {
		const landmarks = result.normalized.world.landmarks
		assert.equal(landmarks.length, 29)
		assert.equal(landmarks.filter(landmark => landmark.bgm.sourceKeys.length > 0).length, 28)
		assert.equal(landmarks.flatMap(landmark => landmark.bgm.sourceKeys).length, 28)
		assert.equal(landmarks.flatMap(landmark => landmark.bgm.unmappedKeys).length, 0)
		const burning = landmarks.find(landmark => landmark.target.pageTitle === 'Burning Cernium')!
		assert.equal(burning.target.worldMapId, 'WorldMap240')
		assert.equal(burning.target.mapMark, 'Cernium_After')
		assert.equal(burning.identity, 'world-map')
		assert.equal(result.normalized.warnings.length, 0)
	}
	finally {
		await rm(result.assetRoot, { recursive: true, force: true })
	}
})

test('selects an exact GMS map BGM and records Wiki corroboration', () => {
	const world = normalizeFixture(VICTORIA_ISLAND_FIXTURE)
	const henesys = world.landmarks.find(landmark => landmark.target.mapId === '100000000')!
	assert.deepEqual(henesys.gameBgm, {
		path: 'Bgm00/FloralLife',
		structure: 'Bgm00',
		filename: 'FloralLife',
		trackId: 'FloralLife',
	})
	assert.deepEqual(henesys.selection, { trackId: 'FloralLife', source: 'gms-map-bgm' })
	assert.deepEqual(henesys.bgm.reconciliation, { status: 'agree', wikiTrackIds: ['FloralLife'] })
})

test('GMS wins over contradictory Wiki BGM and exposes reconciliation warning', () => {
	const page = VICTORIA_ISLAND_FIXTURE.targetPages.get('henesys (map)')!
	const content = page.revisions![0]!.content.replace('|bgm=FloralLife', '|bgm=Nightmare')
	const normalized = normalizeWorldMap(acquired(withTargetContent(VICTORIA_ISLAND_FIXTURE, 'Henesys (Map)', content)), {
		assetPathByFile: new Map([[VICTORIA_ISLAND_FIXTURE.baseImageFile, VICTORIA_ISLAND_FIXTURE.assetFile]]),
		catalog: VICTORIA_ISLAND_FIXTURE.catalog,
	})
	const henesys = normalized.world.landmarks.find(landmark => landmark.target.mapId === '100000000')!
	assert.deepEqual(henesys.selection, { trackId: 'FloralLife', source: 'gms-map-bgm' })
	assert.deepEqual(henesys.bgm.reconciliation, { status: 'disagree', wikiTrackIds: ['Nightmare'] })
	assert.ok(normalized.warnings.some(warning => warning.includes('Wiki BGM disagrees') && warning.includes('Henesys (Map)')))
})

test('does not Wiki-fallback a numeric map when its GMS BGM is unmapped', () => {
	const gameData = structuredClone(VICTORIA_ISLAND_FIXTURE.gameData)
	gameData.maps.find(map => map.id === '100000000')!.backgroundMusic = 'Bgm00/NotInCatalog'
	const normalized = normalizeWorldMap(acquired({ ...VICTORIA_ISLAND_FIXTURE, gameData }), {
		assetPathByFile: new Map([[VICTORIA_ISLAND_FIXTURE.baseImageFile, VICTORIA_ISLAND_FIXTURE.assetFile]]),
		catalog: VICTORIA_ISLAND_FIXTURE.catalog,
	})
	const henesys = normalized.world.landmarks.find(landmark => landmark.target.mapId === '100000000')!
	assert.deepEqual(henesys.selection, { trackId: null, source: null })
	assert.deepEqual(henesys.gameBgm, {
		path: 'Bgm00/NotInCatalog',
		structure: 'Bgm00',
		filename: 'NotInCatalog',
		trackId: null,
	})
	assert.equal(henesys.bgm.reconciliation.status, 'gms-unmapped')
	assert.ok(normalized.warnings.some(warning => warning.includes('canonical selection remains null')))
})

test('uses a unique Wiki track only as a map-less region fallback', () => {
	const page = VICTORIA_ISLAND_FIXTURE.targetPages.get('nautilus')!
	const content = `${page.revisions![0]!.content}\n|bgm=FloralLife`
	const world = normalizeFixture(withTargetContent(VICTORIA_ISLAND_FIXTURE, 'Nautilus', content))
	const nautilus = world.landmarks.find(landmark => landmark.target.pageTitle === 'Nautilus')!
	assert.equal(nautilus.target.mapId, null)
	assert.deepEqual(nautilus.selection, { trackId: 'FloralLife', source: 'wiki' })
	assert.equal(nautilus.bgm.reconciliation.status, 'wiki-fallback')
})

test('does not turn mapMark grouping into a music selection', () => {
	const page = VICTORIA_ISLAND_FIXTURE.targetPages.get('nautilus')!
	const content = page.revisions![0]!.content.replace(/^\s*\|bgm=.*$/gim, '')
	const world = normalizeFixture({
		...withTargetContent(VICTORIA_ISLAND_FIXTURE, 'Nautilus', content),
		catalog: [...VICTORIA_ISLAND_FIXTURE.catalog, { filename: 'NautilusAlt', mark: 'Nautilus' }, { filename: 'NautilusOther', mark: 'Nautilus' }],
	})
	const nautilus = world.landmarks.find(landmark => landmark.target.pageTitle === 'Nautilus')!
	assert.equal(nautilus.target.mapMark, 'Nautilus')
	assert.deepEqual(nautilus.selection, { trackId: null, source: null })
})

test('duplicate visual hotspots for one map share the same selected track', () => {
	const world = normalizeFixture(VICTORIA_ISLAND_FIXTURE)
	const hotspots = world.landmarks.filter(landmark => landmark.target.mapId === '104020100')
	assert.equal(hotspots.length, 2)
	assert.deepEqual(new Set(hotspots.map(landmark => landmark.selection.trackId)), new Set(['CavaBien']))
	assert.ok(hotspots.every(landmark => landmark.selection.source === 'gms-map-bgm'))
})

test('parses BGM paths by exact structure and filename and validates catalog uniqueness', () => {
	assert.deepEqual(parseGameBgmPath('Bgm00/FloralLife'), { path: 'Bgm00/FloralLife', structure: 'Bgm00', filename: 'FloralLife' })
	assert.equal(parseGameBgmPath('Bgm00/FloralLife/extra'), null)
	assert.equal(parseGameBgmPath('Bgm00 /FloralLife'), null)
	const exact = buildCatalogIndex([
		{ filename: 'FloralLife', source: { structure: 'Bgm00' } },
		{ filename: 'FloralLife', source: { structure: 'Bgm01' } },
	])
	assert.equal(gameBgmCatalogMatch(exact, parseGameBgmPath('Bgm00/FloralLife')!), 'FloralLife')
	assert.deepEqual(exact.duplicateWikiKeys, ['FloralLife'])
	const ambiguousPath = buildCatalogIndex([
		{ filename: 'Same', source: { structure: 'Bgm00' } },
		{ id: 'Other', source: { structure: 'Bgm00', filename: 'Same' } },
	])
	assert.equal(gameBgmCatalogMatch(ambiguousPath, parseGameBgmPath('Bgm00/Same')!), null)
	assert.deepEqual(ambiguousPath.duplicateGamePaths, ['Bgm00\u0000Same'])
})

test('keeps unmapped BGM keys explicit without guessing', async () => {
	const fixture = { ...CERNIUM_FIXTURE, catalog: CERNIUM_FIXTURE.catalog.filter(item => item.filename !== 'RedMoon') }
	const source = acquired(fixture)
	const normalized = normalizeWorldMap(source, {
		assetPathByFile: new Map([[fixture.baseImageFile, fixture.assetFile]]),
		catalog: fixture.catalog,
	})
	assert.equal(normalized.world.landmarks.flatMap(landmark => landmark.bgm.unmappedKeys).length, 1)
	assert.ok(normalized.warnings.every(warning => warning.includes('RedMoon')))
})

test('joins Wiki region labels through game-native links and preserves unresolved editorial links', () => {
	const normalized = normalizeWorldMap(acquired(VICTORIA_ISLAND_FIXTURE), {
		assetPathByFile: new Map([[VICTORIA_ISLAND_FIXTURE.baseImageFile, VICTORIA_ISLAND_FIXTURE.assetFile]]),
		catalog: VICTORIA_ISLAND_FIXTURE.catalog,
	}).world
	const elodin = normalized.landmarks.find(landmark => landmark.target.pageTitle === 'Elodin')!
	assert.equal(elodin.target.worldMapId, 'WorldMap0102')
	assert.equal(elodin.target.mapMark, 'Elodin')
	const ramuramu = normalized.landmarks.find(landmark => landmark.target.pageTitle === 'Ramuramu Valley')!
	assert.equal(ramuramu.target.worldMapId, null)
	assert.equal(ramuramu.target.mapMark, 'Ramuramu')
})

test('does not derive canonical mapMark from maplebgm-db catalog data', () => {
	const gameData = structuredClone(VICTORIA_ISLAND_FIXTURE.gameData)
	gameData.maps = gameData.maps.filter(map => map.id !== '160070000')
	const fixture = { ...VICTORIA_ISLAND_FIXTURE, gameData, catalog: [...VICTORIA_ISLAND_FIXTURE.catalog, { filename: 'catalog-only', mark: 'Ramuramu Valley' }] }
	const normalized = normalizeWorldMap(acquired(fixture), {
		assetPathByFile: new Map([[fixture.baseImageFile, fixture.assetFile]]),
		catalog: fixture.catalog,
	}).world
	const ramuramu = normalized.landmarks.find(landmark => landmark.target.pageTitle === 'Ramuramu Valley')!
	assert.equal(ramuramu.target.mapMark, null)
})

function withoutRamuramuDetail(): AcquiredWorldMapSource {
	const fixture = { ...VICTORIA_ISLAND_FIXTURE, gameData: structuredClone(VICTORIA_ISLAND_FIXTURE.gameData) }
	fixture.gameData.maps = fixture.gameData.maps.filter(map => map.id !== '160070000')
	return acquired(fixture)
}

function enrichmentClient(
	search: (token: string) => Promise<Array<{ id: string, name: string | null, streetName: string | null }>>,
	fetchMap: (id: string) => Promise<{ id: string, mapMark: string | null, name: string | null, streetName: string | null }>,
): MapleStoryIoClient {
	return { searchMaps: async (_region: string, _version: number, token: string) => search(token), fetchMap: async (_region: string, _version: number, id: string) => fetchMap(id) } as unknown as MapleStoryIoClient
}

test('enriches Ramuramu mapMark only from unique GMS search/topology/detail evidence', async () => {
	const source = withoutRamuramuDetail()
	const searched: string[] = []
	const client = enrichmentClient(async (token) => {
		searched.push(token)
		return token === 'Ramuramu'
			? [
					{ id: '160000000', name: 'Guardian Angel Slime Altar', streetName: 'Ramuramu Valley' },
					{ id: '160070000', name: 'Ramuramu Hot Springs', streetName: 'Ramuramu Valley' },
				]
			: []
	}, async id => ({ id, mapMark: 'Ramuramu', name: 'Ramuramu Hot Springs', streetName: 'Ramuramu Valley' }))
	const enriched = await enrichCanonicalMapDetails(client, source)
	assert.ok(searched.includes('Ramuramu'))
	const normalized = normalizeWorldMap({ ...source, gameData: enriched.gameData }, {
		assetPathByFile: new Map([[VICTORIA_ISLAND_FIXTURE.baseImageFile, VICTORIA_ISLAND_FIXTURE.assetFile]]),
		catalog: VICTORIA_ISLAND_FIXTURE.catalog,
	}).world
	const ramuramu = normalized.landmarks.find(landmark => landmark.target.pageTitle === 'Ramuramu Valley')!
	assert.equal(ramuramu.target.mapMark, 'Ramuramu')
	assert.equal(ramuramu.target.worldMapId, null)
	assert.equal(ramuramu.identity, 'unresolved')
})

test('leaves mapMark null for zero, failed, ambiguous, or mark-less enrichment evidence', async () => {
	const cases = [
		{
			name: 'zero search',
			search: async () => [],
			fetchMap: async (id: string) => ({ id, mapMark: 'should-not-be-used', name: 'Ramuramu Hot Springs', streetName: 'Ramuramu Valley' }),
			warning: /no candidates/,
		},
		{
			name: 'failed search',
			search: async () => { throw new Error('search unavailable') },
			fetchMap: async (id: string) => ({ id, mapMark: 'should-not-be-used', name: 'Ramuramu Hot Springs', streetName: 'Ramuramu Valley' }),
			warning: /search unavailable/,
		},
		{
			name: 'ambiguous topology intersection',
			search: async () => [
				{ id: '100000000', name: 'Henesys', streetName: 'Ramuramu Valley' },
				{ id: '160070000', name: 'Ramuramu Hot Springs', streetName: 'Ramuramu Valley' },
			],
			fetchMap: async (id: string) => ({ id, mapMark: 'should-not-be-used', name: 'Ramuramu Hot Springs', streetName: 'Ramuramu Valley' }),
			warning: /2 topology intersections/,
		},
		{
			name: 'marker token without canonical mapMark',
			search: async () => [{ id: '160070000', name: 'Ramuramu Hot Springs', streetName: 'Ramuramu Valley' }],
			fetchMap: async (id: string) => ({ id, mapMark: null, name: 'Ramuramu Hot Springs', streetName: 'Ramuramu Valley' }),
			warning: /lacks exact region evidence or mapMark/,
		},
	]
	for (const current of cases) {
		const source = withoutRamuramuDetail()
		source.points = source.points.filter(point => !point.target.includes('Ellinel'))
		const enriched = await enrichCanonicalMapDetails(enrichmentClient(current.search, current.fetchMap), source)
		assert.match(enriched.warnings.join('\n'), current.warning, current.name)
		const normalized = normalizeWorldMap({ ...source, gameData: enriched.gameData }, {
			assetPathByFile: new Map([[VICTORIA_ISLAND_FIXTURE.baseImageFile, VICTORIA_ISLAND_FIXTURE.assetFile]]),
			catalog: VICTORIA_ISLAND_FIXTURE.catalog,
		}).world
		const ramuramu = normalized.landmarks.find(landmark => landmark.target.pageTitle === 'Ramuramu Valley')!
		assert.equal(ramuramu.target.mapMark, null, current.name)
	}
})

test('does not use substring title matching without deterministic game evidence', () => {
	const gameData = structuredClone(VICTORIA_ISLAND_FIXTURE.gameData)
	gameData.maps = gameData.maps.filter(map => map.id !== '101080900')
	gameData.worldMaps = gameData.worldMaps.map(worldMap => worldMap.id === 'WorldMap010'
		? { ...worldMap, links: worldMap.links.map(link => link.linksTo === 'WorldMap0102' ? { ...link, toolTip: 'The Elodin Area' } : link) }
		: worldMap)
	const fixture = { ...VICTORIA_ISLAND_FIXTURE, gameData }
	const normalized = normalizeWorldMap(acquired(fixture), {
		assetPathByFile: new Map([[fixture.baseImageFile, fixture.assetFile]]),
		catalog: fixture.catalog,
	}).world
	const elodin = normalized.landmarks.find(landmark => landmark.target.pageTitle === 'Elodin')!
	assert.equal(elodin.target.worldMapId, null)
	assert.equal(elodin.identity, 'unresolved')
})

test('adds and validates localized names only through canonical numeric IDs', async () => {
	const result = await normalizeAndValidate(VICTORIA_ISLAND_FIXTURE)
	try {
		const localized = localizeWorldMap(result.normalized.world, LOCALIZATION_FIXTURES)
		await validateWorldMapIndex({ ...result.index, worlds: [localized] }, {
			assetRoot: result.assetRoot,
			bgmIds: new Set(VICTORIA_ISLAND_FIXTURE.catalog.map(item => item.filename)),
		})
		const henesys = localized.landmarks.find(landmark => landmark.target.mapId === '100000000')!
		assert.equal(henesys.target.name, 'Henesys')
		assert.equal(henesys.target.localizedNames['ko-KR']?.name, '헤네시스')
		assert.equal(henesys.target.localizedNames['zh-TW']?.name, '弓箭手村')
		assert.equal(henesys.target.localizedNames['ko-KR']?.join, 'mapId')
		const nautilus = localized.landmarks.find(landmark => landmark.target.pageTitle === 'Nautilus')!
		assert.equal(nautilus.target.name, 'Nautilus')
		assert.equal(nautilus.target.localizedNames['zh-TW']?.name, '鯨魚號')
		assert.equal(nautilus.target.localizedNames['zh-TW']?.join, 'worldMapId')
		const ramuramu = localized.landmarks.find(landmark => landmark.target.pageTitle === 'Ramuramu Valley')!
		assert.equal(ramuramu.target.name, null)
		assert.equal(ramuramu.target.localizedNames['ko-KR']?.name, null)
		assert.equal(ramuramu.target.localizedNames['ko-KR']?.join, null)
		const unsampledMap = localized.landmarks.find(landmark => landmark.target.mapId != null && landmark.target.mapId !== '100000000')!
		assert.equal(unsampledMap?.target.localizedNames['ko-KR']?.name, null)
	}
	finally {
		await rm(result.assetRoot, { recursive: true, force: true })
	}
})

test('never falls back from a numeric mapId join to worldMapId localization', async () => {
	const result = await normalizeAndValidate(VICTORIA_ISLAND_FIXTURE)
	try {
		const world = structuredClone(result.normalized.world)
		const henesys = world.landmarks.find(landmark => landmark.target.mapId === '100000000')!
		henesys.target.worldMapId = 'WorldMap011'
		const localizedFixture = structuredClone(LOCALIZATION_FIXTURES[0]!)
		localizedFixture.maps = localizedFixture.maps.filter(map => map.id !== '100000000')
		const localized = localizeWorldMap(world, [localizedFixture])
		const name = localized.landmarks.find(landmark => landmark.target.mapId === '100000000')!.target.localizedNames['ko-KR']!
		assert.equal(name.name, null)
		assert.equal(name.join, null)
		name.name = 'incorrect fallback'
		name.join = 'worldMapId'
		await assert.rejects(
			validateWorldMapIndex({ ...result.index, worlds: [localized] }, {
				assetRoot: result.assetRoot,
				bgmIds: new Set(VICTORIA_ISLAND_FIXTURE.catalog.map(item => item.filename)),
			}),
			/despite having a canonical mapId/,
		)
	}
	finally {
		await rm(result.assetRoot, { recursive: true, force: true })
	}
})

test('rejects localized names that violate join invariants', async () => {
	const result = await normalizeAndValidate(VICTORIA_ISLAND_FIXTURE)
	try {
		const localized = localizeWorldMap(result.normalized.world, [LOCALIZATION_FIXTURES[0]!])
		const invalid = structuredClone({ ...result.index, worlds: [localized] })
		const henesys = invalid.worlds[0]!.landmarks.find(landmark => landmark.target.mapId === '100000000')!
		henesys.target.localizedNames['ko-KR']!.name = null
		await assert.rejects(
			validateWorldMapIndex(invalid, { assetRoot: result.assetRoot, bgmIds: new Set(VICTORIA_ISLAND_FIXTURE.catalog.map(item => item.filename)) }),
			/name\/join mismatch/,
		)
	}
	finally {
		await rm(result.assetRoot, { recursive: true, force: true })
	}
})

test('leaves localized names null when a non-GMS world-map ID does not join', () => {
	const normalized = normalizeWorldMap(acquired(VICTORIA_ISLAND_FIXTURE), {
		assetPathByFile: new Map([[VICTORIA_ISLAND_FIXTURE.baseImageFile, VICTORIA_ISLAND_FIXTURE.assetFile]]),
		catalog: VICTORIA_ISLAND_FIXTURE.catalog,
	}).world
	const divergent = structuredClone(LOCALIZATION_FIXTURES[0]!)
	divergent.locale = 'ko-KR-divergent'
	divergent.worldMaps[0]!.links = divergent.worldMaps[0]!.links.map(link => link.linksTo === 'WorldMap011' ? { ...link, linksTo: 'WorldMap099' } : link)
	const localized = localizeWorldMap(normalized, [divergent])
	const nautilus = localized.landmarks.find(landmark => landmark.target.pageTitle === 'Nautilus')!
	assert.equal(nautilus.target.localizedNames['ko-KR-divergent']?.name, null)
	assert.equal(nautilus.target.localizedNames['ko-KR-divergent']?.join, null)
})

test('rejects duplicate locale and conflicting localization joins safely', () => {
	const normalized = normalizeWorldMap(acquired(VICTORIA_ISLAND_FIXTURE), {
		assetPathByFile: new Map([[VICTORIA_ISLAND_FIXTURE.baseImageFile, VICTORIA_ISLAND_FIXTURE.assetFile]]),
		catalog: VICTORIA_ISLAND_FIXTURE.catalog,
	}).world
	assert.throws(() => localizeWorldMap(normalized, [LOCALIZATION_FIXTURES[0]!, LOCALIZATION_FIXTURES[0]!]), /Duplicate or empty localization locale/)
	const duplicateMap = structuredClone(LOCALIZATION_FIXTURES[0]!)
	duplicateMap.locale = 'ko-KR-map-conflict'
	duplicateMap.maps.push({ id: '100000000', name: 'Conflict', streetName: null, mapMark: null, backgroundMusic: null })
	const duplicateLink = structuredClone(LOCALIZATION_FIXTURES[0]!)
	duplicateLink.locale = 'ko-KR-link-conflict'
	duplicateLink.worldMaps[0]!.links.push({ toolTip: 'Conflicting Nautilus', linksTo: 'WorldMap011', linkImage: null })
	const localized = localizeWorldMap(normalized, [duplicateMap, duplicateLink])
	const henesys = localized.landmarks.find(landmark => landmark.target.mapId === '100000000')!
	const nautilus = localized.landmarks.find(landmark => landmark.target.pageTitle === 'Nautilus')!
	assert.equal(henesys.target.localizedNames['ko-KR-map-conflict']?.name, null)
	assert.equal(henesys.target.localizedNames['ko-KR-map-conflict']?.join, null)
	assert.equal(henesys.target.localizedNames['ko-KR-map-conflict']?.source.version, 389)
	assert.equal(nautilus.target.localizedNames['ko-KR-link-conflict']?.name, null)
	assert.equal(nautilus.target.localizedNames['ko-KR-link-conflict']?.join, null)
})

test('fails clearly when the game-data root is absent instead of slugifying a Wiki title', () => {
	const fixture = {
		...CERNIUM_FIXTURE,
		config: {
			...CERNIUM_FIXTURE.config,
			gameWorldMapId: 'WorldMapMissing',
		},
	}
	assert.throws(
		() => normalizeWorldMap(acquired(fixture), {
			assetPathByFile: new Map([[fixture.baseImageFile, fixture.assetFile]]),
			catalog: fixture.catalog,
		}),
		/Game-data snapshot is missing configured root worldMapId "WorldMapMissing"/,
	)
})

test('requires canonical GMS source data and rejects non-GMS source configuration', async () => {
	const result = await normalizeAndValidate(CERNIUM_FIXTURE)
	try {
		const nonGms = structuredClone(result.index)
		nonGms.worlds[0]!.gameData!.region = 'KMS'
		await assert.rejects(
			validateWorldMapIndex(nonGms, { assetRoot: result.assetRoot, bgmIds: new Set(CERNIUM_FIXTURE.catalog.map(item => item.filename)) }),
			/canonical GMS data/,
		)
		assert.throws(
			() => validateWorldMapSourceConfigs([{ ...CERNIUM_FIXTURE.config, gameRegion: 'KMS' } as never]),
			/canonical GMS game data/,
		)
	}
	finally {
		await rm(result.assetRoot, { recursive: true, force: true })
	}
})

test('resolves only latest ready numeric versions and reports missing regions', async () => {
	const client = new MapleStoryIoClient({
		delayMs: 0,
		apiBase: 'https://fixture.example/api',
		fetcher: (async () => [
			{ region: 'GMS', mapleVersionId: '269', isReady: true, hasImages: true },
			{ region: 'GMS', mapleVersionId: '270', isReady: true, hasImages: true },
			{ region: 'GMS', mapleVersionId: '271-preview', isReady: true, hasImages: true },
			{ region: 'GMS', mapleVersionId: '272', isReady: false, hasImages: true },
			{ region: 'KMS', mapleVersionId: '500', isReady: true, hasImages: true },
		]) as never,
	})
	assert.equal(client.apiBase, 'https://fixture.example/api')
	assert.equal(await client.resolveLatestReadyVersion('GMS'), 270)
	await assert.rejects(client.resolveLatestReadyVersion('EMS'), /no ready numeric EMS version/)
})

test('captures game-native backgroundMusic from map detail responses', async () => {
	const client = new MapleStoryIoClient({
		delayMs: 0,
		apiBase: 'https://fixture.example/api',
		fetcher: (async () => ({
			id: 100000000,
			mapMark: 'Henesys',
			name: 'Henesys',
			streetName: 'Henesys',
			backgroundMusic: 'Bgm00/FloralLife',
		})) as never,
	})
	assert.deepEqual(await client.fetchMap('GMS', 270, '100000000'), {
		id: '100000000',
		mapMark: 'Henesys',
		name: 'Henesys',
		streetName: 'Henesys',
		backgroundMusic: 'Bgm00/FloralLife',
	})
})

test('retries transient MapleStory.IO failures but not malformed successful payloads', async () => {
	let transientCalls = 0
	const transientClient = new MapleStoryIoClient({
		delayMs: 0,
		timeoutMs: 50,
		maxRetries: 2,
		retryBackoffMs: 0,
		sleep: async () => {},
		fetcher: (async () => {
			transientCalls++
			if (transientCalls < 3)
				throw Object.assign(new Error('temporary upstream failure'), { status: 503 })
			return [{ region: 'GMS', mapleVersionId: '270', isReady: true, hasImages: true }]
		}) as never,
	})
	assert.equal(await transientClient.resolveLatestReadyVersion('GMS'), 270)
	assert.equal(transientCalls, 3)

	let malformedCalls = 0
	const malformedClient = new MapleStoryIoClient({
		delayMs: 0,
		maxRetries: 2,
		retryBackoffMs: 0,
		sleep: async () => {},
		fetcher: (async () => {
			malformedCalls++
			return { worldMapName: 'WorldMap010', maps: 'not-an-array' }
		}) as never,
	})
	await assert.rejects(malformedClient.fetchWorldMap('GMS', 270, 'WorldMap010'), /malformed world map/)
	assert.equal(malformedCalls, 1)
})

test('times out terminal MapleStory.IO requests after finite retries', async () => {
	let calls = 0
	const client = new MapleStoryIoClient({
		delayMs: 0,
		timeoutMs: 1,
		maxRetries: 1,
		retryBackoffMs: 0,
		sleep: async () => {},
		fetcher: (async () => {
			calls++
			return new Promise(resolve => setTimeout(() => resolve([]), 20))
		}) as never,
	})
	await assert.rejects(client.resolveLatestReadyVersion('GMS'), /Request timed out/)
	assert.equal(calls, 2)
})

test('retries transient image download failures with injectable timing', async () => {
	const outputRoot = await mkdtemp(path.join(tmpdir(), 'world-map-image-retry-'))
	try {
		const bytes = VICTORIA_ISLAND_FIXTURE.baseImageBytes
		const info = VICTORIA_ISLAND_FIXTURE.imageInfoByFile.get(VICTORIA_ISLAND_FIXTURE.baseImageFile)!
		let calls = 0
		await downloadVerifiedImage(VICTORIA_ISLAND_FIXTURE.baseImageFile, info, outputRoot, {
			delayMs: 0,
			timeoutMs: 50,
			maxRetries: 1,
			retryBackoffMs: 0,
			sleep: async () => {},
			fetcher: (async () => {
				calls++
				if (calls === 1)
					throw Object.assign(new Error('temporary image failure'), { status: 503 })
				return {
					ok: true,
					status: 200,
					arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
				}
			}) as never,
		})
		assert.equal(calls, 2)
	}
	finally {
		await rm(outputRoot, { recursive: true, force: true })
	}
})

test('keeps canonical generation viable when optional localization acquisition fails', async () => {
	const fakeClient = {
		apiBase: 'https://custom.example/api',
		resolveLatestReadyVersion: async () => { throw new Error('fixture locale API unavailable') },
	} as unknown as MapleStoryIoClient
	const acquiredLocalization = await acquireLocalizationAttempts(fakeClient, [{ locale: 'ko-KR', region: 'KMS' }], [], [])
	assert.match(acquiredLocalization.warnings[0]!, /fixture locale API unavailable/)
	assert.equal(acquiredLocalization.attempts[0]!.snapshot, null)
	assert.equal(acquiredLocalization.attempts[0]!.source.apiBase, 'https://custom.example/api')
	const result = await normalizeAndValidate(VICTORIA_ISLAND_FIXTURE)
	try {
		const localized = localizeWorldMap(result.normalized.world, acquiredLocalization.attempts)
		await validateWorldMapIndex({ ...result.index, worlds: [localized] }, {
			assetRoot: result.assetRoot,
			bgmIds: new Set(VICTORIA_ISLAND_FIXTURE.catalog.map(item => item.filename)),
		})
		assert.equal(localized.landmarks[0]!.target.localizedNames['ko-KR']?.status, 'unavailable')
		assert.equal(localized.landmarks[0]!.target.localizedNames['ko-KR']?.name, null)
	}
	finally {
		await rm(result.assetRoot, { recursive: true, force: true })
	}
})

test('rejects invalid references and image integrity failures', async () => {
	const result = await normalizeAndValidate(CERNIUM_FIXTURE)
	try {
		const invalid = structuredClone(result.index)
		invalid.worlds[0]!.landmarks[0]!.target.mapId = 'not-a-map-id'
		await assert.rejects(
			validateWorldMapIndex(invalid, { assetRoot: result.assetRoot, bgmIds: new Set(CERNIUM_FIXTURE.catalog.map(item => item.filename)) }),
			/non-numeric mapId/,
		)
		const mismatched = structuredClone(result.index)
		mismatched.worlds[0]!.image.sha1 = '0'.repeat(40)
		await assert.rejects(
			validateWorldMapIndex(mismatched, { assetRoot: result.assetRoot, bgmIds: new Set(CERNIUM_FIXTURE.catalog.map(item => item.filename)) }),
			/SHA-1 mismatch/,
		)
	}
	finally {
		await rm(result.assetRoot, { recursive: true, force: true })
	}
})

test('rejects contradictory singular music provenance', async () => {
	const result = await normalizeAndValidate(CERNIUM_FIXTURE)
	try {
		const invalid = structuredClone(result.index)
		const square = invalid.worlds[0]!.landmarks.find(landmark => landmark.target.mapId === '410000500')!
		square.bgm.reconciliation.status = 'not-compared'
		await assert.rejects(
			validateWorldMapIndex(invalid, { assetRoot: result.assetRoot, bgmIds: new Set(CERNIUM_FIXTURE.catalog.map(item => item.filename)) }),
			/inconsistent Wiki\/GMS BGM reconciliation status/,
		)
	}
	finally {
		await rm(result.assetRoot, { recursive: true, force: true })
	}
})

test('normalizes all Victoria WZ link origins without collapsing visual links', () => {
	const fixture = graphFixture()
	const graph = normalizeWorldMapGraph(fixture.acquired, graphAssets(fixture.acquired), fixture.catalog)
	const victoria = graph.nodes.find(node => node.worldMapId === 'WorldMap010')!
	assert.deepEqual(victoria.links.map(link => [link.canonicalLabel, link.screenOrigin]), [
		['Nautilus', { x: 407, y: 336 }],
		['Sleepywood', { x: 245, y: 192 }],
		['Ellinel Fairy Academy', { x: 328, y: 170 }],
		['Gold Beach', { x: 558, y: 262 }],
		['Mushroom Castle', { x: 34, y: 343 }],
		['Kerning Tower', { x: 63, y: 190 }],
		['Secret Forest of Elodin', { x: 489, y: 310 }],
		['Partem', { x: 301, y: 309 }],
	])
	const western = graph.nodes.find(node => node.worldMapId === 'WGWorldMap')!
	assert.equal(western.links.filter(link => link.targetWorldMapId === 'WorldMap290').length, 2)
	assert.equal(western.links.find(link => link.canonicalLabel === null)?.targetWorldMapId, 'WorldMap290')
})

test('preserves native spot coordinates, grouped mapNumbers, and exact gameBgm selection', () => {
	const fixture = graphFixture()
	const graph = normalizeWorldMapGraph(fixture.acquired, graphAssets(fixture.acquired), fixture.catalog)
	const square = graph.nodes.find(node => node.worldMapId === 'WorldMap230')!.spots[0]!
	assert.deepEqual(square.point, { x: 318, y: 232, normalizedX: 0.496875, normalizedY: 0.493617 })
	assert.deepEqual(square.mapNumbers, ['410000500', '410000501'])
	assert.equal(square.maps.length, 2)
	assert.deepEqual(square.maps[0]!.selection, { trackId: 'Cernium Square', source: 'gms-map-bgm' })
	assert.equal(square.maps[0]!.mapMark, 'Cernium')
	assert.equal(square.maps[1]!.name, null)
})

test('keeps multiple native roots and prevents localization from changing topology', () => {
	const fixture = graphFixture()
	const graph = normalizeWorldMapGraph(fixture.acquired, graphAssets(fixture.acquired), fixture.catalog)
	const localized = localizeWorldMapGraph(graph, [LOCALIZATION_FIXTURES[0]!])
	assert.deepEqual(localized.roots, ['WorldMap', 'GWorldMap'])
	assert.deepEqual(localized.nodes.map(node => [node.worldMapId, node.parentWorldMapId]), [
		['WorldMap', null],
		['WorldMap010', 'WorldMap'],
		['GWorldMap', null],
		['WGWorldMap', 'GWorldMap'],
		['WorldMap230', 'WGWorldMap'],
		['WorldMap240', 'WGWorldMap'],
		['WorldMap290', 'WGWorldMap'],
	])
	const duplicateLinks = localized.nodes.find(node => node.worldMapId === 'WGWorldMap')!.links.filter(link => link.targetWorldMapId === 'WorldMap290')
	assert.equal(duplicateLinks.length, 2)
	assert.equal(duplicateLinks[1]!.canonicalLabel, null)
	assert.equal(duplicateLinks[1]!.id, 'link-3')
	assert.equal(localized.nodes.find(node => node.worldMapId === 'WorldMap230')!.spots[0]!.maps[0]!.localizedNames['ko-KR']?.name, '세르니움 광장')
})
