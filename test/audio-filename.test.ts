/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import test from 'node:test'
import { getContentAddressedAudioFilename } from '../audio-filename'

const sourceFingerprint = 'a'.repeat(64)
const contentSha256 = 'b'.repeat(64)

test('content-addressed audio filenames are deterministic and preserve the selected container', () => {
	const webm = getContentAddressedAudioFilename('ThemeSong', sourceFingerprint, contentSha256, 'webm')
	const mp3 = getContentAddressedAudioFilename('ThemeSong', sourceFingerprint, contentSha256, 'mp3')

	assert.equal(webm, `ThemeSong.${sourceFingerprint}.${contentSha256}.webm`)
	assert.equal(mp3, `ThemeSong.${sourceFingerprint}.${contentSha256}.mp3`)
	assert.equal(getContentAddressedAudioFilename('ThemeSong', sourceFingerprint, contentSha256, 'webm'), webm)
})

test('content-addressed audio filenames validate path segments and SHA-256 inputs', () => {
	assert.throws(() => getContentAddressedAudioFilename('../ThemeSong', sourceFingerprint, contentSha256, 'mp3'), /single path segment/)
	assert.throws(() => getContentAddressedAudioFilename('ThemeSong', 'not-a-hash', contentSha256, 'mp3'), /source fingerprint/)
	assert.throws(() => getContentAddressedAudioFilename('ThemeSong', sourceFingerprint, 'not-a-hash', 'mp3'), /content hash/)
	assert.throws(() => getContentAddressedAudioFilename('ThemeSong', sourceFingerprint, contentSha256, '../mp3'), /file extension/)
})
