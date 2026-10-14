/* eslint-disable test/no-import-node-test */
import type { UpstreamTrack } from '../supplemental-catalog'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { toPublishedBgm } from '../build-output'
import {
	getAudioSourceFingerprint,
	mergeSupplementalCatalog,
	validatePromotionMap,
	validateSupplementalCatalog,
} from '../supplemental-catalog'

const catalogFixture = JSON.parse(readFileSync(new URL('../supplemental/catalog.v1.json', import.meta.url), 'utf8')) as unknown
const emptyPromotions = { schemaVersion: 1, promotions: [] }

function clone<T>(value: T): T {
	return structuredClone(value)
}

function upstreamTrack(overrides: Partial<UpstreamTrack> = {}): UpstreamTrack {
	return {
		description: 'Curated upstream metadata',
		filename: 'LegacyTrack',
		mark: 'Event',
		metadata: {
			albumArtist: 'Upstream Album Artist',
			artist: 'Upstream Artist',
			title: 'Dimension Tower Falling (Old Login)',
			year: '2024',
		},
		source: { client: 'GMS', date: '2024-01-01', structure: 'Bgm00', version: '270' },
		youtube: 'video-id',
		...overrides,
	}
}

function promotion(overrides: Record<string, unknown> = {}) {
	return {
		supplementalId: 'supplemental:dimension-tower-falling-old-login',
		upstream: {
			filename: 'LegacyTrack',
			youtube: 'video-id',
			source: { client: 'GMS', structure: 'Bgm00', version: '270' },
		},
		identityEquivalence: { verified: true, evidence: 'Maintainer verified the exact WZ asset identity.' },
		...overrides,
	}
}

test('catalog adds four event-marked supplemental tracks without matching same-title upstream items', () => {
	const upstream = [upstreamTrack()]
	const merged = mergeSupplementalCatalog(upstream, catalogFixture, emptyPromotions)
	assert.equal(merged.length, 5)
	assert.equal(merged[0]?.filename, 'LegacyTrack')
	assert.equal(merged[0]?.stableId, undefined)
	assert.equal(merged[0]?.aliases, undefined)
	assert.equal(merged[0]?.acquisition.type, 'youtube')
	const supplemental = merged.slice(1)
	assert.deepEqual(supplemental.map(item => item.stableId), [
		'supplemental:dimension-tower-falling-old-login',
		'supplemental:dimension-tower-falling-lets-march',
		'supplemental:dimension-tower-falling-lake-of-oblivion',
		'supplemental:dimension-tower-falling-bad-guys',
	])
	assert.ok(supplemental.every(item => item.mark === 'Event'))
	assert.ok(supplemental.every(item => !item.filename.includes(':')))
	for (const item of supplemental) {
		assert.deepEqual(item.catalog, {
			membership: 'supplemental',
			status: 'pending-upstream',
			tracking: 'https://github.com/maplestory-music/maplebgm-db/issues/18',
		})
	}
	assert.equal(supplemental[0]?.metadata.artist, '')
	assert.equal(supplemental[0]?.audioProvenance?.provider, 'maplestory.io')
})

test('a new numeric WZ source can be pinned in the manifest without an audio path allowlist edit', () => {
	const withNewSource = clone(catalogFixture) as { entries: Array<{ acquisition: Record<string, unknown>, source: Record<string, unknown> }> }
	withNewSource.entries[0]!.acquisition = {
		...withNewSource.entries[0]!.acquisition,
		region: 'TWMS',
		version: '209',
		path: 'Sound/SoundBgm.img/Festival/Theme Ω!.mp3',
		sha256: 'a'.repeat(64),
		codec: 'mp3',
		sampleRate: 48_000,
		duration: 600,
	}
	withNewSource.entries[0]!.source = {
		...withNewSource.entries[0]!.source,
		client: 'TWMS',
		version: '209',
		structure: 'Sound/SoundBgm.img/Festival',
	}

	const parsed = validateSupplementalCatalog(withNewSource)
	assert.equal(parsed.entries[0]?.acquisition.path, 'Sound/SoundBgm.img/Festival/Theme Ω!.mp3')
	assert.equal(parsed.entries[0]?.acquisition.region, 'TWMS')
	assert.equal(parsed.entries[0]?.acquisition.version, '209')
	assert.equal(parsed.entries[0]?.acquisition.sha256, 'a'.repeat(64))
})

test('empty catalog is valid and preserves all legacy IDs and source identities', () => {
	const upstream = [upstreamTrack(), upstreamTrack({ filename: 'LegacyTrack2', youtube: 'video-id-2' })]
	const merged = mergeSupplementalCatalog(upstream, { schemaVersion: 1, entries: [] }, emptyPromotions)
	assert.deepEqual(merged.map(item => item.filename), ['LegacyTrack', 'LegacyTrack2'])
	assert.ok(merged.every(item => item.stableId === undefined))
	assert.equal(getAudioSourceFingerprint(merged[0]!.acquisition), getAudioSourceFingerprint({ type: 'youtube', videoId: 'video-id' }))
})

test('duplicate supplemental IDs and filenames fail validation', () => {
	const duplicateId = clone(catalogFixture) as { schemaVersion: number, entries: Array<Record<string, unknown>> }
	duplicateId.entries[1]!.id = duplicateId.entries[0]!.id
	assert.throws(() => validateSupplementalCatalog(duplicateId), /Duplicate supplemental id/)

	const duplicateFilename = clone(catalogFixture) as { schemaVersion: number, entries: Array<Record<string, unknown>> }
	duplicateFilename.entries[1]!.filename = duplicateFilename.entries[0]!.filename
	assert.throws(() => validateSupplementalCatalog(duplicateFilename), /Duplicate supplemental filename/)
})

test('metadata evidence, source path parent, and mark filenames are validated', () => {
	const emptyEvidence = clone(catalogFixture) as { schemaVersion: number, entries: Array<{ metadataAuthority: { evidence: string[] } }> }
	emptyEvidence.entries[0]!.metadataAuthority.evidence = []
	assert.throws(() => validateSupplementalCatalog(emptyEvidence), /metadataAuthority.evidence must not be empty/)

	const mismatchedStructure = clone(catalogFixture) as { schemaVersion: number, entries: Array<{ source: { structure: string } }> }
	mismatchedStructure.entries[0]!.source.structure = 'Sound/Another.img'
	assert.throws(() => validateSupplementalCatalog(mismatchedStructure), /source.structure must be the parent/)

	const unsafeMark = clone(catalogFixture) as { schemaVersion: number, entries: Array<{ mark: string }> }
	unsafeMark.entries[0]!.mark = '../outside'
	assert.throws(() => validateSupplementalCatalog(unsafeMark), /file-safe mark stem/)
})

test('catalog curation status is explicit and pending-upstream requires an HTTPS tracking URL', () => {
	const missingTracking = clone(catalogFixture) as { entries: Array<{ catalog: Record<string, unknown> }> }
	delete missingTracking.entries[0]!.catalog.tracking
	assert.throws(() => validateSupplementalCatalog(missingTracking), /catalog.tracking must be an absolute HTTPS URL/)

	const invalidTracking = clone(catalogFixture) as { entries: Array<{ catalog: Record<string, unknown> }> }
	invalidTracking.entries[0]!.catalog.tracking = 'javascript:alert(1)'
	assert.throws(() => validateSupplementalCatalog(invalidTracking), /catalog.tracking must be an absolute HTTPS URL/)

	const curated = clone(catalogFixture) as { entries: Array<{ catalog: Record<string, unknown> }> }
	curated.entries[0]!.catalog = { membership: 'supplemental', status: 'curated' }
	assert.equal(validateSupplementalCatalog(curated).entries[0]?.catalog.status, 'curated')
})

test('upstream duplicates and supplemental physical-name collisions fail closed', () => {
	assert.throws(() => mergeSupplementalCatalog([
		upstreamTrack(),
		upstreamTrack(),
	], { schemaVersion: 1, entries: [] }, emptyPromotions), /Duplicate upstream filename/)

	const colliding = clone(catalogFixture) as { schemaVersion: number, entries: Array<Record<string, unknown>> }
	colliding.entries[0]!.filename = 'LegacyTrack'
	assert.throws(() => mergeSupplementalCatalog([upstreamTrack()], colliding, emptyPromotions), /collides with upstream filename/)
})

test('disabled and retired entries remain validated but are not emitted', () => {
	const inactive = clone(catalogFixture) as { schemaVersion: number, entries: Array<{ lifecycle: { status: string } }> }
	inactive.entries[0]!.lifecycle.status = 'disabled'
	inactive.entries[1]!.lifecycle.status = 'retired'
	const merged = mergeSupplementalCatalog([], inactive, emptyPromotions)
	assert.deepEqual(merged.map(item => item.stableId), [
		'supplemental:dimension-tower-falling-lake-of-oblivion',
		'supplemental:dimension-tower-falling-bad-guys',
	])
})

test('promotion requires explicit verified identity evidence and exact source identity', () => {
	const unverified = { schemaVersion: 1, promotions: [promotion({ identityEquivalence: { verified: false, evidence: '' } })] }
	assert.throws(() => validatePromotionMap(unverified), /identityEquivalence.verified must be true/)
	assert.throws(() => mergeSupplementalCatalog([upstreamTrack()], catalogFixture, unverified), /identityEquivalence.verified must be true/)

	const mismatched = { schemaVersion: 1, promotions: [promotion({
		upstream: {
			filename: 'LegacyTrack',
			youtube: 'different-video',
			source: { client: 'GMS', structure: 'Bgm00', version: '270' },
		},
	})] }
	assert.throws(() => mergeSupplementalCatalog([upstreamTrack()], catalogFixture, mismatched), /Promotion identity mismatch/)
})

test('verified promotion emits one supplemental ID using upstream metadata', () => {
	const merged = mergeSupplementalCatalog([upstreamTrack()], catalogFixture, {
		schemaVersion: 1,
		promotions: [promotion()],
	})
	assert.equal(merged.length, 4)
	const promoted = merged[0]!
	assert.equal(promoted.stableId, 'supplemental:dimension-tower-falling-old-login')
	assert.equal(promoted.filename, 'supplemental--dimension-tower-falling-old-login')
	assert.deepEqual(promoted.aliases, ['LegacyTrack'])
	assert.equal(promoted.metadata.artist, 'Upstream Artist')
	assert.equal(promoted.description, 'Curated upstream metadata')
	assert.equal(promoted.acquisition.type, 'maplestory-io-wz-audio')
	assert.equal(promoted.metadataAuthority?.kind, 'upstream')
	assert.deepEqual(promoted.catalog, { membership: 'supplemental', status: 'curated' })
	assert.equal(merged.filter(item => item.stableId === promoted.stableId).length, 1)
	const published = toPublishedBgm({
		...promoted,
		id: promoted.stableId,
		audio: { file: `${promoted.filename}.mp3`, codec: 'mp3', container: 'mp3' },
		duration: promoted.acquisition.type === 'maplestory-io-wz-audio' ? promoted.acquisition.duration : 0,
	})
	assert.equal(published.id, 'supplemental:dimension-tower-falling-old-login')
	assert.deepEqual(published.aliases, ['LegacyTrack'])
	assert.equal('stableId' in published, false)
})

test('promotion aliases cannot collide with another published stable ID', () => {
	const conflictingTrack = upstreamTrack({ filename: 'AnotherTrack', stableId: 'LegacyTrack' })
	assert.throws(() => mergeSupplementalCatalog([
		upstreamTrack(),
		conflictingTrack,
	], catalogFixture, {
		schemaVersion: 1,
		promotions: [promotion()],
	}), /Merged track alias collides with another stable ID: LegacyTrack/)
})

test('promotion to a missing or inactive entry is rejected', () => {
	const missing = { schemaVersion: 1, promotions: [promotion({ supplementalId: 'supplemental:unknown' })] }
	assert.throws(() => mergeSupplementalCatalog([upstreamTrack()], catalogFixture, missing), /Promotion target does not exist/)

	const inactiveCatalog = clone(catalogFixture) as { schemaVersion: number, entries: Array<{ lifecycle: { status: string } }> }
	inactiveCatalog.entries[0]!.lifecycle.status = 'retired'
	assert.throws(() => mergeSupplementalCatalog([upstreamTrack()], inactiveCatalog, {
		schemaVersion: 1,
		promotions: [promotion()],
	}), /Promotion target is not active/)
})

test('pinned WZ acquisition fingerprints include exact path and expected bytes', () => {
	const first = validateSupplementalCatalog(catalogFixture).entries[0]!.acquisition
	const second = { ...first, path: `${first.path}.other` }
	assert.notEqual(
		getAudioSourceFingerprint(first),
		getAudioSourceFingerprint(second),
	)
	const malformed = clone(catalogFixture) as { schemaVersion: number, entries: Array<{ acquisition: { path: string } }> }
	malformed.entries[0]!.acquisition.path = 'https://example.com/file.mp3'
	assert.throws(() => validateSupplementalCatalog(malformed), /must be a relative MapleStory WZ path under Sound\//)

	for (const unsafePath of [
		'Sound/../outside.mp3',
		'Sound/SoundEff.img/../../outside.mp3',
		'Sound/%2e%2e/outside.mp3',
		'Sound/SoundEff.img/file.mp3?download=1',
		'Sound/SoundEff.img/file.mp3#fragment',
		'Sound\\SoundEff.img\\file.mp3',
		'Sound//file.mp3',
		'Sound/SoundEff.img/not-audio.wav',
	]) {
		const invalidPath = clone(catalogFixture) as { entries: Array<{ acquisition: { path: string } }> }
		invalidPath.entries[0]!.acquisition.path = unsafePath
		assert.throws(() => validateSupplementalCatalog(invalidPath), /acquisition\.path/)
	}

	const nonNumericVersion = clone(catalogFixture) as { entries: Array<{ acquisition: { version: string } }> }
	nonNumericVersion.entries[0]!.acquisition.version = 'latest'
	assert.throws(() => validateSupplementalCatalog(nonNumericVersion), /exact numeric pinned version/)

	const mismatchedRegion = clone(catalogFixture) as { entries: Array<{ source: { client: string } }> }
	mismatchedRegion.entries[0]!.source.client = 'TWMS'
	assert.throws(() => validateSupplementalCatalog(mismatchedRegion), /source region\/version must match the pinned acquisition/)

	const invalidHash = clone(catalogFixture) as { entries: Array<{ acquisition: { sha256: string } }> }
	invalidHash.entries[0]!.acquisition.sha256 = 'not-a-sha256'
	assert.throws(() => validateSupplementalCatalog(invalidHash), /64-character hexadecimal SHA-256 pin/)
})
