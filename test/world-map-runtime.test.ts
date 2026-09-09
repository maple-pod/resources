/* eslint-disable test/no-import-node-test */
import type { WorldMapGraph, WorldMapNode } from '../world-map/schema'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { compileWorldMapRuntime, validateWorldMapRuntime, validateWorldMapRuntimeOutput, writeWorldMapRuntime } from '../world-map/runtime'
import { WORLD_MAP_SCHEMA_VERSION } from '../world-map/schema'

const source = {
	provider: 'maplestory-io' as const,
	region: 'GMS',
	version: 270,
	apiBase: 'https://maplestory.io/api',
}
const unavailableSource = { ...source, version: null }

function asset(file: string) {
	return {
		file,
		width: 100,
		height: 80,
		sha1: '0'.repeat(40),
		origin: { x: 0, y: 0 },
	}
}

function node(id: string, parentWorldMapId: string | null, links: WorldMapNode['links'], maps: WorldMapNode['spots'][number]['maps'] = []): WorldMapNode {
	return {
		worldMapId: id,
		worldMapName: id,
		canonicalLabel: null,
		localizedNames: {},
		parentWorldMapId,
		baseImages: [asset(`world-map/gms/270/${id}/base-0.png`)],
		links,
		spots: maps.length === 0
			? []
			: [{
					id: 'spot-0',
					spot: { x: 10, y: 20 },
					type: 1,
					mapNumbers: maps.map(map => map.mapId),
					point: { x: 10, y: 20, normalizedX: 0.1, normalizedY: 0.25 },
					hitRect: null,
					maps,
				}],
		provenance: source,
	}
}

function fixtureIndex() {
	const link = (id: string, targetWorldMapId: string): WorldMapNode['links'][number] => ({
		id,
		canonicalLabel: targetWorldMapId,
		localizedNames: {},
		targetWorldMapId,
		linkImage: null,
		screenOrigin: { x: 10, y: 20 },
		hitRect: null,
	})
	const graph: WorldMapGraph = {
		roots: ['WorldMap'],
		nodes: [
			node('WorldMap', null, [link('link-0', 'WorldMap010')]),
			node('WorldMap010', 'WorldMap', [link('link-0', 'WorldMapMissing')], [{
				mapId: '100000000',
				name: 'Henesys',
				streetName: 'Henesys',
				mapMark: 'Henesys',
				localizedNames: {
					'ko-KR': {
						name: null,
						source: unavailableSource,
						status: 'unavailable',
						join: null,
					},
					'zh-TW': {
						name: '弓箭手村',
						source,
						status: 'available',
						join: 'mapId',
					},
				},
				gameBgm: null,
				selection: { trackId: 'Henesys', source: 'gms-map-bgm' },
			}]),
			node('WorldMapOrphan', 'WorldMapMissing', []),
		],
	}
	return {
		index: {
			schemaVersion: WORLD_MAP_SCHEMA_VERSION,
			generatedAt: '2026-09-09T00:00:00.000Z',
			graph,
			worlds: [],
		},
		graph,
	}
}

const bgmIds = new Set(['Henesys'])

test('compiles deterministic runtime manifest and preserves node and playback identities', async () => {
	const { index, graph } = fixtureIndex()
	const first = compileWorldMapRuntime(index, { bgmIds })
	const second = compileWorldMapRuntime(index, { bgmIds })
	assert.deepEqual(second.manifest, first.manifest)
	assert.deepEqual([...second.chunks], [...first.chunks])
	assert.equal(first.manifest.nodeCount, graph.nodes.length)
	assert.deepEqual(first.manifest.nodes.map(entry => entry.worldMapId), graph.nodes.map(node => node.worldMapId))
	assert.deepEqual(first.manifest.roots, graph.roots)
	assert.deepEqual(first.manifest.nodes[1]!.missingLinkTargetWorldMapIds, ['WorldMapMissing'])
	assert.equal(first.manifest.nodes[2]!.missingParentWorldMapId, 'WorldMapMissing')
	assert.deepEqual(first.manifest.unresolved, {
		missingParentWorldMapIds: ['WorldMapMissing'],
		missingLinkTargetWorldMapIds: ['WorldMapMissing'],
	})

	const outputDirectory = await mkdtemp(path.join(tmpdir(), 'world-map-runtime-'))
	try {
		const worldMapDirectory = path.join(outputDirectory, 'world-map')
		const written = await writeWorldMapRuntime(index, worldMapDirectory, { bgmIds })
		const manifest = await validateWorldMapRuntimeOutput(worldMapDirectory, { bgmIds })
		assert.equal(manifest.cacheKey, written.manifest.cacheKey)
		assert.equal(written.nodeFiles.length, graph.nodes.length)
		const manifestText = await readFile(path.join(worldMapDirectory, 'manifest.json'), 'utf8')
		assert.equal(manifestText, `${JSON.stringify(JSON.parse(manifestText))}\n`)

		const expectedTrackIds = graph.nodes.flatMap(node => node.spots.flatMap(spot => spot.maps.map(map => `${node.worldMapId}/${map.mapId}:${map.selection.trackId}`)))
		const actualTrackIds: string[] = []
		for (const entry of manifest.nodes) {
			const chunkText = await readFile(path.join(worldMapDirectory, entry.chunk), 'utf8')
			assert.equal(chunkText, `${JSON.stringify(JSON.parse(chunkText))}\n`)
			const chunk = JSON.parse(chunkText) as { node: WorldMapNode }
			for (const spot of chunk.node.spots) {
				for (const map of spot.maps)
					actualTrackIds.push(`${chunk.node.worldMapId}/${map.mapId}:${map.selection.trackId}`)
			}
		}
		assert.deepEqual(actualTrackIds, expectedTrackIds)
	}
	finally {
		await rm(outputDirectory, { recursive: true, force: true })
	}
})

test('validates roots, unresolved parents/links, exact chunks, and self-consistency', () => {
	const { index } = fixtureIndex()
	const options = { bgmIds }
	const compiled = compileWorldMapRuntime(index, options)

	const invalidRoot = structuredClone(compiled.manifest)
	invalidRoot.roots = ['WorldMapMissing']
	assert.throws(() => validateWorldMapRuntime(invalidRoot, compiled.chunks, options), /manifest root WorldMapMissing/)

	const invalidParent = structuredClone(compiled.manifest)
	invalidParent.nodes.find(entry => entry.worldMapId === 'WorldMap010')!.parentWorldMapId = 'WorldMapMissing'
	assert.throws(() => validateWorldMapRuntime(invalidParent, compiled.chunks, options), /childWorldMapIds|unindexed missing parent/)

	const invalidMissingParentIndex = structuredClone(compiled.manifest)
	invalidMissingParentIndex.nodes.find(entry => entry.worldMapId === 'WorldMapOrphan')!.missingParentWorldMapId = null
	assert.throws(() => validateWorldMapRuntime(invalidMissingParentIndex, compiled.chunks, options), /unindexed missing parent/)

	const invalidChunk = new Map(compiled.chunks)
	const rootChunk = invalidChunk.get('nodes/WorldMap.json')!
	invalidChunk.set('nodes/WorldMap.json', { ...rootChunk, node: { ...rootChunk.node, worldMapId: 'WorldMapChanged' } })
	assert.throws(() => validateWorldMapRuntime(compiled.manifest, invalidChunk, options), /wrong worldMapId|does not match its manifest entry/)
})
