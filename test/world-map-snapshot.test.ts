/* eslint-disable test/no-import-node-test */
import type { WorldMapGraph, WorldMapNode } from '../world-map/schema'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createWorldMapSnapshotCatalog, curatedWorldMapSnapshotEntries, fingerprintWorldMapGraph, mapleStoryIoSourceForSnapshot, parseWorldMapSnapshotId, parseWorldMapSnapshotRequest, worldMapSnapshotId } from '../world-map/snapshot'

function node(id: string, label: string | null): WorldMapNode {
	return {
		worldMapId: id,
		worldMapName: id,
		canonicalLabel: label,
		localizedNames: {},
		parentWorldMapId: null,
		baseImages: [{ file: `world-map/gms/270/${id}/base-0.png`, width: 100, height: 80, sha1: '0'.repeat(40), origin: { x: 0, y: 0 } }],
		links: [],
		spots: [],
		provenance: { provider: 'maplestory-io', region: 'GMS', version: '270', apiBase: 'https://maplestory.io/api' },
	}
}

test('keeps logical TWMS identity separate from MapleStory.IO TMS/TWMS provider codes', () => {
	assert.deepEqual(mapleStoryIoSourceForSnapshot('GMS', '270'), { provider: 'maplestory-io', regionCode: 'GMS', version: '270' })
	assert.deepEqual(mapleStoryIoSourceForSnapshot('TWMS', '209'), { provider: 'maplestory-io', regionCode: 'TMS', version: '209' })
	assert.deepEqual(mapleStoryIoSourceForSnapshot('TWMS', '217'), { provider: 'maplestory-io', regionCode: 'TWMS', version: '217' })
	assert.equal(mapleStoryIoSourceForSnapshot('TWMS', '171'), null)
	assert.equal(worldMapSnapshotId('TWMS', '209'), 'TWMS/209')
	assert.deepEqual(parseWorldMapSnapshotId('TWMS/209'), { region: 'TWMS', version: '209' })
	assert.throws(() => parseWorldMapSnapshotId('TMS/209'), /Invalid world-map snapshot id/)
	assert.deepEqual(parseWorldMapSnapshotRequest('GMS/latest'), { region: 'GMS', version: 'latest' })
	assert.deepEqual(parseWorldMapSnapshotRequest('TWMS/256'), { region: 'TWMS', version: '256' })
})

test('supports non-numeric exact snapshot IDs end-to-end without Number coercion', () => {
	const nonNumericIds = ['GMS/40B', 'GMS/93T', 'GMS/1.2.3'] as const
	for (const id of nonNumericIds) {
		const parsed = parseWorldMapSnapshotId(id)
		assert.equal(worldMapSnapshotId(parsed.region, parsed.version), id)
		const request = parseWorldMapSnapshotRequest(id)
		assert.deepEqual(request, { region: parsed.region, version: parsed.version })
	}

	assert.deepEqual(parseWorldMapSnapshotId('GMS/40B'), { region: 'GMS', version: '40B' })
	assert.deepEqual(parseWorldMapSnapshotId('GMS/93T'), { region: 'GMS', version: '93T' })
	assert.deepEqual(parseWorldMapSnapshotId('GMS/1.2.3'), { region: 'GMS', version: '1.2.3' })

	// 'latest' is request-only sentinel, never an exact snapshot id
	assert.throws(() => parseWorldMapSnapshotId('GMS/latest'), /Invalid world-map snapshot id/)
	assert.throws(() => parseWorldMapSnapshotId('TWMS/latest'), /Invalid world-map snapshot id/)
	assert.throws(() => worldMapSnapshotId('GMS', 'latest'), /Invalid world-map snapshot version/)

	// Provider routing with non-numeric versions
	assert.deepEqual(mapleStoryIoSourceForSnapshot('GMS', '40B'), { provider: 'maplestory-io', regionCode: 'GMS', version: '40B' })
	assert.deepEqual(mapleStoryIoSourceForSnapshot('GMS', '93T'), { provider: 'maplestory-io', regionCode: 'GMS', version: '93T' })
	assert.deepEqual(mapleStoryIoSourceForSnapshot('GMS', '1.2.3'), { provider: 'maplestory-io', regionCode: 'GMS', version: '1.2.3' })
	// Non-numeric TWMS versions must not coerce to TMS/TWMS numeric routing
	assert.equal(mapleStoryIoSourceForSnapshot('TWMS', '40B'), null)
	assert.equal(mapleStoryIoSourceForSnapshot('TWMS', '1.2.3'), null)

	// Invalid snapshot IDs and requests
	assert.throws(() => parseWorldMapSnapshotId('GMS/'), /Invalid world-map snapshot id/)
	assert.throws(() => parseWorldMapSnapshotId('GMS/foo/bar'), /Invalid world-map snapshot id/)
	assert.throws(() => parseWorldMapSnapshotId('GMS/..'), /Invalid world-map snapshot id/)
	assert.throws(() => parseWorldMapSnapshotId('GMS/a b'), /Invalid world-map snapshot id/)
	assert.throws(() => parseWorldMapSnapshotRequest('GMS/'), /Invalid world-map snapshot request/)
	assert.throws(() => parseWorldMapSnapshotRequest('GMS/foo/bar'), /Invalid world-map snapshot request/)
	assert.throws(() => parseWorldMapSnapshotRequest('INVALID/100'), /Invalid world-map snapshot request/)
})

test('records important archived TWMS milestones even when MapleStory.IO cannot provide them', () => {
	const entries = curatedWorldMapSnapshotEntries()
	const v124 = entries.find(entry => entry.id === 'TWMS/124')!
	const v158 = entries.find(entry => entry.id === 'TWMS/158')!
	const v171 = entries.find(entry => entry.id === 'TWMS/171')!
	assert.equal(v124.historicallyImportant, true)
	assert.equal(v124.recommended, true)
	assert.equal(v124.selectable, false)
	assert.equal(v124.worldMapDataDistinct, null)
	assert.equal(v124.worldMapComparedTo, null)
	assert.equal(v124.mapleStoryIo, null)
	assert.equal(v158.historicallyImportant, true)
	assert.equal(v158.recommended, true)
	assert.equal(v158.selectable, false)
	assert.equal(v158.worldMapDataDistinct, true)
	assert.equal(v158.worldMapComparedTo, 'TWMS/124')
	assert.equal(v158.mapleStoryIo, null)
	assert.equal(v171.historicallyImportant, true)
	assert.equal(v171.recommended, true)
	assert.equal(v171.selectable, false)
	assert.equal(v171.worldMapDataDistinct, true)
	assert.equal(v171.worldMapComparedTo, 'TWMS/158')
	assert.equal(v171.mapleStoryIo, null)
})

test('records WZ-level comparison evidence for ambiguous adjacent snapshots', () => {
	const entries = curatedWorldMapSnapshotEntries()
	const ids = new Set(entries.map(entry => entry.id))
	for (const entry of entries) {
		if (entry.worldMapComparedTo != null)
			assert.equal(ids.has(entry.worldMapComparedTo), true, `${entry.id} comparison target is missing`)
		assert.equal('mapleStoryIoRegionCode' in entry, false)
		assert.equal('mapleArchiveRegionSlug' in entry, false)
	}
	const gms178 = entries.find(entry => entry.id === 'GMS/178')!
	assert.equal(gms178.historicallyImportant, true)
	assert.equal(gms178.recommended, false)
	assert.equal(gms178.worldMapDataDistinct, false)
	assert.equal(gms178.worldMapComparedTo, 'GMS/177')

	const gms224 = entries.find(entry => entry.id === 'GMS/224')!
	assert.equal(gms224.worldMapDataDistinct, true)
	assert.equal(gms224.worldMapComparedTo, 'GMS/223')

	const twms256 = entries.find(entry => entry.id === 'TWMS/256')!
	assert.equal(twms256.recommended, true)
	assert.equal(twms256.worldMapDataDistinct, false)
	assert.equal(twms256.worldMapComparedTo, 'TWMS/255')
})

test('enforces public baseline, research candidate, and GMS/178 metadata invariants matching decision draft', () => {
	const entries = curatedWorldMapSnapshotEntries()

	// TWMS public baseline
	const twmsPublicBaseline = ['TWMS/124', 'TWMS/158', 'TWMS/171', 'TWMS/209', 'TWMS/217', 'TWMS/236', 'TWMS/253', 'TWMS/256']
	const twmsResearchCandidates = ['TWMS/228', 'TWMS/232', 'TWMS/240', 'TWMS/250']
	for (const id of twmsPublicBaseline) {
		const entry = entries.find(e => e.id === id)!
		assert.equal(entry.recommended, true, `${id} should be recommended in public baseline`)
	}
	for (const id of twmsResearchCandidates) {
		const entry = entries.find(e => e.id === id)!
		assert.equal(entry.recommended, false, `${id} is research candidate and must not be recommended`)
	}

	// GMS public baseline
	const gmsPublicRecommended = ['GMS/93', 'GMS/137', 'GMS/179', 'GMS/246', 'GMS/270']
	const gmsResearchCandidates = ['GMS/202', 'GMS/223', 'GMS/224', 'GMS/247', 'GMS/263']
	for (const id of gmsPublicRecommended) {
		const entry = entries.find(e => e.id === id)!
		assert.equal(entry.recommended, true, `${id} should be recommended in public baseline`)
	}
	for (const id of gmsResearchCandidates) {
		const entry = entries.find(e => e.id === id)!
		assert.equal(entry.recommended, false, `${id} is research candidate and must not be recommended`)
	}

	// GMS/92 is pre-BB comparison baseline
	const gms92 = entries.find(e => e.id === 'GMS/92')!
	assert.equal(gms92.recommended, false)
	assert.equal(gms92.historicallyImportant, true)

	// GMS/178 is historical metadata with eventual dataRef (not recommended as distinct data)
	const gms178 = entries.find(e => e.id === 'GMS/178')!
	assert.equal(gms178.recommended, false, 'GMS/178 data payload is identical to GMS/177; not recommended as distinct data')
	assert.equal(gms178.historicallyImportant, true, 'GMS/178 is a historically important milestone')
	assert.equal(gms178.worldMapDataDistinct, false)
	assert.equal(gms178.worldMapComparedTo, 'GMS/177')
	assert.equal(gms178.dataRef, null)

	// Selectable must start false in curated definitions; only output verification can make it true
	for (const entry of entries) {
		assert.equal(entry.selectable, false, `Curated entry ${entry.id} must not be selectable before generation`)
	}
})

test('fingerprints semantic facets independently and ignores generated asset path versioning', () => {
	const graph: WorldMapGraph = { roots: ['WorldMap'], nodes: [node('WorldMap', 'Maple World')] }
	const first = fingerprintWorldMapGraph(graph)
	const moved = structuredClone(graph)
	moved.nodes[0]!.baseImages[0]!.file = 'world-map/snapshots/GMS/270/assets/WorldMap/base-0.png'
	const sameContent = fingerprintWorldMapGraph(moved)
	assert.deepEqual(sameContent, first)

	const withMap = structuredClone(graph)
	withMap.nodes[0]!.spots = [{
		id: 'spot-0',
		spot: { x: 0, y: 0 },
		type: 0,
		mapNumbers: ['100000000'],
		point: { x: 0, y: 0, normalizedX: 0, normalizedY: 0 },
		hitRect: null,
		maps: [{
			mapId: '100000000',
			name: 'Henesys',
			streetName: 'Victoria Road',
			mapMark: 'Henesys',
			localizedNames: {},
			gameBgm: { path: 'Bgm00/FloralLife', structure: 'Bgm00', filename: 'FloralLife', trackId: 'catalog-a' },
			selection: { trackId: 'catalog-a', source: 'gms-map-bgm' },
		}],
	}]
	const withMapFingerprint = fingerprintWorldMapGraph(withMap)
	const remappedCatalog = structuredClone(withMap)
	remappedCatalog.nodes[0]!.spots[0]!.maps[0]!.gameBgm!.trackId = 'catalog-b'
	remappedCatalog.nodes[0]!.spots[0]!.maps[0]!.selection = { trackId: 'catalog-b', source: 'gms-map-bgm' }
	assert.deepEqual(fingerprintWorldMapGraph(remappedCatalog), withMapFingerprint)
	const changedNativeBgm = structuredClone(withMap)
	changedNativeBgm.nodes[0]!.spots[0]!.maps[0]!.gameBgm = { path: 'Bgm01/MissingYou', structure: 'Bgm01', filename: 'MissingYou', trackId: null }
	changedNativeBgm.nodes[0]!.spots[0]!.maps[0]!.selection = { trackId: null, source: null }
	assert.notEqual(fingerprintWorldMapGraph(changedNativeBgm).mapDetails, withMapFingerprint.mapDetails)

	const renamed = structuredClone(graph)
	renamed.nodes[0]!.canonicalLabel = 'Changed name'
	const renamedFingerprint = fingerprintWorldMapGraph(renamed)
	assert.equal(renamedFingerprint.topology, first.topology)
	assert.equal(renamedFingerprint.geometry, first.geometry)
	assert.equal(renamedFingerprint.assets, first.assets)
	assert.notEqual(renamedFingerprint.worldMapNames, first.worldMapNames)
	assert.notEqual(renamedFingerprint.combined, first.combined)
	const renamedNative = structuredClone(graph)
	renamedNative.nodes[0]!.worldMapName = 'Changed native name'
	assert.notEqual(fingerprintWorldMapGraph(renamedNative).worldMapNames, first.worldMapNames)
	const changedLabelSource = structuredClone(graph)
	changedLabelSource.nodes[0]!.canonicalLabelSource = 'string-wz'
	assert.notEqual(fingerprintWorldMapGraph(changedLabelSource).worldMapNames, first.worldMapNames)

	const archived = structuredClone(graph)
	archived.nodes[0]!.provenance = {
		provider: 'archived-wz',
		region: 'TWMS',
		logicalRegion: 'TWMS',
		version: '158',
		apiBase: 'https://archive.org/download/twms-maplestory',
		archivedWz: {
			providerRegion: 'TWMS',
			providerVersion: '158',
			archiveItem: 'twms-maplestory',
			archiveFile: 'v158.7z',
			archiveSha1: '1'.repeat(40),
			members: {
				stringWz: { name: 'String.wz', sha256: '2'.repeat(64) },
				mapWz: { name: 'Map.wz', sha256: '3'.repeat(64) },
			},
		},
	}
	const archivedFingerprint = fingerprintWorldMapGraph(archived)
	assert.deepEqual(archivedFingerprint, first)
})

test('builds a deterministic catalog with generated fingerprints attached only to exact snapshot ids', () => {
	const graph: WorldMapGraph = { roots: ['WorldMap'], nodes: [node('WorldMap', 'Maple World')] }
	const fingerprint = fingerprintWorldMapGraph(graph)
	const catalog = createWorldMapSnapshotCatalog('2026-09-10T00:00:00.000Z', new Map([['GMS/270', fingerprint]]))
	assert.equal(catalog.defaultSnapshot, 'GMS/270')
	const current = catalog.entries.find(entry => entry.id === 'GMS/270')!
	assert.equal(current.label, 'GMS v270')
	assert.equal(current.selectable, true)
	assert.deepEqual(current.fingerprint, fingerprint)
	assert.equal(catalog.entries.find(entry => entry.id === 'GMS/263')!.selectable, false)
	assert.equal(catalog.entries.find(entry => entry.id === 'GMS/263')!.fingerprint, null)
	assert.throws(() => createWorldMapSnapshotCatalog('not-a-date'), /generatedAt/)
})
