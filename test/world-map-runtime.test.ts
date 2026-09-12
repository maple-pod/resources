/* eslint-disable test/no-import-node-test */
import type { WorldMapGraph, WorldMapNode } from '../world-map/schema'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { compileWorldMapRuntime, validateWorldMapRuntime, validateWorldMapRuntimeOutput, validateWorldMapRuntimeOutputAgainstIndex, writeWorldMapRuntime } from '../world-map/runtime'
import { WORLD_MAP_SCHEMA_VERSION } from '../world-map/schema'

const source = {
	provider: 'maplestory-io' as const,
	region: 'GMS',
	version: '270',
	apiBase: 'https://maplestory.io/api',
}
const unavailableSource = { ...source, version: null }
const archivedProvenance = {
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
		hitPath: null,
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

test('binds persisted runtime chunks to the canonical world-maps graph', async () => {
	const { index } = fixtureIndex()
	const outputDirectory = await mkdtemp(path.join(tmpdir(), 'world-map-runtime-binding-'))
	try {
		const worldMapDirectory = path.join(outputDirectory, 'world-map')
		await writeWorldMapRuntime(index, worldMapDirectory, { bgmIds })
		await validateWorldMapRuntimeOutputAgainstIndex(worldMapDirectory, index, { bgmIds })

		const chunkFile = path.join(worldMapDirectory, 'nodes/WorldMap010.json')
		const chunk = JSON.parse(await readFile(chunkFile, 'utf8')) as { node: { spots: Array<{ maps: Array<{ name: string | null }> }> } }
		chunk.node.spots[0]!.maps[0]!.name = 'Tampered name'
		await writeFile(chunkFile, `${JSON.stringify(chunk)}\n`, 'utf8')

		await validateWorldMapRuntimeOutput(worldMapDirectory, { bgmIds })
		await assert.rejects(
			validateWorldMapRuntimeOutputAgainstIndex(worldMapDirectory, index, { bgmIds }),
			/does not match canonical world-maps\.json/,
		)
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
	const wrongProvenanceChunk = new Map(compiled.chunks)
	wrongProvenanceChunk.set('nodes/WorldMap.json', { ...rootChunk, node: { ...rootChunk.node, provenance: { ...rootChunk.node.provenance, apiBase: 'https://wrong-provider.example/api' } } })
	assert.throws(() => validateWorldMapRuntime(compiled.manifest, wrongProvenanceChunk, options), /provenance does not match manifest.source/)
})

test('preserves and validates compact archived-WZ provenance in runtime output', () => {
	const { index } = fixtureIndex()
	const archivedIndex = structuredClone(index)
	for (const node of archivedIndex.graph!.nodes) {
		node.provenance = {
			provider: 'archived-wz',
			region: 'TWMS',
			logicalRegion: 'TWMS',
			version: '158',
			apiBase: 'https://archive.org/download/twms-maplestory',
			archivedWz: archivedProvenance,
		}
	}
	const compiled = compileWorldMapRuntime(archivedIndex, { bgmIds })
	assert.deepEqual(compiled.manifest.source.archivedWz, archivedProvenance)
	assert.deepEqual(compiled.chunks.get('nodes/WorldMap.json')!.node.provenance.archivedWz, archivedProvenance)

	const invalid = structuredClone(compiled.manifest)
	invalid.source.archivedWz!.members.mapWz.sha256 = 'not-a-sha'
	assert.throws(() => validateWorldMapRuntime(invalid, compiled.chunks, { bgmIds }), /archivedWz is (?:required and )?invalid/)
	const missing = structuredClone(compiled.manifest)
	delete missing.source.archivedWz
	assert.throws(() => validateWorldMapRuntime(missing, compiled.chunks, { bgmIds }), /archivedWz is required and invalid/)
})
