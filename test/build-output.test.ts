/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { writeBuildDataIfComplete } from '../build-output'

test('incomplete builds leave the previous data.json untouched', async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'maple-build-output-test-'))
	const outputPath = path.join(tempDir, 'data.json')
	try {
		await writeFile(outputPath, '{"valid":"previous"}', 'utf8')
		const published = await writeBuildDataIfComplete(outputPath, { valid: 'new' }, [new Error('missing audio')])
		assert.equal(published, false)
		assert.equal(await readFile(outputPath, 'utf8'), '{"valid":"previous"}')
		assert.deepEqual(await readdir(tempDir), ['data.json'])
	}
	finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('complete builds atomically replace data.json', async () => {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'maple-build-output-test-'))
	const outputPath = path.join(tempDir, 'data.json')
	try {
		await writeFile(outputPath, '{"valid":"previous"}', 'utf8')
		const published = await writeBuildDataIfComplete(outputPath, { bgms: [] }, [])
		assert.equal(published, true)
		assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), { bgms: [] })
		assert.deepEqual(await readdir(tempDir), ['data.json'])
	}
	finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})
