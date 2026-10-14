/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { validateSupplementalCatalog } from '../supplemental-catalog'
import { downloadMapleStoryIoWzAudio, getMapleStoryIoWzAudioUrl } from '../wz-audio'

const catalog = validateSupplementalCatalog(JSON.parse(readFileSync(new URL('../supplemental/catalog.v1.json', import.meta.url), 'utf8')) as unknown)
const source = catalog.entries[1]!.acquisition

test('WZ URL is fixed to MapleStory.io and encodes path segments', () => {
	assert.equal(
		getMapleStoryIoWzAudioUrl(source),
		'https://maplestory.io/api/wz/audio/GMS/270/Sound/SoundEff.img/dimensionTower/dimensionTowerFalling__Lets%20March.mp3',
	)
	assert.throws(() => getMapleStoryIoWzAudioUrl({ ...source, path: 'https://example.com/audio.mp3' }), /under Sound\//)
	assert.equal(
		getMapleStoryIoWzAudioUrl({ ...source, region: 'JMS', version: '120', path: 'Sound/Bgm.img/Theme.mp3' }),
		'https://maplestory.io/api/wz/audio/JMS/120/Sound/Bgm.img/Theme.mp3',
	)
})

test('HTTP server failures retry a bounded number of times', async () => {
	let requests = 0
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'maple-wz-audio-test-'))
	try {
		await assert.rejects(downloadMapleStoryIoWzAudio(source, path.join(tempDir, 'audio.mp3'), {
			fetchImpl: async (_url, init) => {
				requests++
				assert.equal(init?.redirect, 'error')
				return new Response('', { status: 503 })
			},
			probeAudio: async () => ({ codec: 'mp3', sampleRate: 44100, duration: source.duration }),
			maxAttempts: 3,
			retryDelayMs: 0,
		}), /\(503\)/)
		assert.equal(requests, 3)
	}
	finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('oversized response is rejected before reading its body', async () => {
	let requests = 0
	let cancels = 0
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'maple-wz-audio-test-'))
	try {
		const response = new Response('small body', {
			headers: { 'content-length': String(25 * 1024 * 1024) },
		})
		const body = response.body!
		const originalCancel = body.cancel.bind(body)
		body.cancel = async (reason) => {
			cancels++
			await originalCancel(reason)
		}
		await assert.rejects(downloadMapleStoryIoWzAudio(source, path.join(tempDir, 'audio.mp3'), {
			fetchImpl: async () => {
				requests++
				return response
			},
			probeAudio: async () => ({ codec: 'mp3', sampleRate: 44100, duration: source.duration }),
		}), /exceeds 25165824 bytes/)
		assert.equal(requests, 1)
		assert.equal(cancels, 1)
	}
	finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('non-retryable HTTP status stops immediately', async () => {
	let requests = 0
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'maple-wz-audio-test-'))
	try {
		await assert.rejects(downloadMapleStoryIoWzAudio(source, path.join(tempDir, 'audio.mp3'), {
			fetchImpl: async () => {
				requests++
				return new Response('', { status: 404 })
			},
			probeAudio: async () => ({ codec: 'mp3', sampleRate: 44100, duration: source.duration }),
			maxAttempts: 3,
			retryDelayMs: 0,
		}), /\(404\)/)
		assert.equal(requests, 1)
	}
	finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('bad response bytes fail hash verification and leave no target or temp file', async () => {
	let requests = 0
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'maple-wz-audio-test-'))
	const target = path.join(tempDir, 'audio.mp3')
	try {
		await assert.rejects(downloadMapleStoryIoWzAudio(source, target, {
			fetchImpl: async () => {
				requests++
				return new Response(Buffer.from('not the pinned mp3'))
			},
			probeAudio: async () => ({ codec: 'mp3', sampleRate: 44100, duration: source.duration }),
			maxAttempts: 3,
			retryDelayMs: 0,
		}), /SHA-256 mismatch/)
		assert.equal(requests, 1)
		await assert.rejects(readFile(target))
		assert.deepEqual(await readdir(tempDir), [])
	}
	finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('corrupt cached WZ audio is rejected before network access', async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'maple-wz-audio-test-'))
	const target = path.join(tempDir, 'audio.mp3')
	const incorrectBytes = Buffer.from('a corrupted cached mp3')
	let fetchCount = 0
	try {
		await writeFile(target, incorrectBytes)
		await assert.rejects(downloadMapleStoryIoWzAudio(source, target, {
			fetchImpl: async () => {
				fetchCount++
				throw new Error('unexpected network access')
			},
			probeAudio: async () => { throw new Error('unexpected ffprobe') },
		}), /Refusing to overwrite existing non-matching WZ audio file/)
		assert.equal(fetchCount, 0)
		assert.deepEqual(await readFile(target), incorrectBytes)
	}
	finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('request timeout is retried and remains bounded', async () => {
	let requests = 0
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'maple-wz-audio-test-'))
	try {
		await assert.rejects(downloadMapleStoryIoWzAudio(source, path.join(tempDir, 'audio.mp3'), {
			fetchImpl: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
				requests++
				init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
			}),
			probeAudio: async () => ({ codec: 'mp3', sampleRate: 44100, duration: source.duration }),
			timeoutMs: 10,
			maxAttempts: 2,
			retryDelayMs: 0,
		}), /Timed out/)
		assert.equal(requests, 2)
	}
	finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})
