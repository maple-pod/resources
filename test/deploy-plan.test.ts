/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import test from 'node:test'
import { getNewlyReferencedAudioFiles, planResourceDeployment } from '../deploy-plan'

test('deployment plans separate new audio, mutable existing paths, metadata, and deferred deletions', () => {
	const plan = planResourceDeployment([
		{ path: 'bgm/new.mp3', index: '?', working_dir: '?' },
		{ path: 'bgm/updated.webm', working_dir: 'M' },
		{ path: 'bgm/stale.mp3', working_dir: 'D' },
		{ path: 'data.json', working_dir: 'M' },
		{ path: 'mark/Event.png', working_dir: 'M' },
	], 1)

	assert.deepEqual(plan.newAudioFiles, ['bgm/new.mp3'])
	assert.deepEqual(plan.audioFiles, ['bgm/new.mp3', 'bgm/updated.webm'])
	assert.deepEqual(plan.audioBatches, [['bgm/new.mp3']])
	assert.deepEqual(plan.modifiedAudioFiles, ['bgm/updated.webm'])
	assert.deepEqual(plan.jsonFiles, ['data.json'])
	assert.deepEqual(plan.imageFiles, ['mark/Event.png'])
	assert.deepEqual(plan.metadataFiles, ['data.json', 'mark/Event.png'])
	assert.deepEqual(plan.staleAudioFiles, ['bgm/stale.mp3'])
	assert.equal('staleAudioBatches' in plan, false)
})

test('deployment plan preserves the explicit JSON and image publication whitelist', () => {
	const allowedJson = [
		'data.json',
		'bg.json',
		'loudness-analysis.json',
		'world-map/catalog.json',
		'world-map/world-maps.json',
		'world-map/manifest.json',
		'world-map/nodes/WorldMap.json',
		'world-map/snapshots/GMS/270/world-maps.json',
		'world-map/snapshots/GMS/270/manifest.json',
		'world-map/snapshots/GMS/270/nodes/WorldMap.json',
		'world-map/snapshots/TWMS/209/world-maps.json',
		'world-map/snapshots/TWMS/209/manifest.json',
		'world-map/snapshots/TWMS/209/nodes/WorldMap010.json',
	]
	const allowedImages = [
		'mark/Event.png',
		'bg/henesys.jpg',
		'world-map/images/WorldMap.png',
		'world-map/gms/270/WorldMap/base-0.png',
		'world-map/gms/270/WorldMap/link-2.webp',
		'world-map/snapshots/GMS/270/assets/WorldMap/base-0.png',
		'world-map/snapshots/TWMS/209/assets/WorldMap/link-1.jpeg',
	]
	const excluded = [
		'world-map-preview/catalog.json',
		'world-map/snapshots/KMS/270/manifest.json',
		'world-map/snapshots/GMS/270/assets/WorldMap/icon.png',
		'world-map/images/nested/image.png',
		'bg/not-a-jpg.png',
		'diagnostics/private.json',
	]
	const plan = planResourceDeployment([...allowedJson, ...allowedImages, ...excluded].map(file => ({
		path: file,
		working_dir: 'M',
	})))

	assert.deepEqual(plan.jsonFiles, allowedJson)
	assert.deepEqual(plan.imageFiles, allowedImages)
	assert.ok(excluded.every(file => !plan.metadataFiles.includes(file)))
})

test('deployment audio batches are capped and never contain deletions', () => {
	const changes = [
		...Array.from({ length: 205 }, (_, index) => ({ path: `bgm/added-${index}.mp3`, index: '?', working_dir: '?' })),
		{ path: 'bgm/removed-1.mp3', index: 'D' },
		{ path: 'bgm/removed-2.mp3', working_dir: 'D' },
	]
	const plan = planResourceDeployment(changes)

	assert.deepEqual(plan.audioBatches.map(batch => batch.length), [100, 100, 5])
	assert.deepEqual(plan.newAudioFiles.length, 205)
	assert.equal(plan.audioFiles.length, 205)
	assert.equal(plan.staleAudioFiles.length, 2)
	assert.ok(plan.audioFiles.every(file => !file.includes('removed-')))
	assert.ok(plan.audioBatches.flat().every(file => !file.includes('removed-')))
})

test('pending local deletions do not prevent independent resource paths from being planned', () => {
	const plan = planResourceDeployment([
		{ path: 'bgm/deferred-cleanup.mp3', index: 'D' },
		{ path: 'data.json', working_dir: 'M' },
		{ path: 'mark/removed.png', working_dir: 'D' },
		{ path: 'world-map/catalog.json', index: 'D' },
	])

	assert.deepEqual(plan.staleAudioFiles, ['bgm/deferred-cleanup.mp3'])
	assert.deepEqual(plan.metadataFiles, ['data.json'])
	assert.deepEqual(plan.audioBatches, [])
	assert.ok(!plan.metadataFiles.includes('mark/removed.png'))
	assert.ok(!plan.metadataFiles.includes('world-map/catalog.json'))
})

test('new audio references are detected against published metadata for retry readiness', () => {
	const previous = JSON.stringify({ bgms: [
		{ audio: { file: 'existing.mp3' } },
		{ audio: { file: 'bgm/also-existing.webm' } },
	] })
	const current = JSON.stringify({ bgms: [
		{ audio: { file: 'existing.mp3' } },
		{ audio: { file: 'bgm/also-existing.webm' } },
		{ audio: { file: 'new.track.abc123.mp3' } },
	] })

	assert.deepEqual(getNewlyReferencedAudioFiles(previous, current), ['bgm/new.track.abc123.mp3'])
	assert.deepEqual(getNewlyReferencedAudioFiles(undefined, current), [
		'bgm/existing.mp3',
		'bgm/also-existing.webm',
		'bgm/new.track.abc123.mp3',
	])
})

test('newly referenced audio path parsing rejects traversal and malformed metadata', () => {
	assert.throws(() => getNewlyReferencedAudioFiles(undefined, JSON.stringify({ bgms: [
		{ audio: { file: '../private.mp3' } },
	] })), /invalid data\.json/)
	assert.throws(() => getNewlyReferencedAudioFiles(undefined, '{'), SyntaxError)
})

test('deployment planner rejects invalid audio batch sizes', () => {
	assert.throws(() => planResourceDeployment([], 0), /positive integer/)
	assert.throws(() => planResourceDeployment([], 1.5), /positive integer/)
})
