/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import test from 'node:test'
import { LIVE_RESOURCE_BASE_URL, waitForLiveAudioAssets } from '../deploy-readiness'

test('live audio readiness retries until every public asset is visible', async () => {
	const calls: string[] = []
	const sleeps: number[] = []
	let attempts = 0
	await waitForLiveAudioAssets(['bgm/new track.mp3', 'bgm/second.mp3'], {
		attempts: 3,
		retryDelayMs: 40,
		sleep: async (milliseconds) => { sleeps.push(milliseconds) },
		fetchImpl: async (input, init) => {
			calls.push(String(input))
			assert.equal(init?.method, 'HEAD')
			assert.equal(init?.cache, 'no-store')
			attempts++
			return new Response(null, { status: attempts <= 2 ? 404 : 200 })
		},
	})

	assert.equal(calls.length, 4)
	assert.ok(calls.every(url => url.startsWith(`${LIVE_RESOURCE_BASE_URL}/bgm/`)))
	assert.ok(calls.some(url => url.endsWith('new%20track.mp3')))
	assert.deepEqual(sleeps, [40])
})

test('live audio readiness fails closed when the bounded check never sees an asset', async () => {
	let requests = 0
	await assert.rejects(waitForLiveAudioAssets(['bgm/missing.mp3'], {
		attempts: 2,
		retryDelayMs: 0,
		sleep: async () => {},
		fetchImpl: async () => {
			requests++
			return new Response(null, { status: 404 })
		},
	}), /failed after 2 attempt\(s\).*not publicly visible: bgm\/missing\.mp3/)
	assert.equal(requests, 2)
})

test('live audio readiness accepts an empty set and rejects unsafe paths', async () => {
	let requests = 0
	await waitForLiveAudioAssets([])
	await assert.rejects(waitForLiveAudioAssets(['../private.mp3'], {
		fetchImpl: async () => {
			requests++
			return new Response(null, { status: 200 })
		},
	}), /Invalid relative resource path/)
	assert.equal(requests, 0)
})

test('live audio readiness bounds concurrent HEAD requests', async () => {
	let inFlight = 0
	let maximumInFlight = 0
	await waitForLiveAudioAssets(Array.from({ length: 7 }, (_, index) => `bgm/new-${index}.mp3`), {
		attempts: 1,
		concurrency: 2,
		totalTimeoutMs: 10_000,
		fetchImpl: async () => {
			inFlight++
			maximumInFlight = Math.max(maximumInFlight, inFlight)
			await new Promise(resolve => setTimeout(resolve, 1))
			inFlight--
			return new Response(null, { status: 200 })
		},
	})

	assert.equal(maximumInFlight, 2)
})
