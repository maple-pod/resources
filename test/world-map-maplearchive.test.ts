/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { MapleStoryIoClient } from '../world-map/acquire'
import { resolveWorldMapGenerationSnapshot, runWorldMapGeneration } from '../world-map/generate'
import { acquireMapleArchiveWorldMapGraph, MapleArchiveClient } from '../world-map/maplearchive'

async function pngArrayBuffer(width: number, height: number): Promise<ArrayBuffer> {
	const bytes = await sharp({
		create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
	})
		.png()
		.toBuffer()
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

test('uses MapleArchive only when the exact release has imported game data', async () => {
	class FixtureArchiveClient extends MapleArchiveClient {
		override async findRelease(_region: 'GMS' | 'TWMS', version: string) {
			return version === '122'
				? { id: 'release-122', region_slug: 'twms', version_label: '122', sequence: 122, released_on: null, has_patch_notes: true, has_game_data: true }
				: version === '124'
					? { id: 'release-124', region_slug: 'twms', version_label: '124', sequence: 124, released_on: null, has_patch_notes: true, has_game_data: false }
					: null
		}
	}
	const mio = new MapleStoryIoClient({
		delayMs: 0,
		timeoutMs: 0,
		fetcher: (async () => []) as unknown as typeof import('ofetch').ofetch,
	})
	const archive = new FixtureArchiveClient({ delayMs: 0, timeoutMs: 0 })
	assert.deepEqual(await resolveWorldMapGenerationSnapshot(mio, { region: 'TWMS', version: '122' }, archive), {
		id: 'TWMS/122',
		region: 'TWMS',
		version: '122',
		provider: 'maplearchive',
		providerRegion: 'twms',
	})
	await assert.rejects(
		resolveWorldMapGenerationSnapshot(mio, { region: 'TWMS', version: '123' }, archive),
		/archived-WZ provider is required/,
	)
	await assert.rejects(
		resolveWorldMapGenerationSnapshot(mio, { region: 'TWMS', version: '124' }, archive, { workspace: '/nonexistent' }),
		/Archived WZ generation for TWMS\/124 requires cached String\.wz/,
	)
	assert.deepEqual(await resolveWorldMapGenerationSnapshot(mio, { region: 'TWMS', version: '124' }, archive, {
		workspace: '/nonexistent',
		archivedWzPaths: { stringWzFile: '/fixture/String.wz', mapWzFile: '/fixture/Map.wz' },
	}), {
		id: 'TWMS/124',
		region: 'TWMS',
		version: '124',
		provider: 'archived-wz',
		providerRegion: 'TWMS',
	})
})

test('generates an exact historical TWMS snapshot through the MapleArchive adapter', async () => {
	const calls: string[] = []
	const fetcher = (async (url: string, options?: { responseType?: string }) => {
		calls.push(url)
		if (url.endsWith('/regions/twms/releases')) {
			return [{
				id: 'release-twms-122',
				region_slug: 'twms',
				version_label: '122',
				sequence: 122,
				released_on: '2010-11-25',
				has_patch_notes: true,
				has_game_data: true,
			}]
		}
		if (url.includes('/releases/release-twms-122/world-maps')) {
			return {
				screens: [
					{
						name: 'WorldMap',
						width: 640,
						height: 470,
						base: { token: 'root-base', x: 0, y: 0, width: 640, height: 470 },
						spots: [{ x: 100, y: 200, kind: 3, map_ids: [100000000, 100000001] }],
						links: [{
							name: 'WorldMap010',
							tool_tip: '維多利亞島',
							image: { token: 'root-link', x: 18, y: 91, width: 133, height: 121 },
						}],
					},
					{
						name: 'WorldMap010',
						parent: 'WorldMap',
						width: 640,
						height: 470,
						base: { token: 'victoria-base', x: 0, y: 0, width: 640, height: 470 },
						spots: [{ x: 90, y: 168, kind: 3, map_ids: [101000000] }],
						links: [],
					},
				],
				markers: [],
			}
		}
		if (url.includes('/scene-sprites/')) {
			assert.equal(options?.responseType, 'arrayBuffer')
			return url.endsWith('/root-link') ? pngArrayBuffer(133, 121) : pngArrayBuffer(640, 470)
		}
		if (url.includes('/maps/100000000/revisions/release-twms-122')) {
			return {
				map_id: 100000000,
				name: '弓箭手村',
				street_name: '維多利亞',
				info: [
					{ key: 'bgm', value: 'Bgm00/FloralLife' },
					{ key: 'mapMark', value: 'Henesys' },
				],
			}
		}
		if (url.includes('/maps/100000001/revisions/release-twms-122')) {
			return {
				map_id: 100000001,
				name: '弓箭手村武器店',
				street_name: '維多利亞',
				info: [{ key: 'bgm', value: 'Bgm00/FloralLife' }],
			}
		}
		if (url.includes('/maps/101000000/revisions/release-twms-122')) {
			return {
				map_id: 101000000,
				name: '魔法森林',
				street_name: '維多利亞',
				info: [{ key: 'bgm', value: 'Bgm00/FloralLife' }],
			}
		}
		throw new Error(`Unexpected MapleArchive request: ${url}`)
	}) as typeof import('ofetch').ofetch

	const root = await mkdtemp(path.join(tmpdir(), 'world-map-maplearchive-generation-'))
	try {
		const catalogSource = path.join(root, 'catalog-source.json')
		await writeFile(catalogSource, '[]\n')
		const archiveClient = new MapleArchiveClient({
			apiBase: 'https://maplearchive.app/api',
			delayMs: 0,
			timeoutMs: 0,
			maxRetries: 0,
			fetcher,
		})
		const gameClient = new MapleStoryIoClient({
			delayMs: 0,
			timeoutMs: 0,
			fetcher: (async () => {
				throw new Error('MapleStory.IO must not be queried for TWMS/122')
			}) as unknown as typeof import('ofetch').ofetch,
		})
		const result = await runWorldMapGeneration({
			mode: 'full',
			snapshot: { region: 'TWMS', version: '122' },
			outputDir: root,
			catalogSource,
			gameClient,
			mapleArchiveClient: archiveClient,
			generatedAt: '2026-09-10T00:00:00.000Z',
		})
		assert.equal(result.snapshotId, 'TWMS/122')

		const manifest = JSON.parse(await readFile(path.join(root, 'world-map/snapshots/TWMS/122/manifest.json'), 'utf8')) as {
			source: { provider: string, region: string, logicalRegion?: string, version: string, releaseId?: string }
			assets: { nativeWz: { pathPrefix: string } }
			nodes: Array<{ worldMapId: string, canonicalLabel: string | null }>
		}
		assert.deepEqual(manifest.source, {
			provider: 'maplearchive',
			region: 'twms',
			logicalRegion: 'TWMS',
			version: '122',
			apiBase: 'https://maplearchive.app/api',
			releaseId: 'release-twms-122',
		})
		assert.equal(manifest.assets.nativeWz.pathPrefix, 'world-map/snapshots/TWMS/122/assets')
		assert.equal(manifest.nodes.find(node => node.worldMapId === 'WorldMap010')?.canonicalLabel, '維多利亞島')

		const rootChunk = JSON.parse(await readFile(path.join(root, 'world-map/snapshots/TWMS/122/nodes/WorldMap.json'), 'utf8')) as {
			node: { links: Array<{ screenOrigin: { x: number, y: number }, hitRect: { left: number, top: number } | null }> }
		}
		assert.deepEqual(rootChunk.node.links[0]?.screenOrigin, { x: 18, y: 91 })
		const rootMaps = (rootChunk as unknown as { node: { spots: Array<{ maps: Array<{ mapId: string, name: string | null }> }> } }).node.spots[0]!.maps
		assert.equal(rootMaps.find(map => map.mapId === '100000001')?.name, '弓箭手村武器店')
		assert.deepEqual(rootChunk.node.links[0]?.hitRect == null
			? null
			: {
					left: rootChunk.node.links[0].hitRect.left,
					top: rootChunk.node.links[0].hitRect.top,
				}, { left: 0.028125, top: 0.193617 })

		const childChunk = JSON.parse(await readFile(path.join(root, 'world-map/snapshots/TWMS/122/nodes/WorldMap010.json'), 'utf8')) as {
			node: {
				canonicalLabelSource?: string | null
				spots: Array<{ maps: Array<{ mapId: string, name: string | null, streetName: string | null, gameBgm: { path: string } | null }> }>
			}
		}
		assert.equal(childChunk.node.canonicalLabelSource, 'inbound-link-tooltip')
		assert.deepEqual(childChunk.node.spots[0]?.maps[0], {
			mapId: '101000000',
			name: '魔法森林',
			streetName: '維多利亞',
			mapMark: null,
			localizedNames: {},
			gameBgm: { path: 'Bgm00/FloralLife', structure: 'Bgm00', filename: 'FloralLife', trackId: null },
			selection: { trackId: null, source: null },
		})

		const catalog = JSON.parse(await readFile(path.join(root, 'world-map/catalog.json'), 'utf8')) as {
			entries: Array<{ id: string, mapleArchive: unknown, fingerprint: unknown }>
		}
		const entry = catalog.entries.find(candidate => candidate.id === 'TWMS/122')!
		assert.equal((entry as { selectable?: boolean }).selectable, true)
		assert.deepEqual(entry.mapleArchive, { provider: 'maplearchive', regionSlug: 'twms', versionLabel: '122' })
		assert.ok(entry.fingerprint)
		assert.ok(calls.some(url => url.includes('/scene-sprites/root-link')))
	}
	finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('MapleArchive deterministic missing map details remain nullable but transient details block full completeness', async () => {
	const image = Buffer.from(await pngArrayBuffer(1, 1)).toString('base64')
	class FixtureArchiveClient extends MapleArchiveClient {
		constructor(private readonly failure: Error) { super({ delayMs: 0, timeoutMs: 0, maxRetries: 0 }) }
		override async resolveRelease() {
			return { id: 'release-122', region_slug: 'twms', version_label: '122', sequence: 122, released_on: null, has_patch_notes: true, has_game_data: true }
		}

		override async fetchWorldMaps() {
			return {
				screens: [{ name: 'WorldMap', width: 1, height: 1, base: { token: 'base', x: 0, y: 0, width: 1, height: 1 }, spots: [{ x: 0, y: 0, kind: 1, map_ids: [100000000] }], links: [] }],
				markers: [],
			}
		}

		override async fetchSpriteBase64(): Promise<string> { return image }
		override async fetchMap(): Promise<never> { throw this.failure }
	}
	const options = { mode: 'full' as const, requests: [], logicalRegion: 'TWMS' as const }
	const missing = await acquireMapleArchiveWorldMapGraph(new FixtureArchiveClient(Object.assign(new Error('missing historical map'), { status: 404 })), 'TWMS', '122', options)
	assert.equal(missing.completeness?.complete, true)
	assert.equal(missing.completeness?.mapDetailFailures['100000000'], 'not-found')
	const transient = await acquireMapleArchiveWorldMapGraph(new FixtureArchiveClient(Object.assign(new Error('archive unavailable'), { status: 503 })), 'TWMS', '122', options)
	assert.equal(transient.completeness?.complete, false)
	assert.equal(transient.completeness?.mapDetailFailures['100000000'], 'transient')
})
