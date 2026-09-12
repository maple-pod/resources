/* eslint-disable test/no-import-node-test */
import type { WorldMapGraph, WorldMapNode } from '../world-map/schema'
import assert from 'node:assert/strict'
import test from 'node:test'
import { compareWorldMapGraphs } from '../world-map/compare'

function graph(label: string, mapName = 'Henesys'): WorldMapGraph {
	const node: WorldMapNode = {
		worldMapId: 'WorldMap',
		worldMapName: 'WorldMap',
		canonicalLabel: label,
		canonicalLabelSource: 'string-wz',
		localizedNames: {},
		parentWorldMapId: null,
		baseImages: [{ file: 'world-map/test/base.png', width: 1, height: 1, sha1: '0'.repeat(40), origin: { x: 0, y: 0 } }],
		links: [],
		spots: [{ id: 'spot:0-0', spot: { x: 0, y: 0 }, type: 1, mapNumbers: ['100000000'], point: { x: 0, y: 0, normalizedX: 0, normalizedY: 0 }, hitRect: null, maps: [{ mapId: '100000000', name: mapName, streetName: 'Victoria', mapMark: null, localizedNames: {}, gameBgm: null, selection: { trackId: null, source: null } }] }],
		provenance: { provider: 'maplestory-io', region: 'GMS', logicalRegion: 'GMS', version: '270', apiBase: 'https://maplestory.io/api' },
	}
	return { roots: ['WorldMap'], nodes: [node] }
}

test('compares content facets and reports semantic deltas without mutating graphs', () => {
	const comparison = compareWorldMapGraphs(graph('Maple World'), graph('Different World', 'Henesys Updated'))
	assert.equal(comparison.facetsEqual.topology, true)
	assert.equal(comparison.facetsEqual.geometry, true)
	assert.equal(comparison.facetsEqual.assets, true)
	assert.equal(comparison.facetsEqual.worldMapNames, false)
	assert.equal(comparison.facetsEqual.mapDetails, false)
	assert.equal(comparison.facetsEqual.combined, false)
	assert.deepEqual(comparison.nodes.added, [])
	assert.deepEqual(comparison.nodes.removed, [])
	assert.equal(comparison.worldMapNames.changed.length, 1)
	assert.equal(comparison.mapDetails.changed.length, 1)
})

test('keeps exact source identity separate from pure-content fingerprints', () => {
	const left = graph('Maple World')
	const right = graph('Maple World')
	right.nodes[0]!.provenance = { ...right.nodes[0]!.provenance, apiBase: 'https://other-provider.example/api' }
	const comparison = compareWorldMapGraphs(left, right)
	assert.equal(comparison.facetsEqual.combined, true)
	assert.equal(comparison.sourceEqual, false)
	assert.notEqual(comparison.left.source.apiBase, comparison.right.source.apiBase)
})
