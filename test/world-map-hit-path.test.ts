/* eslint-disable test/no-import-node-test */
import type { WorldMapGraph, WorldMapIndex, WorldMapNode } from '../world-map/schema'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { compareWorldMapGraphs } from '../world-map/compare'
import {
	DEFAULT_HIT_PATH_ALPHA_THRESHOLD,
	deriveHitPathFromAlpha,
	deriveHitPathFromPng,
	isPointInEvenOddPath,
	isValidSvgHitPathString,
	isValidWorldMapHitPath,
} from '../world-map/hit-path'
import { compileWorldMapRuntime } from '../world-map/runtime'
import { WORLD_MAP_SCHEMA_VERSION } from '../world-map/schema'
import { fingerprintWorldMapGraph } from '../world-map/snapshot'
import { validateWorldMapIndex } from '../world-map/validate'

test('deterministic simple opaque shape produces exact integer SVG path', () => {
	const width = 4
	const height = 4
	const alpha = new Uint8Array(width * height).fill(255)
	const hitPath = deriveHitPathFromAlpha(alpha, width, height, { x: 0, y: 0 })

	assert.notEqual(hitPath, null)
	assert.equal(hitPath?.fillRule, 'evenodd')
	assert.equal(hitPath?.d, 'M 0 0 L 4 0 L 4 4 L 0 4 Z')
	assert.equal(isPointInEvenOddPath({ x: 2, y: 2 }, hitPath!.d), true)
	assert.equal(isPointInEvenOddPath({ x: 5, y: 5 }, hitPath!.d), false)
	assert.equal(isPointInEvenOddPath({ x: -1, y: -1 }, hitPath!.d), false)
})

test('transparent padding is ignored and only solid bounds are traced', () => {
	const width = 8
	const height = 8
	const alpha = new Uint8Array(width * height).fill(0)
	// Fill a 4x4 square in the center: x in [2, 5], y in [2, 5]
	for (let y = 2; y <= 5; y++) {
		for (let x = 2; x <= 5; x++)
			alpha[y * width + x] = 255
	}
	const hitPath = deriveHitPathFromAlpha(alpha, width, height, { x: 0, y: 0 })

	assert.notEqual(hitPath, null)
	assert.equal(hitPath?.fillRule, 'evenodd')
	assert.equal(hitPath?.d, 'M 2 2 L 6 2 L 6 6 L 2 6 Z')
	assert.equal(isPointInEvenOddPath({ x: 1, y: 1 }, hitPath!.d), false)
	assert.equal(isPointInEvenOddPath({ x: 3.5, y: 3.5 }, hitPath!.d), true)
	assert.equal(isPointInEvenOddPath({ x: 7, y: 7 }, hitPath!.d), false)
})

test('inner transparent hole is filled and clickable in hitPath', () => {
	const width = 6
	const height = 6
	// 6x6 solid square with an enclosed 2x2 hole at (2, 2)..(3, 3)
	const alpha = new Uint8Array(width * height).fill(255)
	for (let y = 2; y <= 3; y++) {
		for (let x = 2; x <= 3; x++)
			alpha[y * width + x] = 0
	}
	const hitPath = deriveHitPathFromAlpha(alpha, width, height, { x: 0, y: 0 })

	assert.notEqual(hitPath, null)
	assert.equal(hitPath?.fillRule, 'evenodd')
	// Enclosed hole is filled solid, producing a single outer silhouette
	assert.equal(hitPath?.d, 'M 0 0 L 6 0 L 6 6 L 0 6 Z')
	assert.equal(hitPath?.d.includes('M 2 2'), false)

	// Solid region hit test
	assert.equal(isPointInEvenOddPath({ x: 1, y: 1 }, hitPath!.d), true)
	assert.equal(isPointInEvenOddPath({ x: 5, y: 5 }, hitPath!.d), true)
	// Formerly transparent enclosed hole is filled -> should hit
	assert.equal(isPointInEvenOddPath({ x: 2.5, y: 2.5 }, hitPath!.d), true)
	// Outside hit test
	assert.equal(isPointInEvenOddPath({ x: 7, y: 7 }, hitPath!.d), false)
})

test('boundary-connected transparent indentations are preserved and not filled', () => {
	const width = 6
	const height = 6
	// 6x6 solid square with a 2x2 indentation open to the top border (x in [2, 3], y in [0, 1])
	const alpha = new Uint8Array(width * height).fill(255)
	for (let y = 0; y <= 1; y++) {
		for (let x = 2; x <= 3; x++)
			alpha[y * width + x] = 0
	}
	const hitPath = deriveHitPathFromAlpha(alpha, width, height, { x: 0, y: 0 })

	assert.notEqual(hitPath, null)
	assert.equal(hitPath?.fillRule, 'evenodd')
	// Indentation connects to border, so it remains non-solid (not filled)
	assert.equal(isPointInEvenOddPath({ x: 2.5, y: 0.5 }, hitPath!.d), false)
	// Solid parts around it are hit
	assert.equal(isPointInEvenOddPath({ x: 1, y: 0.5 }, hitPath!.d), true)
	assert.equal(isPointInEvenOddPath({ x: 4.5, y: 0.5 }, hitPath!.d), true)
	assert.equal(isPointInEvenOddPath({ x: 2.5, y: 3 }, hitPath!.d), true)
})

test('screenOrigin offset is applied directly to SVG coordinates', () => {
	const width = 4
	const height = 4
	const alpha = new Uint8Array(width * height).fill(255)
	const screenOrigin = { x: 120, y: 340 }
	const hitPath = deriveHitPathFromAlpha(alpha, width, height, screenOrigin)

	assert.notEqual(hitPath, null)
	assert.equal(hitPath?.d, 'M 120 340 L 124 340 L 124 344 L 120 344 Z')
	assert.equal(isPointInEvenOddPath({ x: 122, y: 342 }, hitPath!.d), true)
	assert.equal(isPointInEvenOddPath({ x: 2, y: 2 }, hitPath!.d), false)
})

test('fully transparent or below-threshold images produce null hitPath', () => {
	assert.equal(DEFAULT_HIT_PATH_ALPHA_THRESHOLD, 32)

	const width = 4
	const height = 4
	const alphaAllZero = new Uint8Array(width * height).fill(0)
	assert.equal(deriveHitPathFromAlpha(alphaAllZero, width, height, { x: 0, y: 0 }), null)

	// Below default threshold (32)
	const alphaFaint = new Uint8Array(width * height).fill(DEFAULT_HIT_PATH_ALPHA_THRESHOLD - 1)
	assert.equal(deriveHitPathFromAlpha(alphaFaint, width, height, { x: 0, y: 0 }), null)

	// Exactly threshold produces a shape
	const alphaThreshold = new Uint8Array(width * height).fill(DEFAULT_HIT_PATH_ALPHA_THRESHOLD)
	assert.notEqual(deriveHitPathFromAlpha(alphaThreshold, width, height, { x: 0, y: 0 }), null)
})

test('derives hitPath from sharp PNG buffer with alpha channel and padding', async () => {
	const width = 10
	const height = 10
	// 10x10 RGBA image: outer transparent, inner 4x4 square at (3,3)..(6,6)
	const rgba = Buffer.alloc(width * height * 4, 0)
	for (let y = 3; y <= 6; y++) {
		for (let x = 3; x <= 6; x++) {
			const offset = (y * width + x) * 4
			rgba[offset] = 255 // R
			rgba[offset + 1] = 0 // G
			rgba[offset + 2] = 0 // B
			rgba[offset + 3] = 255 // A
		}
	}
	const pngBuffer = await sharp(rgba, { raw: { width, height, channels: 4 } })
		.png()
		.toBuffer()
	const hitPath = await deriveHitPathFromPng(pngBuffer, { x: 50, y: 100 })

	assert.notEqual(hitPath, null)
	assert.equal(hitPath?.fillRule, 'evenodd')
	assert.equal(hitPath?.d, 'M 53 103 L 57 103 L 57 107 L 53 107 Z')
	assert.equal(isPointInEvenOddPath({ x: 55, y: 105 }, hitPath!.d), true)
	assert.equal(isPointInEvenOddPath({ x: 51, y: 101 }, hitPath!.d), false)
})

test('runtime validates hitPath structure, fillRule, and binding to linkImage', () => {
	assert.equal(isValidSvgHitPathString('M 0 0 L 10 0 L 10 10 L 0 10 Z'), true)
	assert.equal(isValidSvgHitPathString('M 0 0 L 10 0 L 10 10 Z'), true)
	assert.equal(isValidSvgHitPathString(''), false)
	assert.equal(isValidSvgHitPathString('M 0 0 L 10 0 Z'), false) // only 2 points
	assert.equal(isValidSvgHitPathString('M 0 0 L 10 0 L 10 10'), false) // missing Z
	assert.equal(isValidSvgHitPathString('M 0 0 L 10 nan L 10 10 Z'), false)

	assert.equal(isValidWorldMapHitPath({ d: 'M 0 0 L 10 0 L 10 10 L 0 10 Z', fillRule: 'evenodd' }), true)
	assert.equal(isValidWorldMapHitPath({ d: 'M 0 0 L 10 0 L 10 10 L 0 10 Z', fillRule: 'nonzero' as 'evenodd' }), false)
	assert.equal(isValidWorldMapHitPath(null), false)

	function createIndex(linkOverride: Partial<WorldMapNode['links'][number]>): WorldMapIndex {
		const node: WorldMapNode = {
			worldMapId: 'WorldMap',
			worldMapName: 'WorldMap',
			canonicalLabel: null,
			localizedNames: {},
			parentWorldMapId: null,
			baseImages: [{ file: 'world-map/gms/270/WorldMap/base-0.png', width: 100, height: 100, sha1: '0'.repeat(40), origin: { x: 0, y: 0 } }],
			links: [{
				id: 'link-0',
				canonicalLabel: 'Child',
				localizedNames: {},
				targetWorldMapId: 'WorldMapChild',
				linkImage: { file: 'world-map/gms/270/WorldMap/link-0.png', width: 20, height: 20, sha1: '0'.repeat(40), origin: { x: 0, y: 0 } },
				screenOrigin: { x: 10, y: 20 },
				hitRect: null,
				hitPath: { d: 'M 10 20 L 30 20 L 30 40 L 10 40 Z', fillRule: 'evenodd' },
				...linkOverride,
			}],
			spots: [],
			provenance: { provider: 'maplestory-io', region: 'GMS', logicalRegion: 'GMS', version: '270', apiBase: 'https://maplestory.io/api' },
		}
		const childNode: WorldMapNode = {
			...node,
			worldMapId: 'WorldMapChild',
			worldMapName: 'WorldMapChild',
			parentWorldMapId: 'WorldMap',
			links: [],
		}
		return {
			schemaVersion: WORLD_MAP_SCHEMA_VERSION,
			generatedAt: '2026-09-10T00:00:00.000Z',
			graph: { roots: ['WorldMap'], nodes: [node, childNode] },
			worlds: [],
		}
	}

	// Valid compilation succeeds
	const validCompiled = compileWorldMapRuntime(createIndex({}))
	assert.equal(validCompiled.chunks.get('nodes/WorldMap.json')?.node.links[0]?.hitPath?.fillRule, 'evenodd')

	// Fails when fillRule is not evenodd
	assert.throws(
		() => compileWorldMapRuntime(createIndex({ hitPath: { d: 'M 10 20 L 30 20 L 30 40 L 10 40 Z', fillRule: 'nonzero' as 'evenodd' } })),
		/hitPath\.fillRule must be 'evenodd'/,
	)

	// Fails when d is malformed
	assert.throws(
		() => compileWorldMapRuntime(createIndex({ hitPath: { d: 'M 10 20 L 30 20 Z', fillRule: 'evenodd' } })),
		/hitPath\.d is not a valid SVG path/,
	)

	// Fails when linkImage is null but hitPath is provided
	assert.throws(
		() => compileWorldMapRuntime(createIndex({ linkImage: null, hitPath: { d: 'M 10 20 L 30 20 L 30 40 L 10 40 Z', fillRule: 'evenodd' } })),
		/hitPath must be null when linkImage is null/,
	)
})

test('canonical v8 validation rejects links that omit required hitPath', async () => {
	const assetRoot = await mkdtemp(path.join(tmpdir(), 'world-map-hit-path-validation-'))
	try {
		const png = await sharp({
			create: { width: 1, height: 1, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
		})
			.png()
			.toBuffer()
		const file = 'base.png'
		await writeFile(path.join(assetRoot, file), png)
		const asset = { file, width: 1, height: 1, sha1: createHash('sha1')
			.update(png)
			.digest('hex'), origin: { x: 0, y: 0 } }
		const provenance = { provider: 'maplestory-io' as const, region: 'GMS', logicalRegion: 'GMS' as const, version: '270', apiBase: 'https://maplestory.io/api' }
		const root: WorldMapNode = {
			worldMapId: 'WorldMap',
			worldMapName: 'WorldMap',
			canonicalLabel: null,
			localizedNames: {},
			parentWorldMapId: null,
			baseImages: [asset],
			links: [{
				id: 'link-0',
				canonicalLabel: 'Child',
				localizedNames: {},
				targetWorldMapId: 'WorldMapChild',
				linkImage: null,
				screenOrigin: { x: 0, y: 0 },
				hitRect: null,
				hitPath: null,
			}],
			spots: [],
			provenance,
		}
		const child: WorldMapNode = { ...root, worldMapId: 'WorldMapChild', worldMapName: 'WorldMapChild', parentWorldMapId: 'WorldMap', links: [] }
		const invalid: WorldMapIndex = {
			schemaVersion: WORLD_MAP_SCHEMA_VERSION,
			generatedAt: '2026-09-12T00:00:00.000Z',
			graph: { roots: ['WorldMap'], nodes: [root, child] },
			worlds: [],
		}
		delete (invalid.graph!.nodes[0]!.links[0] as Partial<WorldMapNode['links'][number]>).hitPath
		await assert.rejects(
			validateWorldMapIndex(invalid, { assetRoot, bgmIds: new Set() }),
			/is missing hitPath/,
		)
	}
	finally {
		await rm(assetRoot, { recursive: true, force: true })
	}
})

test('geometry fingerprint and comparison detect hitPath changes', () => {
	const baseNode: WorldMapNode = {
		worldMapId: 'WorldMap',
		worldMapName: 'WorldMap',
		canonicalLabel: 'Maple World',
		canonicalLabelSource: 'string-wz',
		localizedNames: {},
		parentWorldMapId: null,
		baseImages: [{ file: 'world-map/test/base.png', width: 100, height: 100, sha1: '0'.repeat(40), origin: { x: 0, y: 0 } }],
		links: [{
			id: 'link-0',
			canonicalLabel: 'Victoria',
			localizedNames: {},
			targetWorldMapId: 'WorldMap010',
			linkImage: { file: 'world-map/test/link.png', width: 20, height: 20, sha1: '0'.repeat(40), origin: { x: 0, y: 0 } },
			screenOrigin: { x: 10, y: 20 },
			hitRect: null,
			hitPath: null,
		}],
		spots: [],
		provenance: { provider: 'maplestory-io', region: 'GMS', logicalRegion: 'GMS', version: '270', apiBase: 'https://maplestory.io/api' },
	}

	const graphA: WorldMapGraph = { roots: ['WorldMap'], nodes: [structuredClone(baseNode)] }
	const graphB: WorldMapGraph = { roots: ['WorldMap'], nodes: [structuredClone(baseNode)] }
	graphB.nodes[0]!.links[0]!.hitPath = { d: 'M 10 20 L 30 20 L 30 40 L 10 40 Z', fillRule: 'evenodd' }

	const fpA = fingerprintWorldMapGraph(graphA)
	const fpB = fingerprintWorldMapGraph(graphB)

	assert.notEqual(fpA.geometry, fpB.geometry)
	assert.equal(fpA.topology, fpB.topology)
	assert.equal(fpA.assets, fpB.assets)

	const diff = compareWorldMapGraphs(graphA, graphB)
	assert.equal(diff.facetsEqual.geometry, false)
	assert.deepEqual(diff.links.changed, ['WorldMap/link-0'])
})
