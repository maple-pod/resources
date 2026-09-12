/* eslint-disable test/no-import-node-test */
import type { AcquiredWorldMapGraph } from '../world-map/acquire'
import type { RawWzImageNode } from '../world-map/raw-wz'
import type { AcquiredWorldMapSource, GameMapDetail, GameWorldMap } from '../world-map/source'
import type { WorldMapSampleFixture } from './fixtures/world-map-samples'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { acquireWorldMapGraph, downloadVerifiedImage, MapleStoryIoClient, MapleStoryIoRequestError, WikiClient, worldMapStringKey } from '../world-map/acquire'
import { enrichCanonicalMapDetails } from '../world-map/enrich'
import { acquireLocalizationAttempts, createWorldMapGenerationPlan, parseGenerationMode, parseGenerationSnapshot, publishFullSnapshot, resolveWorldMapGenerationSnapshot, runWorldMapGeneration, validateWorldMapSourceConfigs } from '../world-map/generate'
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
			version: '270',
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
	assert.deepEqual(parseGenerationSnapshot([]), { region: 'GMS', version: '270' })
	assert.deepEqual(parseGenerationSnapshot(['--snapshot=TWMS/209']), { region: 'TWMS', version: '209' })
	assert.deepEqual(parseGenerationSnapshot(['--snapshot=GMS/latest']), { region: 'GMS', version: 'latest' })
})

test('resolves logical snapshots to exact MapleStory.IO provider identities', async () => {
	const fetcher = (async (url: string) => {
		assert.ok(url.endsWith('/wz'))
		return [
			{ region: 'TMS', mapleVersionId: '209', isReady: true, hasImages: true },
			{ region: 'TWMS', mapleVersionId: '255', isReady: true, hasImages: true },
			{ region: 'TWMS', mapleVersionId: '256', isReady: true, hasImages: true },
		]
	}) as typeof import('ofetch').ofetch
	const client = new MapleStoryIoClient({ fetcher, delayMs: 0, timeoutMs: 0 })
	assert.deepEqual(await resolveWorldMapGenerationSnapshot(client, { region: 'TWMS', version: '209' }), {
		id: 'TWMS/209',
		region: 'TWMS',
		version: '209',
		provider: 'maplestory-io',
		providerRegion: 'TMS',
	})
	assert.deepEqual(await resolveWorldMapGenerationSnapshot(client, { region: 'TWMS', version: 'latest' }), {
		id: 'TWMS/256',
		region: 'TWMS',
		version: '256',
		provider: 'maplestory-io',
		providerRegion: 'TWMS',
	})
	await assert.rejects(resolveWorldMapGenerationSnapshot(client, { region: 'TWMS', version: '157' }), /archived-WZ provider is required/)
	await assert.rejects(resolveWorldMapGenerationSnapshot(client, { region: 'TWMS', version: '171' }, undefined, { workspace: '/nonexistent' }), /Archived WZ generation for TWMS\/171 requires cached String\.wz/)
	assert.deepEqual(await resolveWorldMapGenerationSnapshot(client, { region: 'TWMS', version: '171' }), {
		id: 'TWMS/171',
		region: 'TWMS',
		version: '171',
		provider: 'archived-wz',
		providerRegion: 'TWMS',
	})

	const tmsOnly = new MapleStoryIoClient({
		delayMs: 0,
		timeoutMs: 0,
		fetcher: (async () => [{ region: 'TMS', mapleVersionId: '209', isReady: true, hasImages: true }]) as never,
	})
	assert.deepEqual(await resolveWorldMapGenerationSnapshot(tmsOnly, { region: 'TWMS', version: 'latest' }), {
		id: 'TWMS/209',
		region: 'TWMS',
		version: '209',
		provider: 'maplestory-io',
		providerRegion: 'TMS',
	})
})

test('historical GMS generation defaults to native snapshot data without current Wiki/localization coupling', async () => {
	const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/6FA9WQAAAABJRU5ErkJggg=='
	class HistoricalClient extends MapleStoryIoClient {
		override async hasReadyVersion(): Promise<boolean> { return true }
		override async listWorldMapIds(): Promise<string[]> { return ['WorldMap'] }
		override async fetchWorldMap(_region: string, _version: string, id: string): Promise<GameWorldMap> {
			assert.equal(id, 'WorldMap')
			return { id, worldMapName: id, parentWorld: null, links: [], baseImages: [{ image, origin: { x: 0, y: 0 } }], maps: [], mapNumbers: [] }
		}

		override async fetchWorldMapNames(): Promise<Record<string, string>> { return { WorldMap: 'Maple World' } }
	}
	const root = await mkdtemp(path.join(tmpdir(), 'world-map-historical-gms-'))
	try {
		const catalogSource = path.join(root, 'catalog-source.json')
		await writeFile(catalogSource, '[]\n')
		const wiki = new WikiClient({
			delayMs: 0,
			fetcher: (async () => { throw new Error('historical GMS preview must not query current Wiki sources by default') }) as never,
		})
		const result = await runWorldMapGeneration({
			mode: 'preview',
			snapshot: { region: 'GMS', version: '93' },
			outputDir: root,
			catalogSource,
			client: wiki,
			gameClient: new HistoricalClient({ delayMs: 0 }),
			generatedAt: '2026-09-10T00:00:00.000Z',
		})
		assert.equal(result.snapshotId, 'GMS/93')
		assert.deepEqual(result.worldSummaries, [])
		const manifest = JSON.parse(await readFile(path.join(root, 'world-map-preview/snapshots/GMS/93/manifest.json'), 'utf8')) as { source: { region: string, version: string }, nodeCount: number }
		assert.deepEqual(manifest.source.region, 'GMS')
		assert.equal(manifest.source.version, '93')
		assert.equal(manifest.nodeCount, 1)
	}
	finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('writes exact TWMS snapshot resources without publishing a misleading unversioned alias', async () => {
	const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/6FA9WQAAAABJRU5ErkJggg=='
	class FixtureClient extends MapleStoryIoClient {
		override async hasReadyVersion(): Promise<boolean> {
			return true
		}

		override async fetchWorldMap(_region: string, _version: string, id: string): Promise<GameWorldMap> {
			return {
				id,
				worldMapName: id,
				parentWorld: null,
				links: [],
				baseImages: [{ image, origin: { x: 0, y: 0 } }],
				maps: [],
				mapNumbers: [],
			}
		}

		override async fetchWorldMapNames(): Promise<Record<string, string>> {
			return { WorldMap: '楓之谷' }
		}
	}
	const root = await mkdtemp(path.join(tmpdir(), 'world-map-snapshot-generation-'))
	try {
		const catalogSource = path.join(root, 'catalog-source.json')
		await writeFile(catalogSource, '[]\n')
		const result = await runWorldMapGeneration({
			mode: 'preview',
			snapshot: { region: 'TWMS', version: '209' },
			outputDir: root,
			catalogSource,
			gameClient: new FixtureClient({ delayMs: 0 }),
			generatedAt: '2026-09-10T00:00:00.000Z',
		})
		assert.equal(result.snapshotId, 'TWMS/209')
		const manifest = JSON.parse(await readFile(path.join(root, 'world-map-preview/snapshots/TWMS/209/manifest.json'), 'utf8')) as { source: { region: string, logicalRegion?: string }, assets: { root: string, canonicalImagePath: string, nativeWz: { pathPrefix: string } } }
		assert.equal(manifest.source.region, 'TMS')
		assert.equal(manifest.source.logicalRegion, 'TWMS')
		assert.equal(manifest.assets.root, 'world-map-preview')
		assert.equal(manifest.assets.canonicalImagePath, 'world-map-preview/images')
		assert.equal(manifest.assets.nativeWz.pathPrefix, 'world-map-preview/snapshots/TWMS/209/assets')
		const catalog = JSON.parse(await readFile(path.join(root, 'world-map-preview/catalog.json'), 'utf8')) as { entries: Array<{ id: string, fingerprint: unknown }> }
		const snapshotEntry = catalog.entries.find(entry => entry.id === 'TWMS/209') as { fingerprint: unknown, selectable?: boolean } | undefined
		assert.equal(snapshotEntry?.fingerprint, null)
		assert.equal(snapshotEntry?.selectable, false)
		await assert.rejects(readFile(path.join(root, 'world-map/manifest.json'), 'utf8'))
	}
	finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('keeps GMS/270 as the temporary unversioned compatibility alias', async () => {
	const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/6FA9WQAAAABJRU5ErkJggg=='
	class FixtureClient extends MapleStoryIoClient {
		override async hasReadyVersion(): Promise<boolean> {
			return true
		}

		override async listWorldMapIds(): Promise<string[]> {
			return ['WorldMap', 'GWorldMap']
		}

		override async listMaps(): Promise<[]> {
			return []
		}

		override async fetchWorldMap(_region: string, _version: string, id: string): Promise<GameWorldMap> {
			return { id, worldMapName: id, parentWorld: null, links: [], baseImages: [{ image, origin: { x: 0, y: 0 } }], maps: [], mapNumbers: [] }
		}

		override async fetchWorldMapNames(): Promise<Record<string, string>> {
			return { WorldMap: 'Maple World' }
		}
	}
	const root = await mkdtemp(path.join(tmpdir(), 'world-map-default-generation-'))
	try {
		const catalogSource = path.join(root, 'catalog-source.json')
		await writeFile(catalogSource, '[]\n')
		await runWorldMapGeneration({
			mode: 'full',
			snapshot: { region: 'GMS', version: '270' },
			outputDir: root,
			catalogSource,
			sources: [],
			localizations: [],
			gameClient: new FixtureClient({ delayMs: 0 }),
			generatedAt: '2026-09-10T00:00:00.000Z',
		})
		const versioned = JSON.parse(await readFile(path.join(root, 'world-map/snapshots/GMS/270/manifest.json'), 'utf8')) as { schemaVersion: number, canonicalSchemaVersion: number, cacheKey: string, source: Record<string, unknown> }
		const compatibility = JSON.parse(await readFile(path.join(root, 'world-map/manifest.json'), 'utf8')) as { schemaVersion: number, canonicalSchemaVersion: number, cacheKey: string, source: Record<string, unknown>, assets: { nativeWz: { version: unknown } } }
		assert.equal(versioned.schemaVersion, 2)
		assert.equal(versioned.canonicalSchemaVersion, 7)
		assert.equal(compatibility.schemaVersion, 1)
		assert.equal(compatibility.canonicalSchemaVersion, 6)
		assert.equal(compatibility.source.provider, 'maplestory-io')
		assert.equal(compatibility.source.version, 270)
		assert.equal('logicalRegion' in compatibility.source, false)
		assert.equal(compatibility.assets.nativeWz.version, 270)
		assert.notEqual(compatibility.cacheKey, '')
		const compatibilityIndex = JSON.parse(await readFile(path.join(root, 'world-map/world-maps.json'), 'utf8')) as { schemaVersion: number, graph: { nodes: Array<{ canonicalLabelSource?: unknown, provenance: Record<string, unknown> }> } }
		assert.equal(compatibilityIndex.schemaVersion, 6)
		assert.equal(compatibilityIndex.graph.nodes[0]?.canonicalLabelSource, undefined)
		assert.equal(compatibilityIndex.graph.nodes[0]?.provenance.version, 270)
		assert.equal('logicalRegion' in compatibilityIndex.graph.nodes[0]!.provenance, false)
		const beforePreviewCatalog = JSON.parse(await readFile(path.join(root, 'world-map/catalog.json'), 'utf8')) as { entries: Array<{ id: string, fingerprint: unknown, selectable: boolean }> }
		const beforePreviewEntry = beforePreviewCatalog.entries.find(entry => entry.id === 'GMS/270')!
		assert.equal(beforePreviewEntry.selectable, true)
		assert.ok(beforePreviewEntry.fingerprint)

		await runWorldMapGeneration({
			mode: 'preview',
			snapshot: { region: 'GMS', version: '270' },
			outputDir: root,
			catalogSource,
			sources: [],
			localizations: [],
			gameClient: new FixtureClient({ delayMs: 0 }),
			generatedAt: '2026-09-10T00:01:00.000Z',
		})
		const afterPreviewCatalog = JSON.parse(await readFile(path.join(root, 'world-map/catalog.json'), 'utf8')) as { entries: Array<{ id: string, fingerprint: unknown, selectable: boolean }> }
		const afterPreviewEntry = afterPreviewCatalog.entries.find(entry => entry.id === 'GMS/270')!
		assert.equal(afterPreviewEntry.selectable, true)
		assert.deepEqual(afterPreviewEntry.fingerprint, beforePreviewEntry.fingerprint)
		const previewManifest = JSON.parse(await readFile(path.join(root, 'world-map-preview/snapshots/GMS/270/manifest.json'), 'utf8')) as { cacheKey: string }
		assert.notEqual(previewManifest.cacheKey, '')
		const previewCatalog = JSON.parse(await readFile(path.join(root, 'world-map-preview/catalog.json'), 'utf8')) as { entries: Array<{ id: string, fingerprint: unknown, selectable: boolean }> }
		const previewEntry = previewCatalog.entries.find(entry => entry.id === 'GMS/270')!
		assert.equal(previewEntry.selectable, false)
		assert.equal(previewEntry.fingerprint, null)
		const compatibilityAfterPreview = JSON.parse(await readFile(path.join(root, 'world-map/manifest.json'), 'utf8')) as { cacheKey: string }
		assert.equal(compatibilityAfterPreview.cacheKey, compatibility.cacheKey)
	}
	finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('full MapleStory.IO graph acquisition distinguishes transient failures from deterministic 404s', async () => {
	const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/6FA9WQAAAABJRU5ErkJggg=='
	const transient = new MapleStoryIoRequestError('fixture', Object.assign(new Error('upstream unavailable'), { status: 503 }))
	const missing = new MapleStoryIoRequestError('fixture', Object.assign(new Error('not found'), { status: 404 }))
	const options = { mode: 'full' as const, requests: [], logicalRegion: 'GMS' as const }

	class WorldMapTransientClient extends MapleStoryIoClient {
		override async listWorldMapIds(): Promise<string[]> { return ['WorldMap'] }
		override async fetchWorldMap(): Promise<GameWorldMap> { throw transient }
		override async listMaps(): Promise<[]> { return [] }
		override async fetchWorldMapNames(): Promise<Record<string, string>> { return {} }
	}
	const worldMapFailure = await acquireWorldMapGraph(new WorldMapTransientClient({ delayMs: 0 }), 'GMS', '270', options)
	assert.equal(worldMapFailure.completeness?.complete, false)
	assert.equal(worldMapFailure.completeness?.worldMapIndexComplete, false)
	assert.equal(worldMapFailure.completeness?.worldMapIndexFailures.WorldMap, 'transient')
	assert.equal(worldMapFailure.completeness?.worldMapFailures.WorldMap, 'transient')

	class UnrenderableIndexClient extends MapleStoryIoClient {
		override async listWorldMapIds(): Promise<string[]> { return ['WorldMap'] }
		override async fetchWorldMap(): Promise<GameWorldMap> {
			return { id: 'WorldMap', worldMapName: 'WorldMap', parentWorld: null, links: [], baseImages: [], maps: [], mapNumbers: [] }
		}

		override async listMaps(): Promise<[]> { return [] }
		override async fetchWorldMapNames(): Promise<Record<string, string>> { return {} }
	}
	const unrenderableIndex = await acquireWorldMapGraph(new UnrenderableIndexClient({ delayMs: 0 }), 'GMS', '270', options)
	assert.equal(unrenderableIndex.completeness?.complete, false)
	assert.equal(unrenderableIndex.completeness?.worldMapIndexFailures.WorldMap, 'unrenderable')
	assert.equal(unrenderableIndex.completeness?.worldMapFailures.WorldMap, 'unrenderable')

	class RawControlIndexClient extends UnrenderableIndexClient {
		override async listRawWorldMapIds(): Promise<string[]> { return ['WorldMap'] }
		override async rawWorldMapHasScreenShape(): Promise<boolean> { return false }
		override async auditRawWorldMaps(): Promise<{ failures: Record<string, never>, mismatches: Record<string, string[]> }> { return { failures: {}, mismatches: {} } }
		override async fetchRawMapStringsByMapIds(): Promise<{ values: Record<string, { name: string | null, streetName: string | null }>, failures: Record<string, never> }> { return { values: {}, failures: {} } }
	}
	const rawControlIndex = await acquireWorldMapGraph(new RawControlIndexClient({ delayMs: 0 }), 'GMS', '270', { ...options, rawWzAudit: true })
	assert.equal(rawControlIndex.completeness?.complete, true)
	assert.equal(rawControlIndex.completeness?.worldMapIndexComplete, true)
	assert.deepEqual(rawControlIndex.completeness?.worldMapIndexFailures, {})
	assert.deepEqual(rawControlIndex.completeness?.worldMapFailures, {})
	assert.match(rawControlIndex.warnings?.join('\n') ?? '', /raw WZ has no screen structure/)

	class DetailTransientClient extends MapleStoryIoClient {
		override async listWorldMapIds(): Promise<string[]> { return ['WorldMap'] }

		override async fetchWorldMap(): Promise<GameWorldMap> {
			return { id: 'WorldMap', worldMapName: 'WorldMap', parentWorld: null, links: [], baseImages: [{ image, origin: { x: 0, y: 0 } }], maps: [{ spot: { x: 0, y: 0 }, type: 1, mapNumbers: ['100000000'] }], mapNumbers: ['100000000'] }
		}

		override async listMaps(): Promise<Array<{ id: string, name: string | null, streetName: string | null }>> { return [{ id: '100000000', name: 'Henesys', streetName: 'Henesys' }] }

		override async fetchMap(): Promise<never> { throw transient }

		override async fetchMapBgmPath(): Promise<string | null> { throw transient }

		override async fetchWorldMapNames(): Promise<Record<string, string>> { return {} }
	}
	const detailFailure = await acquireWorldMapGraph(new DetailTransientClient({ delayMs: 0 }), 'GMS', '270', options)
	assert.equal(detailFailure.completeness?.complete, false)
	assert.equal(detailFailure.completeness?.mapDetailFailures['100000000'], 'transient')

	class DetailBgmFallbackClient extends DetailTransientClient {
		override async fetchMapBgmPath(): Promise<string> { return 'Bgm00/FloralLife' }
	}
	const detailBgmRecovered = await acquireWorldMapGraph(new DetailBgmFallbackClient({ delayMs: 0 }), 'GMS', '270', options)
	assert.equal(detailBgmRecovered.completeness?.complete, true)
	assert.deepEqual(detailBgmRecovered.completeness?.mapDetailFailures, {})
	assert.equal(detailBgmRecovered.maps.find(map => map.id === '100000000')?.backgroundMusic, 'Bgm00/FloralLife')
	assert.equal(detailBgmRecovered.maps.find(map => map.id === '100000000')?.mapMark, null)
	assert.match(detailBgmRecovered.warnings?.join('\n') ?? '', /exact map inventory and BGM endpoint used with mapMark unavailable/)

	class DetailRawFallbackClient extends DetailTransientClient {
		override async listRawWorldMapIds(): Promise<string[]> { return ['WorldMap'] }
		override async auditRawWorldMaps(): Promise<{ failures: Record<string, never>, mismatches: Record<string, string[]> }> { return { failures: {}, mismatches: {} } }
		override async fetchRawMapStringsByMapIds(): Promise<{ values: Record<string, { name: string | null, streetName: string | null }>, failures: Record<string, never> }> { return { values: {}, failures: {} } }
		override async fetchRawMapDetail(): Promise<{ mapMark: string, backgroundMusic: string, resolvedMapId: string } | null> {
			return { mapMark: 'Henesys', backgroundMusic: 'Bgm00/FloralLife', resolvedMapId: '100000000' }
		}
	}
	const detailRecovered = await acquireWorldMapGraph(new DetailRawFallbackClient({ delayMs: 0 }), 'GMS', '270', { ...options, rawWzAudit: true })
	assert.equal(detailRecovered.completeness?.complete, true)
	assert.deepEqual(detailRecovered.completeness?.mapDetailFailures, {})
	assert.equal(detailRecovered.maps.find(map => map.id === '100000000')?.backgroundMusic, 'Bgm00/FloralLife')

	class DetailRawAbsentClient extends DetailRawFallbackClient {
		override async fetchRawMapDetail(): Promise<null> { return null }
	}
	const detailRawAbsent = await acquireWorldMapGraph(new DetailRawAbsentClient({ delayMs: 0 }), 'GMS', '270', { ...options, rawWzAudit: true })
	assert.equal(detailRawAbsent.completeness?.complete, true)
	assert.equal(detailRawAbsent.completeness?.mapDetailFailures['100000000'], 'not-found')
	assert.match(detailRawAbsent.warnings?.join('\n') ?? '', /exact raw WZ map is absent/)

	class DetailMissingClient extends DetailTransientClient {
		override async fetchMap(): Promise<never> { throw missing }
	}
	const detailMissing = await acquireWorldMapGraph(new DetailMissingClient({ delayMs: 0 }), 'GMS', '270', options)
	assert.equal(detailMissing.completeness?.complete, true)
	assert.equal(detailMissing.completeness?.worldMapIndexComplete, true)
	assert.equal(detailMissing.completeness?.mapDetailFailures['100000000'], 'not-found')

	class DetailRawMissingClient extends DetailRawFallbackClient {
		override async fetchMap(): Promise<never> { throw missing }
		override async fetchRawMapDetail(): Promise<never> { throw new Error('deterministic normalized 404 must not use raw detail fallback') }
	}
	const detailRawMissing = await acquireWorldMapGraph(new DetailRawMissingClient({ delayMs: 0 }), 'GMS', '270', { ...options, rawWzAudit: true })
	assert.equal(detailRawMissing.completeness?.complete, true)
	assert.equal(detailRawMissing.completeness?.mapDetailFailures['100000000'], 'not-found')

	class MissingClient extends MapleStoryIoClient {
		override async listWorldMapIds(): Promise<string[]> { return ['WorldMap'] }
		override async fetchWorldMap(): Promise<GameWorldMap> { throw missing }
		override async listMaps(): Promise<[]> { return [] }
		override async fetchWorldMapNames(): Promise<Record<string, string>> { return {} }
	}
	const deterministicMissing = await acquireWorldMapGraph(new MissingClient({ delayMs: 0 }), 'GMS', '270', options)
	assert.equal(deterministicMissing.completeness?.complete, false)
	assert.equal(deterministicMissing.completeness?.worldMapIndexComplete, false)
	assert.equal(deterministicMissing.completeness?.worldMapIndexFailures.WorldMap, 'not-found')
	assert.equal(deterministicMissing.completeness?.worldMapFailures.WorldMap, 'not-found')

	class UnindexedLinkedTargetClient extends MapleStoryIoClient {
		override async listWorldMapIds(): Promise<string[]> { return ['WorldMap'] }

		override async fetchWorldMap(_region: string, _version: string, id: string): Promise<GameWorldMap> {
			if (id === 'WorldMap')
				return { id, worldMapName: id, parentWorld: null, links: [{ toolTip: 'Historical target', linksTo: 'WorldMapUnindexed', linkImage: null }], baseImages: [{ image, origin: { x: 0, y: 0 } }], maps: [], mapNumbers: [] }
			throw missing
		}

		override async listMaps(): Promise<[]> { return [] }
		override async fetchWorldMapNames(): Promise<Record<string, string>> { return {} }
	}
	const unindexedLinkedTarget = await acquireWorldMapGraph(new UnindexedLinkedTargetClient({ delayMs: 0 }), 'GMS', '270', options)
	assert.equal(unindexedLinkedTarget.completeness?.complete, true)
	assert.equal(unindexedLinkedTarget.completeness?.worldMapIndexComplete, true)
	assert.equal(unindexedLinkedTarget.completeness?.worldMapUnindexedFailures.WorldMapUnindexed, 'not-found')
	assert.equal(unindexedLinkedTarget.completeness?.worldMapFailures.WorldMapUnindexed, 'not-found')
	const unresolvedGraph = normalizeWorldMapGraph(
		unindexedLinkedTarget,
		{
			baseImages: new Map([['WorldMap', [{ file: 'world-map/test/WorldMap.png', width: 1, height: 1, sha1: '0'.repeat(40), origin: { x: 0, y: 0 } }]]]),
			linkImages: new Map([['WorldMap', [null]]]),
		},
		[],
	)
	assert.equal(unresolvedGraph.nodes[0]!.links[0]!.targetWorldMapId, 'WorldMapUnindexed')

	class UnindexedFailureClient extends MapleStoryIoClient {
		constructor(private readonly failure: MapleStoryIoRequestError) {
			super({ delayMs: 0 })
		}

		override async listWorldMapIds(): Promise<string[]> { return ['WorldMap'] }

		override async fetchWorldMap(_region: string, _version: string, id: string): Promise<GameWorldMap> {
			if (id === 'WorldMap')
				return { id, worldMapName: id, parentWorld: null, links: [{ toolTip: 'Historical target', linksTo: 'WorldMapUnindexed', linkImage: null }], baseImages: [{ image, origin: { x: 0, y: 0 } }], maps: [], mapNumbers: [] }
			throw this.failure
		}

		override async listMaps(): Promise<[]> { return [] }
		override async fetchWorldMapNames(): Promise<Record<string, string>> { return {} }
	}
	const unindexedTransient = await acquireWorldMapGraph(new UnindexedFailureClient(transient), 'GMS', '270', options)
	assert.equal(unindexedTransient.completeness?.complete, false)
	assert.equal(unindexedTransient.completeness?.worldMapUnindexedFailures.WorldMapUnindexed, 'transient')
	const unindexedInvalid = await acquireWorldMapGraph(new UnindexedFailureClient(new MapleStoryIoRequestError('fixture', new Error('malformed response'))), 'GMS', '270', options)
	assert.equal(unindexedInvalid.completeness?.complete, false)
	assert.equal(unindexedInvalid.completeness?.worldMapUnindexedFailures.WorldMapUnindexed, 'invalid')

	class UnindexedUnrenderableClient extends MapleStoryIoClient {
		override async listWorldMapIds(): Promise<string[]> { return ['WorldMap'] }
		override async fetchWorldMap(_region: string, _version: string, id: string): Promise<GameWorldMap> {
			if (id === 'WorldMap')
				return { id, worldMapName: id, parentWorld: null, links: [{ toolTip: 'Historical target', linksTo: 'WorldMapUnindexed', linkImage: null }], baseImages: [{ image, origin: { x: 0, y: 0 } }], maps: [], mapNumbers: [] }
			return { id, worldMapName: id, parentWorld: null, links: [], baseImages: [], maps: [], mapNumbers: [] }
		}

		override async listMaps(): Promise<[]> { return [] }
		override async fetchWorldMapNames(): Promise<Record<string, string>> { return {} }
	}
	const unindexedUnrenderable = await acquireWorldMapGraph(new UnindexedUnrenderableClient({ delayMs: 0 }), 'GMS', '270', options)
	assert.equal(unindexedUnrenderable.completeness?.complete, true)
	assert.equal(unindexedUnrenderable.completeness?.worldMapUnindexedFailures.WorldMapUnindexed, 'unrenderable')

	const nameMissingClient = new (class extends MapleStoryIoClient {
		constructor() {
			super({
				delayMs: 0,
				fetcher: (async (url: string) => {
					if (url.endsWith('/String/WorldMap.img'))
						return { children: ['0', '010'] }
					if (url.endsWith('/String/WorldMap.img/0/name') || url.endsWith('/String/WorldMap.img/010/name'))
						throw Object.assign(new Error('historical name key absent'), { status: 404 })
					throw new Error(`Unexpected String request: ${url}`)
				}) as never,
			})
		}

		override async listWorldMapIds(): Promise<string[]> { return ['WorldMap', 'WorldMap010'] }

		override async fetchWorldMap(_region: string, _version: string, id: string): Promise<GameWorldMap> {
			return {
				id,
				worldMapName: id,
				parentWorld: id === 'WorldMap' ? null : 'WorldMap',
				links: id === 'WorldMap' ? [{ toolTip: 'Victoria Island', linksTo: 'WorldMap010', linkImage: null }] : [],
				baseImages: [{ image, origin: { x: 0, y: 0 } }],
				maps: [],
				mapNumbers: [],
			}
		}

		override async listMaps(): Promise<[]> { return [] }
	})()
	const nameMissing = await acquireWorldMapGraph(nameMissingClient, 'GMS', '270', options)
	assert.equal(nameMissing.completeness?.complete, true)
	assert.equal(nameMissing.completeness?.worldMapIndexComplete, true)
	assert.equal(nameMissing.completeness?.worldMapNamesFailure, null)
	assert.deepEqual(nameMissing.worldMapNames, {})
	const nameFallbackGraph = normalizeWorldMapGraph(
		nameMissing,
		{
			baseImages: new Map(nameMissing.nodes.map(node => [node.id, [{ file: `world-map/test/${node.id}.png`, width: 1, height: 1, sha1: '0'.repeat(40), origin: { x: 0, y: 0 } }]])),
			linkImages: new Map([['WorldMap', [null]], ['WorldMap010', []]]),
		},
		[],
	)
	assert.equal(nameFallbackGraph.nodes.find(node => node.worldMapId === 'WorldMap010')?.canonicalLabel, 'Victoria Island')
})

test('full generation does not replace a selectable artifact after index-listed WorldMap 404', async () => {
	const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/6FA9WQAAAABJRU5ErkJggg=='
	class FlakyClient extends MapleStoryIoClient {
		failWorldMap = false
		override async hasReadyVersion(): Promise<boolean> { return true }

		override async listWorldMapIds(): Promise<string[]> { return ['WorldMap'] }

		override async listMaps(): Promise<[]> { return [] }
		override async fetchWorldMap(_region: string, _version: string, id: string): Promise<GameWorldMap> {
			if (this.failWorldMap)
				throw new MapleStoryIoRequestError(`world map ${id}`, Object.assign(new Error('index-listed WorldMap absent'), { status: 404 }))
			return { id, worldMapName: id, parentWorld: null, links: [], baseImages: [{ image, origin: { x: 0, y: 0 } }], maps: [], mapNumbers: [] }
		}

		override async fetchWorldMapNames(): Promise<Record<string, string>> { return { WorldMap: 'Maple World' } }
	}
	const root = await mkdtemp(path.join(tmpdir(), 'world-map-transient-full-'))
	try {
		const catalogSource = path.join(root, 'catalog-source.json')
		await writeFile(catalogSource, '[]\n')
		const client = new FlakyClient({ delayMs: 0 })
		await runWorldMapGeneration({ mode: 'full', snapshot: { region: 'GMS', version: '270' }, outputDir: root, catalogSource, sources: [], localizations: [], gameClient: client, generatedAt: '2026-09-10T00:00:00.000Z' })
		client.failWorldMap = true
		await assert.rejects(
			runWorldMapGeneration({ mode: 'full', snapshot: { region: 'GMS', version: '270' }, outputDir: root, catalogSource, sources: [], localizations: [], gameClient: client, generatedAt: '2026-09-10T00:01:00.000Z' }),
			/incomplete.*not marked selectable/,
		)
		const catalog = JSON.parse(await readFile(path.join(root, 'world-map/catalog.json'), 'utf8')) as { entries: Array<{ id: string, selectable: boolean }> }
		assert.equal(catalog.entries.find(entry => entry.id === 'GMS/270')?.selectable, true)
		assert.ok((await readFile(path.join(root, 'world-map/snapshots/GMS/270/world-maps.json'))).byteLength > 0)
	}
	finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('full generation publishes through staging and preserves the old snapshot after a mid-write failure', async () => {
	const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/6FA9WQAAAABJRU5ErkJggg=='
	class MidWriteFailureClient extends MapleStoryIoClient {
		failMidWrite = false
		upstreamUnavailable = false
		override async hasReadyVersion(region: string): Promise<boolean> {
			if (this.upstreamUnavailable && region === 'GMS')
				throw new Error('MapleStory.IO unavailable')
			return true
		}

		override async listWorldMapIds(): Promise<string[]> { return ['WorldMap', 'GWorldMap'] }
		override async listMaps(): Promise<[]> { return [] }
		override async fetchWorldMap(_region: string, _version: string, id: string): Promise<GameWorldMap> {
			return {
				id,
				worldMapName: id,
				parentWorld: null,
				links: [],
				baseImages: [{ image: this.failMidWrite && id === 'GWorldMap' ? 'not-an-image' : image, origin: { x: 0, y: 0 } }],
				maps: [],
				mapNumbers: [],
			}
		}

		override async fetchWorldMapNames(): Promise<Record<string, string>> { return {} }
	}
	const root = await mkdtemp(path.join(tmpdir(), 'world-map-transactional-refresh-'))
	try {
		const catalogSource = path.join(root, 'catalog-source.json')
		await writeFile(catalogSource, '[]\n')
		const client = new MidWriteFailureClient({ delayMs: 0 })
		await runWorldMapGeneration({ mode: 'full', snapshot: { region: 'GMS', version: '270' }, outputDir: root, catalogSource, sources: [], localizations: [], gameClient: client, generatedAt: '2026-09-10T00:00:00.000Z' })
		const snapshotFile = path.join(root, 'world-map/snapshots/GMS/270/world-maps.json')
		const catalogFile = path.join(root, 'world-map/catalog.json')
		const oldSnapshot = await readFile(snapshotFile)

		client.upstreamUnavailable = true
		await runWorldMapGeneration({ mode: 'full', snapshot: { region: 'TWMS', version: '209' }, outputDir: root, catalogSource, sources: [], localizations: [], gameClient: client, generatedAt: '2026-09-10T00:01:00.000Z' })
		const carriedForwardCatalog = await readFile(catalogFile, 'utf8')
		const carriedForward = JSON.parse(carriedForwardCatalog) as { entries: Array<{ id: string, selectable: boolean }> }
		assert.equal(carriedForward.entries.find(entry => entry.id === 'GMS/270')?.selectable, true)

		client.failMidWrite = true
		await assert.rejects(
			runWorldMapGeneration({ mode: 'full', snapshot: { region: 'TWMS', version: '217' }, outputDir: root, catalogSource, sources: [], localizations: [], gameClient: client, generatedAt: '2026-09-10T00:02:00.000Z' }),
			/image|unsupported|Input buffer/i,
		)
		assert.deepEqual(await readFile(snapshotFile), oldSnapshot)
		assert.deepEqual(await readFile(catalogFile, 'utf8'), carriedForwardCatalog)
		const catalog = JSON.parse(carriedForwardCatalog) as { entries: Array<{ id: string, selectable: boolean }> }
		assert.equal(catalog.entries.find(entry => entry.id === 'GMS/270')?.selectable, true)
	}
	finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('rolls back the versioned snapshot, images, catalog, and compatibility alias when alias publication fails', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'world-map-alias-transaction-'))
	try {
		const liveWorldMap = path.join(root, 'world-map')
		const liveSnapshot = path.join(liveWorldMap, 'snapshots/GMS/270')
		const liveImages = path.join(liveWorldMap, 'images')
		await mkdir(path.join(liveSnapshot, 'nodes'), { recursive: true })
		await mkdir(path.join(liveImages, 'old'), { recursive: true })
		await mkdir(path.join(liveWorldMap, 'nodes'), { recursive: true })
		await writeFile(path.join(liveSnapshot, 'marker'), 'old-snapshot')
		await writeFile(path.join(liveImages, 'old/marker'), 'old-images')
		await writeFile(path.join(liveWorldMap, 'world-maps.json'), 'old-alias-json')
		await writeFile(path.join(liveWorldMap, 'manifest.json'), 'old-alias-manifest')
		await writeFile(path.join(liveWorldMap, 'nodes/marker'), 'old-alias-node')
		await writeFile(path.join(liveWorldMap, 'catalog.json'), 'old-catalog')

		const stagingWorldMap = path.join(root, 'staging/world-map')
		const stagingSnapshot = path.join(stagingWorldMap, 'snapshots/GMS/270')
		const stagingImages = path.join(stagingWorldMap, 'images')
		await mkdir(path.join(stagingSnapshot, 'nodes'), { recursive: true })
		await mkdir(path.join(stagingImages, 'new'), { recursive: true })
		await mkdir(path.join(stagingWorldMap, 'nodes'), { recursive: true })
		await writeFile(path.join(stagingSnapshot, 'marker'), 'new-snapshot')
		await writeFile(path.join(stagingImages, 'new/marker'), 'new-images')
		await writeFile(path.join(stagingWorldMap, 'world-maps.json'), 'new-alias-json')
		await writeFile(path.join(stagingWorldMap, 'manifest.json'), 'new-alias-manifest')
		await writeFile(path.join(stagingWorldMap, 'nodes/marker'), 'new-alias-node')
		await writeFile(path.join(stagingWorldMap, 'catalog.json'), 'new-catalog')

		const failingRename = async (source: Parameters<typeof rename>[0], target: Parameters<typeof rename>[1]): Promise<void> => {
			if (String(source).endsWith('/world-map/manifest.json'))
				throw new Error('simulated compatibility alias publication failure')
			await rename(source, target)
		}
		await assert.rejects(
			publishFullSnapshot(
				stagingSnapshot,
				path.join(stagingWorldMap, 'catalog.json'),
				stagingImages,
				liveSnapshot,
				path.join(liveWorldMap, 'catalog.json'),
				liveImages,
				root,
				stagingWorldMap,
				liveWorldMap,
				{ renamePath: failingRename },
			),
			/simulated compatibility alias publication failure/,
		)

		assert.equal(await readFile(path.join(liveSnapshot, 'marker'), 'utf8'), 'old-snapshot')
		assert.equal(await readFile(path.join(liveImages, 'old/marker'), 'utf8'), 'old-images')
		assert.equal(await readFile(path.join(liveWorldMap, 'world-maps.json'), 'utf8'), 'old-alias-json')
		assert.equal(await readFile(path.join(liveWorldMap, 'manifest.json'), 'utf8'), 'old-alias-manifest')
		assert.equal(await readFile(path.join(liveWorldMap, 'nodes/marker'), 'utf8'), 'old-alias-node')
		assert.equal(await readFile(path.join(liveWorldMap, 'catalog.json'), 'utf8'), 'old-catalog')
	}
	finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('preserves the recovery backup when publication rollback itself fails', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'world-map-rollback-recovery-'))
	try {
		const liveWorldMap = path.join(root, 'world-map')
		const liveSnapshot = path.join(liveWorldMap, 'snapshots/GMS/270')
		const stagingWorldMap = path.join(root, 'staging/world-map')
		const stagingSnapshot = path.join(stagingWorldMap, 'snapshots/GMS/270')
		await mkdir(liveSnapshot, { recursive: true })
		await mkdir(stagingSnapshot, { recursive: true })
		await writeFile(path.join(liveSnapshot, 'marker'), 'old-snapshot')
		await writeFile(path.join(stagingSnapshot, 'marker'), 'new-snapshot')
		await writeFile(path.join(liveWorldMap, 'catalog.json'), 'old-catalog')
		await writeFile(path.join(stagingWorldMap, 'catalog.json'), 'new-catalog')

		const injectedRename = async (source: Parameters<typeof rename>[0], target: Parameters<typeof rename>[1]): Promise<void> => {
			const sourceText = String(source)
			if (sourceText === path.join(stagingWorldMap, 'catalog.json'))
				throw new Error('simulated publication failure')
			if (sourceText.includes('.world-map-publish-') && sourceText.endsWith('/snapshot') && String(target) === liveSnapshot)
				throw new Error('simulated rollback restore failure')
			await rename(source, target)
		}

		let failure: unknown
		try {
			await publishFullSnapshot(
				stagingSnapshot,
				path.join(stagingWorldMap, 'catalog.json'),
				path.join(stagingWorldMap, 'images-does-not-exist'),
				liveSnapshot,
				path.join(liveWorldMap, 'catalog.json'),
				path.join(liveWorldMap, 'images'),
				root,
				null,
				liveWorldMap,
				{ renamePath: injectedRename },
			)
		}
		catch (error) {
			failure = error
		}
		assert.ok(failure instanceof AggregateError)
		assert.match(failure.message, /rollback was incomplete; preserved recovery backup at /)
		const backupDirectory = failure.message.match(/preserved recovery backup at (.+)$/u)?.[1]
		assert.ok(backupDirectory)
		assert.equal(await readFile(path.join(backupDirectory, 'snapshot/marker'), 'utf8'), 'old-snapshot')
		assert.equal(await readFile(path.join(liveWorldMap, 'catalog.json'), 'utf8'), 'old-catalog')
	}
	finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('full generation refuses an index-listed WorldMap with no renderable base image', async () => {
	class UnrenderableClient extends MapleStoryIoClient {
		override async hasReadyVersion(): Promise<boolean> { return true }
		override async listWorldMapIds(): Promise<string[]> { return ['WorldMap'] }
		override async listMaps(): Promise<[]> { return [] }
		override async fetchWorldMap(): Promise<GameWorldMap> {
			return { id: 'WorldMap', worldMapName: 'WorldMap', parentWorld: null, links: [], baseImages: [], maps: [], mapNumbers: [] }
		}

		override async fetchWorldMapNames(): Promise<Record<string, string>> { return {} }
	}
	const root = await mkdtemp(path.join(tmpdir(), 'world-map-unrenderable-full-'))
	try {
		const catalogSource = path.join(root, 'catalog-source.json')
		await writeFile(catalogSource, '[]\n')
		await assert.rejects(
			runWorldMapGeneration({ mode: 'full', snapshot: { region: 'GMS', version: '270' }, outputDir: root, catalogSource, sources: [], localizations: [], gameClient: new UnrenderableClient({ delayMs: 0 }), generatedAt: '2026-09-10T00:00:00.000Z' }),
			/incomplete.*not marked selectable/,
		)
	}
	finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('drops stale selectable snapshots when their full resources no longer verify', async (t) => {
	const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/6FA9WQAAAABJRU5ErkJggg=='
	class FixtureClient extends MapleStoryIoClient {
		override async hasReadyVersion(): Promise<boolean> { return true }
		override async listWorldMapIds(): Promise<string[]> { return ['WorldMap', 'GWorldMap'] }
		override async listMaps(): Promise<[]> { return [] }
		override async fetchWorldMap(_region: string, _version: string, id: string): Promise<GameWorldMap> {
			return { id, worldMapName: id, parentWorld: null, links: [], baseImages: [{ image, origin: { x: 0, y: 0 } }], maps: [], mapNumbers: [] }
		}

		override async fetchWorldMapNames(_region: string): Promise<Record<string, string>> {
			return { WorldMap: 'Maple World', GWorldMap: 'Grandis' }
		}
	}

	const corruptions: Array<{ name: string, corrupt: (root: string) => Promise<void> }> = [
		{
			name: 'missing manifest',
			corrupt: root => rm(path.join(root, 'world-map/snapshots/GMS/270/manifest.json')),
		},
		{
			name: 'missing runtime chunk',
			corrupt: root => rm(path.join(root, 'world-map/snapshots/GMS/270/nodes/WorldMap.json')),
		},
		{
			name: 'missing native asset',
			corrupt: root => rm(path.join(root, 'world-map/snapshots/GMS/270/assets/WorldMap/base-0.png')),
		},
		{
			name: 'canonical graph changed after catalog fingerprinting',
			async corrupt(root) {
				const file = path.join(root, 'world-map/snapshots/GMS/270/world-maps.json')
				const index = JSON.parse(await readFile(file, 'utf8')) as { graph: { nodes: Array<{ canonicalLabel: string | null }> } }
				index.graph.nodes[0]!.canonicalLabel = 'Corrupted after generation'
				await writeFile(file, `${JSON.stringify(index, null, 2)}\n`)
			},
		},
		{
			name: 'canonical graph provider identity changed after catalog fingerprinting',
			async corrupt(root) {
				const file = path.join(root, 'world-map/snapshots/GMS/270/world-maps.json')
				const index = JSON.parse(await readFile(file, 'utf8')) as { graph: { nodes: Array<{ provenance: { apiBase: string } }> } }
				index.graph.nodes[0]!.provenance.apiBase = 'https://wrong-provider.example/api'
				await writeFile(file, `${JSON.stringify(index, null, 2)}\n`)
			},
		},
		{
			name: 'runtime manifest provider identity changed after catalog fingerprinting',
			async corrupt(root) {
				const file = path.join(root, 'world-map/snapshots/GMS/270/manifest.json')
				const manifest = JSON.parse(await readFile(file, 'utf8')) as { source: { apiBase: string } }
				manifest.source.apiBase = 'https://wrong-provider.example/api'
				await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`)
			},
		},
	]

	for (const corruption of corruptions) {
		await t.test(corruption.name, async () => {
			const root = await mkdtemp(path.join(tmpdir(), 'world-map-stale-snapshot-'))
			try {
				const catalogSource = path.join(root, 'catalog-source.json')
				await writeFile(catalogSource, '[]\n')
				const client = new FixtureClient({ delayMs: 0 })
				await runWorldMapGeneration({
					mode: 'full',
					snapshot: { region: 'GMS', version: '270' },
					outputDir: root,
					catalogSource,
					sources: [],
					localizations: [],
					gameClient: client,
					generatedAt: '2026-09-10T00:00:00.000Z',
				})
				await corruption.corrupt(root)
				const result = await runWorldMapGeneration({
					mode: 'full',
					snapshot: { region: 'TWMS', version: '209' },
					outputDir: root,
					catalogSource,
					gameClient: client,
					generatedAt: '2026-09-10T00:01:00.000Z',
				})
				assert.ok(result.warnings.some(warning => warning.startsWith('Snapshot GMS/270 is no longer selectable:')))
				const catalog = JSON.parse(await readFile(path.join(root, 'world-map/catalog.json'), 'utf8')) as {
					entries: Array<{ id: string, selectable: boolean, fingerprint: unknown }>
				}
				const stale = catalog.entries.find(entry => entry.id === 'GMS/270')!
				const current = catalog.entries.find(entry => entry.id === 'TWMS/209')!
				assert.equal(stale.selectable, false)
				assert.equal(stale.fingerprint, null)
				assert.equal(current.selectable, true)
				assert.ok(current.fingerprint)
			}
			finally {
				await rm(root, { recursive: true, force: true })
			}
		})
	}
})

test('maps native WorldMap IDs to exact String/WorldMap.img keys', () => {
	assert.equal(worldMapStringKey('WorldMap'), '0')
	assert.equal(worldMapStringKey('WorldMap010'), '010')
	assert.equal(worldMapStringKey('WorldMap08221'), '08221')
	assert.equal(worldMapStringKey('GWorldMap'), 'GWorldMap')
	assert.equal(worldMapStringKey('WorldMapCN'), 'WorldMapCN')
	assert.equal(worldMapStringKey('../WorldMap'), null)
})

test('reads exact String/WorldMap.img names and treats missing keys as unavailable', async () => {
	const calls: string[] = []
	const fetcher = (async (url: string) => {
		calls.push(url)
		if (url.endsWith('/String/WorldMap.img'))
			return { children: ['0', '010', 'GWorldMap'], type: 1 }
		if (url.endsWith('/String/WorldMap.img/0/name'))
			return { children: [], type: 8, value: 'Maple World' }
		if (url.endsWith('/String/WorldMap.img/010/name'))
			return { children: [], type: 8, value: 'Victoria Island' }
		if (url.endsWith('/String/WorldMap.img/GWorldMap/name'))
			return { children: [], type: 8, value: 'Grandis' }
		throw new Error(`Unexpected request: ${url}`)
	}) as typeof import('ofetch').ofetch
	const client = new MapleStoryIoClient({ fetcher, delayMs: 0, timeoutMs: 0 })
	assert.deepEqual(await client.fetchWorldMapNames('GMS', '270', ['WorldMap', 'WorldMap010', 'WorldMap082', 'GWorldMap']), {
		WorldMap: 'Maple World',
		WorldMap010: 'Victoria Island',
		GWorldMap: 'Grandis',
	})
	assert.equal(calls.length, 4)
	assert.equal(await client.fetchWorldMapName('GMS', '270', 'GWorldMap'), 'Grandis')
})

test('reads raw WZ WorldMap inventory and category-partitioned map strings', async () => {
	const fetcher = (async (url: string) => {
		if (url.endsWith('/wz/GMS/270/Map/WorldMap'))
			return { children: ['WorldMap.img', 'WorldMap010.img', '_Canvas'] }
		if (url.endsWith('/wz/GMS/270/String/Map.img/victoria/100000000'))
			return { children: ['mapName', 'streetName'] }
		if (url.endsWith('/wz/GMS/270/String/Map.img/victoria/100000000/mapName'))
			return { children: [], type: 8, value: 'Henesys' }
		if (url.endsWith('/wz/GMS/270/String/Map.img/victoria/100000000/streetName'))
			return { children: [], type: 8, value: 'Victoria Island' }
		throw Object.assign(new Error(`not found: ${url}`), { status: 404 })
	}) as typeof import('ofetch').ofetch
	const client = new MapleStoryIoClient({ fetcher, delayMs: 0, timeoutMs: 0 })
	assert.deepEqual(await client.listRawWorldMapIds('GMS', '270'), ['WorldMap', 'WorldMap010'])
	assert.deepEqual(await client.fetchRawMapStrings('GMS', '270', 'victoria', ['100000000', '200000000']), {
		100000000: { name: 'Henesys', streetName: 'Victoria Island' },
	})

	const inventoryCalls: string[] = []
	const inventoryFetcher = (async (url: string) => {
		inventoryCalls.push(url)
		if (url.endsWith('/wz/GMS/270/String/Map.img'))
			return { children: ['victoria', 'unused'] }
		if (url.endsWith('/wz/GMS/270/String/Map.img/victoria'))
			return { children: ['100000000'] }
		if (url.endsWith('/wz/GMS/270/String/Map.img/unused'))
			return { children: [] }
		if (url.endsWith('/wz/GMS/270/String/Map.img/victoria/100000000/mapName'))
			return { children: [], type: 8, value: 'Henesys raw' }
		if (url.endsWith('/wz/GMS/270/String/Map.img/victoria/100000000/streetName'))
			return { children: [], type: 8, value: 'Victoria raw' }
		throw Object.assign(new Error(`not found: ${url}`), { status: 404 })
	}) as typeof import('ofetch').ofetch
	const auditedClient = new MapleStoryIoClient({ fetcher: inventoryFetcher, delayMs: 0, timeoutMs: 0 })
	assert.deepEqual(await auditedClient.fetchRawMapStringsByMapIds('GMS', '270', ['100000000', '200000000']), {
		values: {
			100000000: { name: 'Henesys raw', streetName: 'Victoria raw' },
			200000000: { name: null, streetName: null },
		},
		failures: {},
	})
	await auditedClient.fetchRawMapStringsByMapIds('GMS', '270', ['100000000'])
	assert.equal(inventoryCalls.filter(url => url.endsWith('/String/Map.img')).length, 1)
	assert.equal(inventoryCalls.filter(url => url.endsWith('/String/Map.img/victoria')).length, 1)
})

test('uses bulk raw WorldMap images for scalar audit while retaining exact Canvas leaves', async () => {
	const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/6FA9WQAAAABJRU5ErkJggg=='
	const scalar = (type: number, value: unknown): RawWzImageNode => ({ type, value, children: {} })
	const bulkImage: RawWzImageNode = {
		type: 1,
		children: {
			BaseImg: { type: 13, children: { 0: { type: 12, value: '__bulk-canvas__', children: { origin: scalar(9, { x: 320, y: 235, isEmpty: false }) } }, spot: scalar(9, { x: -160, y: 129, isEmpty: false }) } },
			MapLink: { type: 13, children: { 0: { type: 13, children: { link: { type: 13, children: { linkMap: scalar(6, 'WorldMap011') } }, toolTip: scalar(6, 'Nautilus') } } } },
			MapList: { type: 13, children: { 95: { type: 13, children: { spot: scalar(9, { x: -195, y: -1, isEmpty: false }), type: scalar(2, 2), mapNo: { type: 13, children: { 0: scalar(2, 100000000) } } } } } },
		},
	}
	const calls: string[] = []
	const fetcher = (async (url: string) => {
		calls.push(url)
		if (url.includes('/wz/export/') && url.endsWith('?rawImage=true'))
			return new Uint8Array([1, 2, 3])
		if (url.endsWith('/BaseImg/0'))
			return { children: ['origin'], type: 12, value: image }
		throw Object.assign(new Error(`not found: ${url}`), { status: 404 })
	}) as typeof import('ofetch').ofetch
	const client = new MapleStoryIoClient({ fetcher, delayMs: 0, timeoutMs: 0, rawImageParser: async () => bulkImage })
	const result = await client.auditRawWorldMaps('GMS', '270', [{
		id: 'WorldMap010',
		worldMapName: 'WorldMap010',
		parentWorld: 'WorldMap',
		baseImages: [{ image, origin: { x: 320, y: 235 } }],
		links: [{ toolTip: 'Nautilus', linksTo: 'WorldMap011', linkImage: null }],
		maps: [{ spot: { x: -195, y: -1 }, type: 2, mapNumbers: ['100000000'] }],
		mapNumbers: ['100000000'],
	}])
	assert.deepEqual(result, { failures: {}, mismatches: {} })
	assert.equal(calls.length, 2)
	assert.ok(calls[0]!.includes('/wz/export/GMS/270/Map/WorldMap/WorldMap010.img?rawImage=true'))
	assert.ok(calls[1]!.endsWith('/Map/WorldMap/WorldMap010.img/BaseImg/0'))
})

test('publishes only exact BaseImg Canvas values after bulk and truncated raw cache sentinels', async () => {
	const image = `data:image/png;base64,${'a'.repeat(9000)}`
	const bulkImage: RawWzImageNode = {
		type: 1,
		children: {
			BaseImg: { type: 13, children: { 0: { type: 12, value: '__bulk-canvas__', children: { origin: { type: 9, value: { x: 320, y: 235, isEmpty: false }, children: {} } } } } },
		},
	}
	const node: GameWorldMap = {
		id: 'WorldMap010',
		worldMapName: 'WorldMap010',
		parentWorld: 'WorldMap',
		baseImages: [{ image, origin: { x: 320, y: 235 } }],
		links: [],
		maps: [],
		mapNumbers: [],
	}
	const cache = await mkdtemp(path.join(tmpdir(), 'world-map-raw-base-fallback-cache-'))
	try {
		const firstCalls: string[] = []
		const makeFetcher = (calls: string[]) => (async (url: string) => {
			calls.push(url)
			if (url.includes('/wz/export/') && url.endsWith('?rawImage=true'))
				return new Uint8Array([1, 2, 3])
			if (url.endsWith('/BaseImg/0'))
				return { children: ['origin'], type: 12, value: image }
			throw Object.assign(new Error(`not found: ${url}`), { status: 404 })
		}) as typeof import('ofetch').ofetch
		const first = new MapleStoryIoClient({ fetcher: makeFetcher(firstCalls), delayMs: 0, timeoutMs: 0, rawAuditCacheDir: cache, rawImageParser: async () => bulkImage })
		assert.deepEqual(await first.auditRawWorldMaps('GMS', '270', [node]), { failures: {}, mismatches: {} })
		assert.equal(firstCalls.length, 2)

		const auditResumeCalls: string[] = []
		const auditResume = new MapleStoryIoClient({
			fetcher: makeFetcher(auditResumeCalls),
			delayMs: 0,
			timeoutMs: 0,
			rawAuditCacheDir: cache,
			rawImageParser: async () => bulkImage,
		})
		assert.deepEqual(await auditResume.auditRawWorldMaps('GMS', '270', [node]), { failures: {}, mismatches: {} })
		assert.equal(auditResumeCalls.length, 0, 'normal audit should reuse the truncated Canvas cache and its exact hash')

		const fallbackCalls: string[] = []
		const fallback = new MapleStoryIoClient({
			fetcher: makeFetcher(fallbackCalls),
			delayMs: 0,
			timeoutMs: 0,
			rawAuditCacheDir: cache,
			rawImageParser: async () => bulkImage,
		})
		assert.deepEqual(await fallback.fetchRawWorldMapBaseImages('GMS', '270', 'WorldMap010'), [{ image, origin: { x: 320, y: 235 } }])
		assert.deepEqual(fallbackCalls.map(url => new URL(url).pathname), ['/api/wz/GMS/270/Map/WorldMap/WorldMap010.img/BaseImg/0'])
	}
	finally {
		await rm(cache, { recursive: true, force: true })
	}
})

test('audits MapLink Canvas renderability from the exact raw origin leaf', async () => {
	const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/6FA9WQAAAABJRU5ErkJggg=='
	const scalar = (type: number, value: unknown): RawWzImageNode => ({ type, value, children: {} })
	const bulkImage: RawWzImageNode = {
		type: 1,
		children: {
			BaseImg: { type: 13, children: { 0: { type: 12, value: '__bulk-canvas__', children: { origin: scalar(9, { x: 0, y: 0, isEmpty: false }) } } } },
			MapLink: { type: 13, children: { 0: { type: 13, children: { link: { type: 13, children: { linkMap: scalar(6, 'WorldMap011'), linkImg: { type: 12, value: '__bulk-canvas__', children: { origin: scalar(9, { x: 0, y: 0, isEmpty: false }) } } } }, toolTip: scalar(6, 'Nautilus') } } } },
		},
	}
	const calls: string[] = []
	const fetcher = (async (url: string) => {
		calls.push(url)
		if (url.includes('/wz/export/') && url.endsWith('?rawImage=true'))
			return new Uint8Array([1, 2, 3])
		if (url.endsWith('/BaseImg/0') || url.endsWith('/linkImg'))
			return { children: ['origin'], type: 12, value: image }
		if (url.endsWith('/linkImg/origin'))
			return { children: [], type: 9, value: { x: 0, y: 0, isEmpty: true } }
		throw Object.assign(new Error(`not found: ${url}`), { status: 404 })
	}) as typeof import('ofetch').ofetch
	const result = await new MapleStoryIoClient({ fetcher, delayMs: 0, timeoutMs: 0, rawImageParser: async () => bulkImage }).auditRawWorldMaps('GMS', '270', [{
		id: 'WorldMap010',
		worldMapName: 'WorldMap010',
		parentWorld: 'WorldMap',
		baseImages: [{ image, origin: { x: 0, y: 0 } }],
		links: [{ toolTip: 'Nautilus', linksTo: 'WorldMap011', linkImage: null }],
		maps: [],
		mapNumbers: [],
	}])
	assert.deepEqual(result, { failures: {}, mismatches: {} })
	assert.ok(calls.some(url => url.endsWith('/MapLink/0/link/linkImg/origin')))
})

test('pairs duplicate raw MapList entries by semantic spot/type instead of occurrence order', async () => {
	const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/6FA9WQAAAABJRU5ErkJggg=='
	const scalar = (type: number, value: unknown): RawWzImageNode => ({ type, value, children: {} })
	const duplicate = (type: number | string): RawWzImageNode => ({
		type: 13,
		children: {
			spot: scalar(9, { x: -34, y: -37, isEmpty: false }),
			type: scalar(2, type),
			mapNo: { type: 13, children: { 0: scalar(2, 104020100) } },
		},
	})
	const bulkImage: RawWzImageNode = {
		type: 1,
		children: {
			BaseImg: { type: 13, children: { 0: { type: 12, value: '__bulk-canvas__', children: { origin: scalar(9, { x: 0, y: 0, isEmpty: false }) } } } },
			MapList: { type: 13, children: { 7: duplicate('3'), 100: duplicate(5) } },
		},
	}
	const client = new MapleStoryIoClient({
		delayMs: 0,
		timeoutMs: 0,
		fetcher: (async (url: string) => {
			if (url.includes('/wz/export/') && url.endsWith('?rawImage=true'))
				return new Uint8Array([1])
			if (url.endsWith('/BaseImg/0'))
				return { children: ['origin'], type: 12, value: image }
			throw Object.assign(new Error(`not found: ${url}`), { status: 404 })
		}) as typeof import('ofetch').ofetch,
		rawImageParser: async () => bulkImage,
	})
	const result = await client.auditRawWorldMaps('GMS', '137', [{
		id: 'WorldMap010',
		worldMapName: 'WorldMap010',
		parentWorld: null,
		baseImages: [{ image, origin: { x: 0, y: 0 } }],
		links: [],
		maps: [
			{ spot: { x: -34, y: -37 }, type: 5, mapNumbers: ['104020100'] },
			{ spot: { x: -34, y: -37 }, type: 3, mapNumbers: ['104020100'] },
		],
		mapNumbers: ['104020100', '104020100'],
	}])
	assert.deepEqual(result, { failures: {}, mismatches: {} })
})

test('uses bulk String/Map.img and falls back to exact leaves for malformed or transient bulk paths', async () => {
	const bulkImage: RawWzImageNode = {
		type: 1,
		children: {
			victoria: { type: 13, children: { 100000000: { type: 13, children: { mapName: { type: 6, value: 'Henesys', children: {} }, streetName: { type: 6, value: 'Victoria Island', children: {} } } } } },
		},
	}
	const exactResponse = (url: string): unknown => {
		if (url.endsWith('/String/Map.img'))
			return { children: ['victoria'] }
		if (url.endsWith('/String/Map.img/victoria'))
			return { children: ['100000000'] }
		if (url.endsWith('/String/Map.img/victoria/100000000/mapName'))
			return { children: [], type: 8, value: 'Henesys exact' }
		if (url.endsWith('/String/Map.img/victoria/100000000/streetName'))
			return { children: [], type: 8, value: 'Victoria exact' }
		throw Object.assign(new Error(`not found: ${url}`), { status: 404 })
	}
	const bulkCalls: string[] = []
	const bulkFetcher = (async (url: string) => {
		bulkCalls.push(url)
		if (url.includes('/wz/export/') && url.endsWith('?rawImage=true'))
			return new Uint8Array([1, 2, 3])
		throw Object.assign(new Error(`unexpected bulk-only request: ${url}`), { status: 404 })
	}) as typeof import('ofetch').ofetch
	const bulkClient = new MapleStoryIoClient({ fetcher: bulkFetcher, delayMs: 0, timeoutMs: 0, rawImageParser: async () => bulkImage })
	assert.deepEqual(await bulkClient.fetchRawMapStringsByMapIds('GMS', '270', ['100000000', '200000000']), {
		values: {
			100000000: { name: 'Henesys', streetName: 'Victoria Island' },
			200000000: { name: null, streetName: null },
		},
		failures: {},
	})
	assert.equal(bulkCalls.length, 1)
	assert.ok(bulkCalls[0]!.includes('/wz/export/GMS/270/String/Map.img?rawImage=true'))

	const garbageCalls: string[] = []
	const garbageFetcher = (async (url: string) => {
		garbageCalls.push(url)
		if (url.includes('/wz/export/') && url.endsWith('?rawImage=true'))
			return new Uint8Array([1, 2, 3])
		return exactResponse(url)
	}) as typeof import('ofetch').ofetch
	const garbage = { type: 1, children: { metadata: { type: 13, children: { value: { type: 6, value: 'not a map category', children: {} } } } } } satisfies RawWzImageNode
	const garbageClient = new MapleStoryIoClient({ fetcher: garbageFetcher, delayMs: 0, timeoutMs: 0, rawImageParser: async () => garbage })
	assert.deepEqual(await garbageClient.fetchRawMapStringsByMapIds('GMS', '270', ['100000000']), {
		values: { 100000000: { name: 'Henesys exact', streetName: 'Victoria exact' } },
		failures: {},
	})
	assert.equal(garbageCalls.length, 5, 'nonempty garbage bulk tree must use exact category/leaf fallback')

	const malformedParser = async () => {
		throw new Error('malformed raw image')
	}
	const unusedParser = async () => {
		throw new Error('not used')
	}
	for (const [label, parser] of [['malformed', malformedParser], ['transient', unusedParser]] as const) {
		const calls: string[] = []
		const fetcher = (async (url: string) => {
			calls.push(url)
			if (url.includes('/wz/export/') && url.endsWith('?rawImage=true')) {
				if (label === 'transient')
					throw Object.assign(new Error('bulk timeout'), { status: 503 })
				return new Uint8Array([1, 2, 3])
			}
			return exactResponse(url)
		}) as typeof import('ofetch').ofetch
		const client = new MapleStoryIoClient({ fetcher, delayMs: 0, timeoutMs: 0, maxRetries: 0, rawImageParser: parser })
		assert.deepEqual(await client.fetchRawMapStringsByMapIds('GMS', '270', ['100000000']), {
			values: { 100000000: { name: 'Henesys exact', streetName: 'Victoria exact' } },
			failures: {},
		}, label)
		assert.equal(calls.length, 5, `${label} bulk attempt plus four exact fallback requests`)
	}

	const transientLeafFetcher = (async (url: string) => {
		if (url.includes('/wz/export/') && url.endsWith('?rawImage=true'))
			return new Uint8Array([1, 2, 3])
		if (url.endsWith('/String/Map.img'))
			return { children: ['victoria'] }
		if (url.endsWith('/String/Map.img/victoria'))
			return { children: ['100000000'] }
		if (url.endsWith('/mapName'))
			throw Object.assign(new Error('leaf timeout'), { status: 503 })
		if (url.endsWith('/streetName'))
			return { children: [], type: 8, value: 'Victoria exact' }
		throw Object.assign(new Error(`not found: ${url}`), { status: 404 })
	}) as typeof import('ofetch').ofetch
	const transientLeaf = new MapleStoryIoClient({
		fetcher: transientLeafFetcher,
		delayMs: 0,
		timeoutMs: 0,
		maxRetries: 0,
		rawImageParser: async () => { throw new Error('malformed raw image') },
	})
	assert.deepEqual(await transientLeaf.fetchRawMapStringsByMapIds('GMS', '270', ['100000000']), {
		values: {},
		failures: { 100000000: 'transient' },
	})
})

test('reuses only an intact persistent bulk raw-image cache entry', async () => {
	const cache = await mkdtemp(path.join(tmpdir(), 'world-map-raw-image-cache-'))
	const bulkImage: RawWzImageNode = { type: 1, children: { victoria: { type: 13, children: { 100000000: { type: 13, children: { mapName: { type: 6, value: 'Henesys', children: {} }, streetName: { type: 6, value: 'Victoria Island', children: {} } } } } } } }
	const makeFetcher = (calls: string[]) => (async (url: string) => {
		calls.push(url)
		if (url.includes('/wz/export/') && url.endsWith('?rawImage=true'))
			return new Uint8Array([1, 2, 3])
		if (url.endsWith('/String/Map.img'))
			return { children: ['victoria'] }
		if (url.endsWith('/String/Map.img/victoria'))
			return { children: ['100000000'] }
		if (url.endsWith('/String/Map.img/victoria/100000000/mapName'))
			return { children: [], type: 8, value: 'Henesys exact' }
		if (url.endsWith('/String/Map.img/victoria/100000000/streetName'))
			return { children: [], type: 8, value: 'Victoria exact' }
		throw Object.assign(new Error(`not found: ${url}`), { status: 404 })
	}) as typeof import('ofetch').ofetch
	try {
		const firstCalls: string[] = []
		const first = new MapleStoryIoClient({
			fetcher: makeFetcher(firstCalls),
			delayMs: 0,
			timeoutMs: 0,
			rawAuditCacheDir: cache,
			rawImageParser: async () => { throw new Error('local parser unavailable') },
		})
		assert.deepEqual(await first.fetchRawMapStringsByMapIds('GMS', '270', ['100000000']), {
			values: { 100000000: { name: 'Henesys exact', streetName: 'Victoria exact' } },
			failures: {},
		})
		assert.equal(firstCalls.length, 5)
		const manifest = JSON.parse(await readFile(path.join(cache, 'GMS', '270', 'manifest.json'), 'utf8')) as { entries: Record<string, { status?: string, rawImageFile?: string }> }
		assert.equal(manifest.entries['@raw-image/String/Map.img']?.status, 'ok', 'parser failure must not downgrade successful source acquisition')
		const imageFile = manifest.entries['@raw-image/String/Map.img']?.rawImageFile
		assert.equal(typeof imageFile, 'string')

		const resumedCalls: string[] = []
		const resumed = new MapleStoryIoClient({ fetcher: makeFetcher(resumedCalls), delayMs: 0, timeoutMs: 0, rawAuditCacheDir: cache, rawImageParser: async () => bulkImage })
		assert.deepEqual(await resumed.fetchRawMapStringsByMapIds('GMS', '270', ['100000000']), {
			values: { 100000000: { name: 'Henesys', streetName: 'Victoria Island' } },
			failures: {},
		})
		assert.equal(resumedCalls.length, 0)

		await writeFile(path.join(cache, 'GMS', '270', imageFile!), new Uint8Array([9]))
		const recoveredCalls: string[] = []
		const recovered = new MapleStoryIoClient({ fetcher: makeFetcher(recoveredCalls), delayMs: 0, timeoutMs: 0, rawAuditCacheDir: cache, rawImageParser: async () => bulkImage })
		await recovered.fetchRawMapStringsByMapIds('GMS', '270', ['100000000'])
		assert.equal(recoveredCalls.length, 1)
	}
	finally {
		await rm(cache, { recursive: true, force: true })
	}
})

test('resumes exact raw WZ inventory and map strings from the ignored source-scoped cache', async () => {
	const cache = await mkdtemp(path.join(tmpdir(), 'world-map-raw-cache-'))
	const failureCache = await mkdtemp(path.join(tmpdir(), 'world-map-raw-failure-cache-'))
	let firstRequests = 0
	const firstFetcher = (async (url: string) => {
		firstRequests++
		if (url.endsWith('/wz/GMS/270/Map/WorldMap'))
			return { children: ['WorldMap.img'] }
		if (url.endsWith('/wz/GMS/270/String/Map.img'))
			return { children: ['victoria'] }
		if (url.endsWith('/wz/GMS/270/String/Map.img/victoria'))
			return { children: ['100000000'] }
		if (url.endsWith('/wz/GMS/270/String/Map.img/victoria/100000000/mapName'))
			return { children: [], type: 8, value: 'Henesys raw' }
		if (url.endsWith('/wz/GMS/270/String/Map.img/victoria/100000000/streetName'))
			return { children: [], type: 8, value: 'Victoria raw' }
		throw Object.assign(new Error(`not found: ${url}`), { status: 404 })
	}) as typeof import('ofetch').ofetch
	try {
		const first = new MapleStoryIoClient({ fetcher: firstFetcher, delayMs: 0, timeoutMs: 0, rawAuditCacheDir: cache })
		assert.deepEqual(await first.listRawWorldMapIds('GMS', '270'), ['WorldMap'])
		assert.deepEqual(await first.fetchRawMapStringsByMapIds('GMS', '270', ['100000000']), {
			values: { 100000000: { name: 'Henesys raw', streetName: 'Victoria raw' } },
			failures: {},
		})
		assert.equal(firstRequests, 6)
		const manifest = JSON.parse(await readFile(path.join(cache, 'GMS', '270', 'manifest.json'), 'utf8')) as { entries?: Record<string, unknown> }
		assert.equal(Object.keys(manifest.entries ?? {}).length, 6)

		let resumedRequests = 0
		const resumedFetcher = (async () => {
			resumedRequests++
			throw new Error('network should not be needed for cached raw nodes')
		}) as unknown as typeof import('ofetch').ofetch
		const resumed = new MapleStoryIoClient({ fetcher: resumedFetcher, delayMs: 0, timeoutMs: 0, rawAuditCacheDir: cache })
		assert.deepEqual(await resumed.listRawWorldMapIds('GMS', '270'), ['WorldMap'])
		assert.deepEqual(await resumed.fetchRawMapStringsByMapIds('GMS', '270', ['100000000']), {
			values: { 100000000: { name: 'Henesys raw', streetName: 'Victoria raw' } },
			failures: {},
		})
		assert.equal(resumedRequests, 0)

		const transientFetcher = (async () => {
			throw Object.assign(new Error('upstream timeout'), { status: 500 })
		}) as unknown as typeof import('ofetch').ofetch
		const failed = new MapleStoryIoClient({ fetcher: transientFetcher, delayMs: 0, timeoutMs: 0, maxRetries: 0, rawAuditCacheDir: failureCache })
		await assert.rejects(() => failed.listRawWorldMapIds('GMS', '270'))
		const failureManifest = JSON.parse(await readFile(path.join(failureCache, 'GMS', '270', 'manifest.json'), 'utf8')) as { entries?: Record<string, { status?: string }> }
		assert.equal(failureManifest.entries?.['Map/WorldMap']?.status, 'transient')
		let recoveryRequests = 0
		const recoveryFetcher = (async (url: string) => {
			recoveryRequests++
			if (url.endsWith('/wz/GMS/270/Map/WorldMap'))
				return { children: ['WorldMap.img'] }
			throw Object.assign(new Error(`not found: ${url}`), { status: 404 })
		}) as typeof import('ofetch').ofetch
		const recovered = new MapleStoryIoClient({ fetcher: recoveryFetcher, delayMs: 0, timeoutMs: 0, rawAuditCacheDir: failureCache })
		assert.deepEqual(await recovered.listRawWorldMapIds('GMS', '270'), ['WorldMap'])
		assert.equal(recoveryRequests, 1)
	}
	finally {
		await rm(cache, { recursive: true, force: true })
		await rm(failureCache, { recursive: true, force: true })
	}
})

test('resumes exact normalized MapleStory.IO responses and retries transient cache entries', async () => {
	const cache = await mkdtemp(path.join(tmpdir(), 'world-map-normalized-cache-'))
	const partialCache = await mkdtemp(path.join(tmpdir(), 'world-map-normalized-partial-cache-'))
	const failureCache = await mkdtemp(path.join(tmpdir(), 'world-map-normalized-failure-cache-'))
	const worldMap = { worldMapName: 'Maple World', parentWorld: null, baseImage: [], links: [], maps: [] }
	try {
		let firstRequests = 0
		const firstFetcher = (async (url: string) => {
			firstRequests++
			if (url.endsWith('/map/worldmap'))
				return ['WorldMap']
			if (url.endsWith('/map/worldmap/WorldMap'))
				return worldMap
			if (url.endsWith('/map'))
				return [{ id: 100000000, name: 'Henesys', streetName: 'Victoria Island' }]
			if (url.endsWith('/map/100000000'))
				return { id: 100000000, mapMark: 'town', name: 'Henesys', streetName: 'Victoria Island', backgroundMusic: null }
			throw Object.assign(new Error(`not found: ${url}`), { status: 404 })
		}) as typeof import('ofetch').ofetch
		const first = new MapleStoryIoClient({ fetcher: firstFetcher, delayMs: 0, timeoutMs: 0, normalizedResponseCacheDir: cache })
		assert.deepEqual(await first.listWorldMapIds('GMS', '270'), ['WorldMap'])
		assert.equal((await first.fetchWorldMap('GMS', '270', 'WorldMap')).id, 'WorldMap')
		assert.deepEqual(await first.listMaps('GMS', '270'), [{ id: '100000000', name: 'Henesys', streetName: 'Victoria Island' }])
		assert.deepEqual(await first.fetchMap('GMS', '270', '100000000'), {
			id: '100000000',
			mapMark: 'town',
			name: 'Henesys',
			streetName: 'Victoria Island',
			backgroundMusic: null,
		})
		assert.equal(firstRequests, 4)
		const manifest = JSON.parse(await readFile(path.join(cache, 'GMS', '270', 'manifest.json'), 'utf8')) as { entries?: Record<string, unknown> }
		assert.equal(Object.keys(manifest.entries ?? {}).length, 4)
		const worldMapEntry = manifest.entries?.['/GMS/270/map/worldmap'] as { response?: unknown } | undefined
		assert.ok(worldMapEntry)
		worldMapEntry.response = ['tampered']
		await writeFile(path.join(cache, 'GMS', '270', 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8')
		let integrityRequests = 0
		const integrityClient = new MapleStoryIoClient({
			fetcher: (async (url: string) => {
				integrityRequests++
				assert.ok(url.endsWith('/map/worldmap'))
				return ['WorldMap']
			}) as typeof import('ofetch').ofetch,
			delayMs: 0,
			timeoutMs: 0,
			normalizedResponseCacheDir: cache,
		})
		assert.deepEqual(await integrityClient.listWorldMapIds('GMS', '270'), ['WorldMap'])
		assert.equal(integrityRequests, 1)

		let resumedRequests = 0
		const resumedFetcher = (async () => {
			resumedRequests++
			throw new Error('network should not be needed for cached normalized responses')
		}) as unknown as typeof import('ofetch').ofetch
		const resumed = new MapleStoryIoClient({ fetcher: resumedFetcher, delayMs: 0, timeoutMs: 0, normalizedResponseCacheDir: cache })
		assert.deepEqual(await resumed.listWorldMapIds('GMS', '270'), ['WorldMap'])
		assert.equal((await resumed.fetchWorldMap('GMS', '270', 'WorldMap')).id, 'WorldMap')
		assert.deepEqual(await resumed.listMaps('GMS', '270'), [{ id: '100000000', name: 'Henesys', streetName: 'Victoria Island' }])
		assert.equal((await resumed.fetchMap('GMS', '270', '100000000')).backgroundMusic, null)
		assert.equal(resumedRequests, 0)

		let partialFirstRequests = 0
		const partialFirstFetcher = (async (url: string) => {
			partialFirstRequests++
			if (url.endsWith('/map/worldmap'))
				return ['WorldMap']
			if (url.endsWith('/map/worldmap/WorldMap'))
				return worldMap
			throw Object.assign(new Error(`not found: ${url}`), { status: 404 })
		}) as typeof import('ofetch').ofetch
		const partialFirst = new MapleStoryIoClient({ fetcher: partialFirstFetcher, delayMs: 0, timeoutMs: 0, normalizedResponseCacheDir: partialCache })
		await partialFirst.listWorldMapIds('GMS', '270')
		await partialFirst.fetchWorldMap('GMS', '270', 'WorldMap')
		assert.equal(partialFirstRequests, 2)
		let partialResumeRequests = 0
		const partialResumeFetcher = (async (url: string) => {
			partialResumeRequests++
			if (url.endsWith('/map'))
				return [{ id: 100000000, name: 'Henesys', streetName: 'Victoria Island' }]
			if (url.endsWith('/map/100000000'))
				return { id: 100000000, mapMark: null, name: 'Henesys', streetName: 'Victoria Island', backgroundMusic: null }
			throw new Error(`unexpected uncached request: ${url}`)
		}) as typeof import('ofetch').ofetch
		const partialResume = new MapleStoryIoClient({ fetcher: partialResumeFetcher, delayMs: 0, timeoutMs: 0, normalizedResponseCacheDir: partialCache })
		assert.deepEqual(await partialResume.listWorldMapIds('GMS', '270'), ['WorldMap'])
		assert.equal((await partialResume.fetchWorldMap('GMS', '270', 'WorldMap')).id, 'WorldMap')
		await partialResume.listMaps('GMS', '270')
		await partialResume.fetchMap('GMS', '270', '100000000')
		assert.equal(partialResumeRequests, 2)

		const transientFetcher = (async () => {
			throw Object.assign(new Error('upstream timeout'), { status: 500 })
		}) as unknown as typeof import('ofetch').ofetch
		const failed = new MapleStoryIoClient({ fetcher: transientFetcher, delayMs: 0, timeoutMs: 0, maxRetries: 0, normalizedResponseCacheDir: failureCache })
		await assert.rejects(() => failed.listWorldMapIds('GMS', '270'))
		const failureManifest = JSON.parse(await readFile(path.join(failureCache, 'GMS', '270', 'manifest.json'), 'utf8')) as { entries?: Record<string, { status?: string }> }
		assert.equal(failureManifest.entries?.['/GMS/270/map/worldmap']?.status, 'transient')
		let recoveryRequests = 0
		const recoveryFetcher = (async (url: string) => {
			recoveryRequests++
			if (url.endsWith('/map/worldmap'))
				return ['WorldMap']
			throw Object.assign(new Error(`not found: ${url}`), { status: 404 })
		}) as typeof import('ofetch').ofetch
		const recovered = new MapleStoryIoClient({ fetcher: recoveryFetcher, delayMs: 0, timeoutMs: 0, maxRetries: 0, normalizedResponseCacheDir: failureCache })
		assert.deepEqual(await recovered.listWorldMapIds('GMS', '270'), ['WorldMap'])
		assert.equal(recoveryRequests, 1)

		let notFoundRequests = 0
		const notFoundFetcher = (async () => {
			notFoundRequests++
			throw Object.assign(new Error('missing map'), { status: 404 })
		}) as unknown as typeof import('ofetch').ofetch
		const notFound = new MapleStoryIoClient({ fetcher: notFoundFetcher, delayMs: 0, timeoutMs: 0, normalizedResponseCacheDir: failureCache })
		await assert.rejects(() => notFound.fetchMap('GMS', '270', '999999999'))
		const notFoundResume = new MapleStoryIoClient({
			fetcher: (async () => { throw new Error('404 should be resumed from cache') }) as unknown as typeof import('ofetch').ofetch,
			delayMs: 0,
			timeoutMs: 0,
			normalizedResponseCacheDir: failureCache,
		})
		await assert.rejects(() => notFoundResume.fetchMap('GMS', '270', '999999999'), /HTTP 404/)
		assert.equal(notFoundRequests, 1)
	}
	finally {
		await rm(cache, { recursive: true, force: true })
		await rm(partialCache, { recursive: true, force: true })
		await rm(failureCache, { recursive: true, force: true })
	}
})

test('audits raw WorldMap BaseImg, MapLink, and MapList against normalized fields', async () => {
	const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/6FA9WQAAAABJRU5ErkJggg=='
	const fetcher = (async (url: string) => {
		if (url.endsWith('/Map/WorldMap/WorldMap.img'))
			return { children: ['BaseImg', 'MapLink', 'MapList'], type: 1 }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/BaseImg'))
			return { children: ['0'], type: 13 }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/BaseImg/0'))
			return { children: ['origin'], type: 12, value: image }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/BaseImg/0/origin'))
			return { children: [], type: 9, value: { x: 0, y: 0, isEmpty: false } }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/MapLink'))
			return { children: ['0'], type: 13 }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/MapLink/0'))
			return { children: ['link', 'toolTip'], type: 13 }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/MapLink/0/toolTip'))
			return { children: [], type: 8, value: 'Grandis' }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/MapLink/0/link/linkMap'))
			return { children: [], type: 8, value: 'GWorldMap' }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/MapLink/0/link/linkImg'))
			return { children: [], type: 12, value: image }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/MapLink/0/link/linkImg/origin'))
			return { children: [], type: 9, value: { x: 0, y: 0, isEmpty: false } }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/MapList'))
			return { children: ['0'], type: 13 }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/MapList/0'))
			return { children: ['mapNo', 'spot', 'type'], type: 13 }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/MapList/0/spot'))
			return { children: [], type: 9, value: { x: 15, y: 25, isEmpty: false } }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/MapList/0/type'))
			return { children: [], type: 4, value: 1 }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/MapList/0/mapNo'))
			return { children: ['0'], type: 13 }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/MapList/0/mapNo/0'))
			return { children: [], type: 4, value: 100000000 }
		throw Object.assign(new Error(`not found: ${url}`), { status: 404 })
	}) as typeof import('ofetch').ofetch
	const node: GameWorldMap = {
		id: 'WorldMap',
		worldMapName: 'WorldMap',
		parentWorld: null,
		baseImages: [{ image, origin: { x: 0, y: 0 } }],
		links: [{ toolTip: 'Grandis', linksTo: 'GWorldMap', linkImage: { image, origin: { x: 0, y: 0 } } }],
		maps: [{ spot: { x: 15, y: 25 }, type: 1, mapNumbers: ['100000000'] }],
		mapNumbers: ['100000000'],
	}
	const client = new MapleStoryIoClient({ fetcher, delayMs: 0, timeoutMs: 0 })
	assert.deepEqual(await client.auditRawWorldMaps('GMS', '270', [node]), { failures: {}, mismatches: {} })

	const reorderedFetcher = (async (url: string) => {
		if (url.endsWith('/Map/WorldMap/WorldMap.img'))
			return { children: ['BaseImg', 'MapLink', 'MapList'], type: 1 }
		if (url.endsWith('/BaseImg'))
			return { children: ['0'], type: 13 }
		if (url.endsWith('/BaseImg/0'))
			return { children: ['origin'], type: 12, value: image }
		if (url.endsWith('/BaseImg/0/origin'))
			return { children: [], type: 9, value: { x: 0, y: 0, isEmpty: false } }
		if (url.endsWith('/MapLink'))
			return { children: ['0', '1'], type: 13 }
		if (url.endsWith('/MapLink/0'))
			return { children: ['link', 'toolTip'], type: 13 }
		if (url.endsWith('/MapLink/0/toolTip'))
			return { children: [], type: 8, value: 'Second' }
		if (url.endsWith('/MapLink/0/link/linkMap'))
			return { children: [], type: 8, value: 'WorldMap020' }
		if (url.endsWith('/MapLink/0/link/linkImg'))
			return null
		if (url.endsWith('/MapLink/1'))
			return { children: ['link', 'toolTip'], type: 13 }
		if (url.endsWith('/MapLink/1/toolTip'))
			return { children: [], type: 8, value: 'First' }
		if (url.endsWith('/MapLink/1/link/linkMap'))
			return { children: [], type: 8, value: 'WorldMap010' }
		if (url.endsWith('/MapLink/1/link/linkImg'))
			return null
		if (url.endsWith('/MapList'))
			return { children: ['0', '1'], type: 13 }
		if (url.endsWith('/MapList/0'))
			return { children: ['mapNo', 'spot', 'type'], type: 13 }
		if (url.endsWith('/MapList/0/spot'))
			return { children: [], type: 9, value: { x: 20, y: 20, isEmpty: false } }
		if (url.endsWith('/MapList/0/type'))
			return { children: [], type: 4, value: 1 }
		if (url.endsWith('/MapList/0/mapNo'))
			return { children: ['0'], type: 13 }
		if (url.endsWith('/MapList/0/mapNo/0'))
			return { children: [], type: 4, value: 200000000 }
		if (url.endsWith('/MapList/1'))
			return { children: ['mapNo', 'spot', 'type'], type: 13 }
		if (url.endsWith('/MapList/1/spot'))
			return { children: [], type: 9, value: { x: 10, y: 10, isEmpty: false } }
		if (url.endsWith('/MapList/1/type'))
			return { children: [], type: 4, value: 1 }
		if (url.endsWith('/MapList/1/mapNo'))
			return { children: ['0'], type: 13 }
		if (url.endsWith('/MapList/1/mapNo/0'))
			return { children: [], type: 4, value: 100000000 }
		throw Object.assign(new Error(`not found: ${url}`), { status: 404 })
	}) as typeof import('ofetch').ofetch
	const reordered = await new MapleStoryIoClient({ fetcher: reorderedFetcher, delayMs: 0, timeoutMs: 0 }).auditRawWorldMaps('GMS', '270', [{
		...node,
		links: [
			{ toolTip: 'First', linksTo: 'WorldMap010', linkImage: null },
			{ toolTip: 'Second', linksTo: 'WorldMap020', linkImage: null },
		],
		maps: [
			{ spot: { x: 10, y: 10 }, type: 1, mapNumbers: ['100000000'] },
			{ spot: { x: 20, y: 20 }, type: 1, mapNumbers: ['200000000'] },
		],
	}])
	assert.deepEqual(reordered, { failures: {}, mismatches: {} })

	const mismatchClient = new MapleStoryIoClient({
		fetcher: (async (url: string) => url.endsWith('/BaseImg')
			? { children: [], type: 13 }
			: fetcher(url)) as typeof import('ofetch').ofetch,
		delayMs: 0,
		timeoutMs: 0,
	})
	const mismatch = await mismatchClient.auditRawWorldMaps('GMS', '270', [node])
	assert.deepEqual(mismatch.failures, {})
	assert.deepEqual(mismatch.mismatches, { WorldMap: ['raw BaseImg has no Canvas'] })

	const assetMismatchClient = new MapleStoryIoClient({
		fetcher: (async (url: string) => {
			if (url.endsWith('/BaseImg/0') && !url.endsWith('/BaseImg/0/origin'))
				return { children: ['origin'], type: 12, value: `${image}changed` }
			return fetcher(url)
		}) as typeof import('ofetch').ofetch,
		delayMs: 0,
		timeoutMs: 0,
	})
	const assetMismatch = await assetMismatchClient.auditRawWorldMaps('GMS', '270', [node])
	assert.deepEqual(assetMismatch.failures, {})
	assert.deepEqual(assetMismatch.mismatches, { WorldMap: ['raw BaseImg Canvas bytes differ from normalized at index 0'] })
})

test('continues raw WorldMap audit after independent leaf failures and resumes cached siblings', async () => {
	const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/6FA9WQAAAABJRU5ErkJggg=='
	const cache = await mkdtemp(path.join(tmpdir(), 'world-map-raw-audit-sibling-cache-'))
	const node: GameWorldMap = {
		id: 'WorldMap',
		worldMapName: 'WorldMap',
		parentWorld: null,
		baseImages: [{ image, origin: { x: 0, y: 0 } }, { image, origin: { x: 1, y: 1 } }],
		links: [{ toolTip: 'Grandis', linksTo: 'GWorldMap', linkImage: null }],
		maps: [{ spot: { x: 15, y: 25 }, type: 1, mapNumbers: ['100000000'] }],
		mapNumbers: ['100000000'],
	}
	const transientPaths = new Set([
		'/Map/WorldMap/WorldMap.img/BaseImg/0/origin',
		'/Map/WorldMap/WorldMap.img/MapLink/0/toolTip',
	])
	const response = (url: string): unknown => {
		if (url.endsWith('/Map/WorldMap/WorldMap.img'))
			return { children: ['BaseImg', 'MapLink', 'MapList'], type: 1 }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/BaseImg'))
			return { children: ['0', '1'], type: 13 }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/BaseImg/0') || url.endsWith('/Map/WorldMap/WorldMap.img/BaseImg/1'))
			return { children: ['origin'], type: 12, value: image }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/BaseImg/1/origin'))
			return { children: [], type: 9, value: { x: 1, y: 1, isEmpty: false } }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/MapLink'))
			return { children: ['0'], type: 13 }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/MapLink/0'))
			return { children: ['link', 'toolTip'], type: 13 }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/MapLink/0/link/linkMap'))
			return { children: [], type: 8, value: 'GWorldMap' }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/MapLink/0/link/linkImg'))
			throw Object.assign(new Error('missing link image'), { status: 404 })
		if (url.endsWith('/Map/WorldMap/WorldMap.img/MapList'))
			return { children: ['0'], type: 13 }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/MapList/0'))
			return { children: ['mapNo', 'spot', 'type'], type: 13 }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/MapList/0/spot'))
			return { children: [], type: 9, value: { x: 15, y: 25, isEmpty: false } }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/MapList/0/type'))
			return { children: [], type: 4, value: 1 }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/MapList/0/mapNo'))
			return { children: ['0'], type: 13 }
		if (url.endsWith('/Map/WorldMap/WorldMap.img/MapList/0/mapNo/0'))
			return { children: [], type: 4, value: 100000000 }
		throw Object.assign(new Error(`not found: ${url}`), { status: 404 })
	}
	try {
		const firstCalls: string[] = []
		const firstFetcher = (async (url: string) => {
			firstCalls.push(url)
			const pathname = new URL(url).pathname.replace('/api/wz/GMS/270', '')
			if (transientPaths.has(pathname))
				throw Object.assign(new Error(`timeout: ${pathname}`), { status: 500 })
			return response(url)
		}) as typeof import('ofetch').ofetch
		const first = new MapleStoryIoClient({ fetcher: firstFetcher, delayMs: 0, timeoutMs: 0, maxRetries: 0, rawAuditCacheDir: cache })
		const incomplete = await first.auditRawWorldMaps('GMS', '270', [node])
		assert.deepEqual(incomplete.failures, { WorldMap: 'transient' })
		assert.deepEqual(incomplete.mismatches, {})
		assert.ok(firstCalls.some(url => url.endsWith('/MapList/0/spot')))
		assert.ok(!firstCalls.some(url => url.endsWith('/MapList/0')), 'MapList child container should not be fetched separately')
		assert.ok(firstCalls.some(url => url.endsWith('/MapLink/0/link/linkMap')))

		const recoveryCalls: string[] = []
		const recoveryFetcher = (async (url: string) => {
			recoveryCalls.push(url)
			const pathname = new URL(url).pathname.replace('/api/wz/GMS/270', '')
			if (pathname.endsWith('/BaseImg/0/origin'))
				return { children: [], type: 9, value: { x: 0, y: 0, isEmpty: false } }
			if (pathname.endsWith('/MapLink/0/toolTip'))
				return { children: [], type: 8, value: 'Grandis' }
			throw new Error(`successful raw sibling was not cached: ${url}`)
		}) as typeof import('ofetch').ofetch
		const recovered = new MapleStoryIoClient({ fetcher: recoveryFetcher, delayMs: 0, timeoutMs: 0, maxRetries: 0, rawAuditCacheDir: cache })
		assert.deepEqual(await recovered.auditRawWorldMaps('GMS', '270', [node]), { failures: {}, mismatches: {} })
		assert.deepEqual(recoveryCalls.map(url => new URL(url).pathname), [
			'/api/wz/GMS/270/Map/WorldMap/WorldMap.img/BaseImg/0/origin',
			'/api/wz/GMS/270/Map/WorldMap/WorldMap.img/MapLink/0/toolTip',
		])
	}
	finally {
		await rm(cache, { recursive: true, force: true })
	}
})

test('records the exact raw WorldMap inventory during full graph acquisition without replacing normalized transport', async () => {
	const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/6FA9WQAAAABJRU5ErkJggg=='
	class RawAuditClient extends MapleStoryIoClient {
		override async listWorldMapIds(): Promise<string[]> { return ['WorldMap'] }
		override async listRawWorldMapIds(): Promise<string[]> { return ['WorldMap'] }
		override async auditRawWorldMaps(): Promise<{ failures: Record<string, 'not-found' | 'transient' | 'invalid'>, mismatches: Record<string, string[]> }> { return { failures: {}, mismatches: {} } }
		override async fetchRawMapStringsByMapIds(): Promise<{ values: Record<string, { name: string | null, streetName: string | null }>, failures: Record<string, 'not-found' | 'transient' | 'invalid'> }> { return { values: {}, failures: {} } }

		override async fetchWorldMap(): Promise<GameWorldMap> {
			return { id: 'WorldMap', worldMapName: 'WorldMap', parentWorld: null, links: [], baseImages: [{ image, origin: { x: 0, y: 0 } }], maps: [], mapNumbers: [] }
		}

		override async listMaps(): Promise<[]> { return [] }
		override async fetchWorldMapNames(): Promise<Record<string, string>> { return {} }
	}
	const acquired = await acquireWorldMapGraph(new RawAuditClient({ delayMs: 0 }), 'GMS', '270', {
		mode: 'full',
		requests: [],
		logicalRegion: 'GMS',
		rawWzAudit: true,
	})
	assert.deepEqual(acquired.rawWzWorldMapIds, ['WorldMap'])
	assert.equal(acquired.nodes[0]?.id, 'WorldMap')
})

test('raw WZ inventory makes an unindexed normalized 500 target explicitly unresolved without blocking full completeness', async () => {
	const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/6FA9WQAAAABJRU5ErkJggg=='
	const attempted: string[] = []
	const transient = new MapleStoryIoRequestError('fixture', Object.assign(new Error('normalized endpoint failed'), { status: 500 }))
	class RawAuthoritativeClient extends MapleStoryIoClient {
		override async listWorldMapIds(): Promise<string[]> { return ['WorldMap'] }
		override async listRawWorldMapIds(): Promise<string[]> { return ['WorldMap'] }
		override async auditRawWorldMaps(): Promise<{ failures: Record<string, 'not-found' | 'transient' | 'invalid'>, mismatches: Record<string, string[]> }> { return { failures: {}, mismatches: {} } }
		override async fetchRawMapStringsByMapIds(): Promise<{ values: Record<string, { name: string | null, streetName: string | null }>, failures: Record<string, 'not-found' | 'transient' | 'invalid'> }> {
			return { values: { 100000000: { name: 'Henesys raw', streetName: 'Victoria raw' } }, failures: {} }
		}

		override async fetchWorldMap(_region: string, _version: string, id: string): Promise<GameWorldMap> {
			attempted.push(id)
			if (id === 'GWorldMap')
				throw transient
			return { id, worldMapName: id, parentWorld: null, links: [{ toolTip: 'Grandis', linksTo: 'GWorldMap', linkImage: null }], baseImages: [{ image, origin: { x: 0, y: 0 } }], maps: [{ spot: { x: 0, y: 0 }, type: 1, mapNumbers: ['100000000'] }], mapNumbers: ['100000000'] }
		}

		override async listMaps(): Promise<Array<{ id: string, name: string | null, streetName: string | null }>> { return [{ id: '100000000', name: 'Henesys normalized', streetName: 'Victoria normalized' }] }
		override async fetchMap(): Promise<GameMapDetail> { return { id: '100000000', name: 'Henesys detail', streetName: 'Victoria detail', mapMark: null, backgroundMusic: null } }
		override async fetchWorldMapNames(): Promise<Record<string, string>> { return {} }
	}
	const acquired = await acquireWorldMapGraph(new RawAuthoritativeClient({ delayMs: 0 }), 'GMS', '93', {
		mode: 'full',
		requests: [],
		logicalRegion: 'GMS',
		rawWzAudit: true,
	})
	assert.equal(acquired.completeness?.complete, true)
	assert.deepEqual(acquired.completeness?.rawWzAbsentWorldMapIds, ['GWorldMap'])
	assert.deepEqual(acquired.completeness?.worldMapUnindexedFailures, {})
	assert.deepEqual(attempted, ['WorldMap'])
	assert.deepEqual(acquired.maps[0], { id: '100000000', name: 'Henesys raw', streetName: 'Victoria raw', mapMark: null, backgroundMusic: null })
	const graph = normalizeWorldMapGraph(acquired, {
		baseImages: new Map([['WorldMap', [{ file: 'world-map/test/WorldMap.png', width: 1, height: 1, sha1: '0'.repeat(40), origin: { x: 0, y: 0 } }]]]),
		linkImages: new Map([['WorldMap', [null]]]),
	}, [])
	assert.equal(graph.nodes[0]!.links[0]!.targetWorldMapId, 'GWorldMap')

	class RawPresentFailureClient extends RawAuthoritativeClient {
		override async listRawWorldMapIds(): Promise<string[]> { return ['WorldMap', 'GWorldMap'] }
	}
	const rawPresentFailure = await acquireWorldMapGraph(new RawPresentFailureClient({ delayMs: 0 }), 'GMS', '93', {
		mode: 'full',
		requests: [],
		logicalRegion: 'GMS',
		rawWzAudit: true,
	})
	assert.equal(rawPresentFailure.completeness?.complete, false)
	assert.equal(rawPresentFailure.completeness?.worldMapUnindexedFailures.GWorldMap, 'transient')
	assert.deepEqual(rawPresentFailure.completeness?.rawWzUnindexedWorldMapIds, ['GWorldMap'])
	assert.deepEqual(rawPresentFailure.completeness?.rawWzAbsentWorldMapIds, [])

	class RawInventoryUnavailableClient extends RawAuthoritativeClient {
		override async listRawWorldMapIds(): Promise<string[]> { throw transient }
	}
	const rawInventoryUnavailable = await acquireWorldMapGraph(new RawInventoryUnavailableClient({ delayMs: 0 }), 'GMS', '93', {
		mode: 'full',
		requests: [],
		logicalRegion: 'GMS',
		rawWzAudit: true,
	})
	assert.equal(rawInventoryUnavailable.completeness?.complete, false)
	assert.equal(rawInventoryUnavailable.completeness?.rawWzInventoryComplete, false)
	assert.equal(rawInventoryUnavailable.completeness?.rawWzInventoryFailure, 'transient')

	class RawMapStringFailureClient extends RawAuthoritativeClient {
		override async fetchRawMapStringsByMapIds(): Promise<{ values: Record<string, { name: string | null, streetName: string | null }>, failures: Record<string, 'not-found' | 'transient' | 'invalid'> }> {
			return { values: {}, failures: { 100000000: 'transient' } }
		}
	}
	const rawMapStringFailure = await acquireWorldMapGraph(new RawMapStringFailureClient({ delayMs: 0 }), 'GMS', '93', {
		mode: 'full',
		requests: [],
		logicalRegion: 'GMS',
		rawWzAudit: true,
	})
	assert.equal(rawMapStringFailure.completeness?.complete, false)
	assert.equal(rawMapStringFailure.completeness?.rawWzMapStringFailures['100000000'], 'transient')
})

test('parses the sampled world-map source shape', () => {
	assert.equal(WORLD_MAP_SCHEMA_VERSION, 7)
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
		assert.equal(result.normalized.world.gameData?.version, '270')
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
	return { searchMaps: async (_region: string, _version: string, token: string) => search(token), fetchMap: async (_region: string, _version: string, id: string) => fetchMap(id) } as unknown as MapleStoryIoClient
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
	assert.equal(henesys.target.localizedNames['ko-KR-map-conflict']?.source.version, '389')
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
	assert.equal(await client.hasReadyVersion('GMS', '270'), true)
	assert.equal(await client.hasReadyVersion('GMS', '268'), false)
	assert.equal(await client.resolveLatestReadyVersion('GMS'), '270')
	await assert.rejects(client.resolveLatestReadyVersion('EMS'), /no ready numeric EMS version/)
})

test('accepts historical MapleStory.IO WorldMap payloads that omit worldMapName', async () => {
	const client = new MapleStoryIoClient({
		delayMs: 0,
		apiBase: 'https://fixture.example/api',
		fetcher: (async () => ({
			baseImage: [{ image: 'fixture', origin: { x: 0, y: 0 } }],
			links: [],
			maps: [],
		})) as never,
	})
	const worldMap = await client.fetchWorldMap('GMS', '93', 'WorldMap')
	assert.equal(worldMap.id, 'WorldMap')
	assert.equal(worldMap.worldMapName, 'WorldMap')
})

test('preserves requested WorldMap identity when MapleStory.IO resolves an aliased WZ screen name', async () => {
	const client = new MapleStoryIoClient({
		delayMs: 0,
		apiBase: 'https://fixture.example/api',
		fetcher: (async () => ({
			worldMapName: 'WorldMap000',
			parentWorld: 'WorldMap',
			baseImage: [{ image: 'fixture', origin: { x: 0, y: 0 } }],
			links: [],
			maps: [],
		})) as never,
	})
	const worldMap = await client.fetchWorldMap('TMS', '209', 'WorldMap167')
	assert.equal(worldMap.id, 'WorldMap167')
	assert.equal(worldMap.worldMapName, 'WorldMap000')
})

test('supports exact non-numeric version strings on MapleStory.IO client', async () => {
	const requestedUrls: string[] = []
	const client = new MapleStoryIoClient({
		delayMs: 0,
		apiBase: 'https://fixture.example/api',
		fetcher: (async (url: string) => {
			requestedUrls.push(url)
			if (url.endsWith('/wz')) {
				return [
					{ region: 'GMS', mapleVersionId: '40B', isReady: true, hasImages: true },
				]
			}
			if (url.includes('/map/worldmap/WorldMap000')) {
				return {
					worldMapName: 'WorldMap000',
					baseImage: [{ image: 'fixture', origin: { x: 0, y: 0 } }],
					links: [],
					maps: [],
				}
			}
			if (url.includes('/map/100000000')) {
				return {
					id: 100000000,
					name: 'Henesys',
				}
			}
			return []
		}) as never,
	})
	assert.equal(await client.hasReadyVersion('GMS', '40B'), true)
	const worldMap = await client.fetchWorldMap('GMS', '40B', 'WorldMap000')
	assert.equal(worldMap.id, 'WorldMap000')
	const map = await client.fetchMap('GMS', '40B', '100000000')
	assert.equal(map.name, 'Henesys')
	assert.ok(requestedUrls.some(u => u.includes('/api/GMS/40B/map/worldmap/WorldMap000')))
	assert.ok(requestedUrls.some(u => u.includes('/api/GMS/40B/map/100000000')))
})

test('reads exact raw map detail info and follows same-snapshot map links', async () => {
	const calls: string[] = []
	const fetcher = (async (url: string) => {
		calls.push(url)
		if (url.endsWith('/Map/Map/Map1/100000000.img/info'))
			return { children: ['link'] }
		if (url.endsWith('/Map/Map/Map1/100000000.img/info/link'))
			return { children: [], type: 2, value: 100000001 }
		if (url.endsWith('/Map/Map/Map1/100000001.img/info'))
			return { children: ['bgm', 'mapMark'] }
		if (url.endsWith('/Map/Map/Map1/100000001.img/info/bgm'))
			return { children: [], type: 8, value: 'Bgm00/FloralLife' }
		if (url.endsWith('/Map/Map/Map1/100000001.img/info/mapMark'))
			return { children: [], type: 8, value: 'Henesys' }
		throw Object.assign(new Error(`not found: ${url}`), { status: 404 })
	}) as typeof import('ofetch').ofetch
	const client = new MapleStoryIoClient({ fetcher, delayMs: 0, timeoutMs: 0 })
	assert.deepEqual(await client.fetchRawMapDetail('GMS', '270', '100000000'), {
		backgroundMusic: 'Bgm00/FloralLife',
		mapMark: 'Henesys',
		resolvedMapId: '100000001',
	})
	assert.equal(calls.length, 5)
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
	assert.deepEqual(await client.fetchMap('GMS', '270', '100000000'), {
		id: '100000000',
		mapMark: 'Henesys',
		name: 'Henesys',
		streetName: 'Henesys',
		backgroundMusic: 'Bgm00/FloralLife',
	})
})

test('bounds and phase-shifts full map-detail batches while preserving fetchMap results and failures', async () => {
	const sleepCalls: number[] = []
	let active = 0
	let maxActive = 0
	const releases: Array<() => void> = []
	class BatchClient extends MapleStoryIoClient {
		override async fetchMap(_region: string, _version: string, id: string): Promise<GameMapDetail> {
			active++
			maxActive = Math.max(maxActive, active)
			await new Promise<void>(resolve => releases.push(resolve))
			active--
			if (id === '5')
				throw Object.assign(new Error('detail timeout'), { status: 503 })
			return { id, mapMark: null, name: id, streetName: null, backgroundMusic: null }
		}
	}
	const client = new BatchClient({
		delayMs: 1000,
		sleep: async (ms) => {
			sleepCalls.push(ms)
		},
	})
	const pending = client.fetchMapsBounded('GMS', '270', ['1', '2', '3', '4', '5'], 4)
	await new Promise<void>(resolve => setImmediate(resolve))
	assert.equal(active, 4)
	assert.equal(maxActive, 4)
	assert.deepEqual(sleepCalls.sort((a, b) => a - b), [250, 500, 750])
	while (releases.length > 0)
		releases.shift()!()
	await new Promise<void>(resolve => setImmediate(resolve))
	while (releases.length > 0)
		releases.shift()!()
	const results = await pending
	assert.equal(results.length, 5)
	assert.equal(results[0]?.status, 'fulfilled')
	assert.equal(results[4]?.status, 'rejected')
})

test('spaces concurrent normalized map-detail starts at the bounded aggregate rate', async () => {
	const sleepCalls: number[] = []
	const releases: Array<() => void> = []
	const started: string[] = []
	const flush = () => new Promise<void>(resolve => setImmediate(resolve))
	const client = new MapleStoryIoClient({
		delayMs: 25,
		timeoutMs: 0,
		maxRetries: 0,
		sleep: async (ms) => {
			sleepCalls.push(ms)
			await new Promise<void>(resolve => releases.push(resolve))
		},
		fetcher: (async (url: string) => {
			started.push(url)
			const id = url.split('/').at(-1)!
			return { id: Number(id), mapMark: null, name: id, streetName: null, backgroundMusic: null }
		}) as never,
	})

	const pending = Promise.all([
		client.fetchMap('GMS', '270', '1'),
		client.fetchMap('GMS', '270', '2'),
	])
	await flush()
	assert.deepEqual(sleepCalls, [7])
	assert.deepEqual(started, [])

	releases.shift()!()
	await flush()
	assert.equal(started.length, 1)
	assert.deepEqual(sleepCalls, [7, 7])

	releases.shift()!()
	await pending
	assert.equal(started.length, 2)
})

test('spaces concurrent raw MapleStory.IO request starts without reducing aggregate audit rate', async () => {
	const sleepCalls: number[] = []
	const releases: Array<() => void> = []
	const started: string[] = []
	const flush = () => new Promise<void>(resolve => setImmediate(resolve))
	const client = new MapleStoryIoClient({
		delayMs: 25,
		timeoutMs: 0,
		maxRetries: 0,
		sleep: async (ms) => {
			sleepCalls.push(ms)
			await new Promise<void>(resolve => releases.push(resolve))
		},
		fetcher: (async (url: string) => {
			started.push(url)
			return { children: [] }
		}) as never,
	})

	const pending = Promise.all([
		client.listRawWorldMapIds('GMS', '270'),
		client.listRawWorldMapIds('GMS', '269'),
	])
	await flush()
	assert.deepEqual(sleepCalls, [7])
	assert.deepEqual(started, [])

	releases.shift()!()
	await flush()
	assert.equal(started.length, 1)
	assert.deepEqual(sleepCalls, [7, 7])

	releases.shift()!()
	await pending
	assert.equal(started.length, 2)
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
	assert.equal(await transientClient.resolveLatestReadyVersion('GMS'), '270')
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
	await assert.rejects(malformedClient.fetchWorldMap('GMS', '270', 'WorldMap010'), /malformed world map/)
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

test('validates archived-WZ provenance without requiring cache paths or packed offsets', async () => {
	const result = await normalizeAndValidate(CERNIUM_FIXTURE)
	try {
		const archivedWz = {
			providerRegion: 'TWMS',
			providerVersion: '158',
			archiveItem: 'synthetic-archive',
			archiveFile: 'v158.7z',
			archiveSha1: '1'.repeat(40),
			members: {
				stringWz: { name: 'String.wz' as const, sha256: '2'.repeat(64) },
				mapWz: { name: 'Map.wz' as const, sha256: '3'.repeat(64) },
			},
		}
		const valid = structuredClone(result.index)
		valid.worlds[0]!.gameData = {
			provider: 'archived-wz',
			region: 'TWMS',
			logicalRegion: 'TWMS',
			version: '158',
			apiBase: 'https://archive.org/download/synthetic-archive',
			archivedWz,
		}
		await validateWorldMapIndex(valid, { assetRoot: result.assetRoot, bgmIds: new Set(CERNIUM_FIXTURE.catalog.map(item => item.filename)), canonicalSourceRegion: 'TWMS' })
		const invalid = structuredClone(valid)
		invalid.worlds[0]!.gameData!.archivedWz!.archiveSha1 = 'bad'
		await assert.rejects(
			validateWorldMapIndex(invalid, { assetRoot: result.assetRoot, bgmIds: new Set(CERNIUM_FIXTURE.catalog.map(item => item.filename)), canonicalSourceRegion: 'TWMS' }),
			/archivedWz is (?:required and )?invalid/,
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

test('prefers same-snapshot String/WorldMap names over inbound link tooltips', () => {
	const fixture = graphFixture()
	fixture.acquired.worldMapNames = { WorldMap: 'Maple World', WorldMap010: 'Victoria Island' }
	fixture.acquired.nodes[0]!.links[0]!.toolTip = 'Not the canonical child title'
	const graph = normalizeWorldMapGraph(fixture.acquired, graphAssets(fixture.acquired), fixture.catalog)
	const root = graph.nodes.find(node => node.worldMapId === 'WorldMap')!
	const victoria = graph.nodes.find(node => node.worldMapId === 'WorldMap010')!
	assert.equal(root.canonicalLabel, 'Maple World')
	assert.equal(root.canonicalLabelSource, 'string-wz')
	assert.equal(victoria.canonicalLabel, 'Victoria Island')
	assert.equal(victoria.canonicalLabelSource, 'string-wz')
	assert.equal(root.links[0]!.canonicalLabel, 'Not the canonical child title')
})
