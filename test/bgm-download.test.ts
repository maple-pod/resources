/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import test from 'node:test'
import { downloadAudioWithHlsFallback } from '../bgm-download'

const url = 'https://www.youtube.com/watch?v=example'
const flags = { format: 'bestaudio/best', noPlaylist: true, retries: 3, jsRuntimes: 'node' } as const

test('successful direct audio keeps the preferred format and skips fallback', async () => {
	const calls: string[] = []
	await downloadAudioWithHlsFallback(
		url,
		flags,
		async (_url, options) => { calls.push(String(options.format)) },
		async () => { calls.push('cleanup') },
		() => { calls.push('fallback') },
	)
	assert.deepEqual(calls, ['bestaudio/best'])
})

test('HTTP 403 clears partial files before retrying original HLS audio', async () => {
	const calls: string[] = []
	await downloadAudioWithHlsFallback(
		url,
		flags,
		async (downloadUrl, options) => {
			assert.equal(downloadUrl, url)
			assert.equal(options.jsRuntimes, 'node')
			assert.equal(options.noPlaylist, true)
			calls.push(String(options.format))
			if (calls.length === 1)
				throw new Error('ERROR: unable to download video data: HTTP Error 403: Forbidden')
		},
		async () => { calls.push('cleanup') },
		() => { calls.push('fallback') },
	)
	assert.deepEqual(calls, [
		'bestaudio/best',
		'cleanup',
		'fallback',
		'bestaudio[protocol=m3u8_native]/bestaudio[protocol=m3u8]',
	])
})

test('non-403 errors propagate without HLS retry or cleanup', async () => {
	let downloadCount = 0
	let cleanupCount = 0
	await assert.rejects(
		downloadAudioWithHlsFallback(
			url,
			flags,
			async () => {
				downloadCount++
				throw new Error('HTTP Error 404: Not Found')
			},
			async () => { cleanupCount++ },
			() => { throw new Error('unexpected fallback') },
		),
		/404/,
	)
	assert.equal(downloadCount, 1)
	assert.equal(cleanupCount, 0)
})

test('HLS retry failure propagates for caller to record and clean up', async () => {
	let downloadCount = 0
	await assert.rejects(
		downloadAudioWithHlsFallback(
			url,
			flags,
			async () => {
				downloadCount++
				throw new Error(downloadCount === 1 ? 'HTTP Error 403: Forbidden' : 'HLS unavailable')
			},
			async () => {},
			() => {},
		),
		/HLS unavailable/,
	)
	assert.equal(downloadCount, 2)
})

test('cleanup failure blocks retry so output files cannot be mixed', async () => {
	let downloadCount = 0
	await assert.rejects(
		downloadAudioWithHlsFallback(
			url,
			flags,
			async () => {
				downloadCount++
				throw new Error('HTTP Error 403: Forbidden')
			},
			async () => { throw new Error('cleanup failed') },
			() => { throw new Error('unexpected fallback') },
		),
		/cleanup failed/,
	)
	assert.equal(downloadCount, 1)
})
