/* eslint-disable test/no-import-node-test */
import type { WorldMapGraph, WorldMapIndex } from '../world-map/schema'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createWorldMapIndex } from '../world-map/normalize'
import { writeWorldMapRuntime } from '../world-map/runtime'
import { fingerprintWorldMapGraph } from '../world-map/snapshot'
import { BASELINE_VERIFIER_SCHEMA_VERSION, hasResumableSuccess, parseBaselineVerifierConcurrency, PUBLIC_BASELINE_SNAPSHOT_IDS } from '../world-map/verify-baselines'

test('baseline verifier is restricted to the public matrix and bounded concurrency', () => {
	assert.deepEqual(PUBLIC_BASELINE_SNAPSHOT_IDS, [
		'GMS/93',
		'GMS/137',
		'GMS/179',
		'GMS/246',
		'GMS/270',
		'TWMS/124',
		'TWMS/158',
		'TWMS/171',
		'TWMS/209',
		'TWMS/217',
		'TWMS/236',
		'TWMS/253',
		'TWMS/256',
	])
	assert.equal((PUBLIC_BASELINE_SNAPSHOT_IDS as readonly string[]).includes('GMS/223'), false)
	assert.equal(parseBaselineVerifierConcurrency(undefined), 2)
	assert.equal(parseBaselineVerifierConcurrency('1'), 1)
	assert.equal(parseBaselineVerifierConcurrency('3'), 3)
	assert.throws(() => parseBaselineVerifierConcurrency('0'), /from 1 to 3/)
	assert.throws(() => parseBaselineVerifierConcurrency('4'), /from 1 to 3/)
	assert.throws(() => parseBaselineVerifierConcurrency('many'), /Invalid baseline verifier concurrency/)
})

test('baseline verifier does not resume a success from a missing or corrupt artifact', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'baseline-verifier-resume-'))
	try {
		const metric = {
			verifierSchemaVersion: BASELINE_VERIFIER_SCHEMA_VERSION,
			id: 'GMS/93' as const,
			status: 'success' as const,
			startedAt: '2026-09-10T00:00:00.000Z',
			runDirectory: root,
			fingerprint: {
				topology: '0'.repeat(64),
				geometry: '0'.repeat(64),
				assets: '0'.repeat(64),
				worldMapNames: '0'.repeat(64),
				mapDetails: '0'.repeat(64),
				combined: '0'.repeat(64),
			},
			selectable: true,
		}
		assert.equal(await hasResumableSuccess(metric), false)
	}
	finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('baseline verifier resume checks referenced image bytes and hashes', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'baseline-verifier-assets-'))
	try {
		const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/6FA9WQAAAABJRU5ErkJggg==', 'base64')
		const imageFile = 'world-map/snapshots/GMS/93/assets/WorldMap/base-0.png'
		const source = { provider: 'maplestory-io' as const, region: 'GMS', logicalRegion: 'GMS' as const, version: '93', apiBase: 'https://maplestory.io/api' }
		const imageHash = createHash('sha1')
		imageHash.update(image)
		const imageSha1 = imageHash.digest('hex')
		const graph: WorldMapGraph = {
			roots: ['WorldMap'],
			nodes: [{
				worldMapId: 'WorldMap',
				worldMapName: 'WorldMap',
				canonicalLabel: null,
				localizedNames: {},
				parentWorldMapId: null,
				baseImages: [{ file: imageFile, width: 1, height: 1, sha1: imageSha1, origin: { x: 0, y: 0 } }],
				links: [],
				spots: [],
				provenance: source,
			}],
		}
		const index: WorldMapIndex = createWorldMapIndex([], '2026-09-10T00:00:00.000Z', graph)
		const snapshotDirectory = path.join(root, 'world-map/snapshots/GMS/93')
		await mkdir(path.join(root, path.dirname(imageFile)), { recursive: true })
		await writeFile(path.join(root, imageFile), image)
		await mkdir(snapshotDirectory, { recursive: true })
		await writeFile(path.join(snapshotDirectory, 'world-maps.json'), `${JSON.stringify(index)}\n`)
		const runtime = await writeWorldMapRuntime(index, snapshotDirectory, {
			resourceRoot: 'world-map',
			nativeAssetPathPrefix: 'world-map/snapshots/GMS/93/assets',
		})
		const fingerprint = fingerprintWorldMapGraph(graph)
		await writeFile(path.join(root, 'world-map/catalog.json'), JSON.stringify({
			schemaVersion: 1,
			generatedAt: '2026-09-10T00:00:00.000Z',
			defaultSnapshot: 'GMS/270',
			entries: [{ id: 'GMS/93', selectable: true, fingerprint }],
		}))
		const metric = {
			verifierSchemaVersion: BASELINE_VERIFIER_SCHEMA_VERSION,
			id: 'GMS/93' as const,
			status: 'success' as const,
			startedAt: '2026-09-10T00:00:00.000Z',
			runDirectory: root,
			fingerprint,
			selectable: true,
		}
		assert.equal(await hasResumableSuccess(metric), true)
		assert.equal(runtime.manifestFile.endsWith('/manifest.json'), true)
		await writeFile(path.join(root, imageFile), Buffer.from(image).subarray(0, image.length - 1))
		assert.equal(await hasResumableSuccess(metric), false)
		assert.ok((await readFile(path.join(root, imageFile))).byteLength > 0)
	}
	finally {
		await rm(root, { recursive: true, force: true })
	}
})
