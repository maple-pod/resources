import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { mkdir as _mkdir, rm as _rm, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import ytdl from '@distube/ytdl-core'
import fg from 'fast-glob'
import { deflateSync, strFromU8 } from 'fflate'
import ffmpeg from 'fluent-ffmpeg'
import { ofetch } from 'ofetch'
import path from 'pathe'

process.env.YTDL_NO_UPDATE = 'true'

interface MapleBgmItem {
	description: string
	filename: string
	mark: string
	metadata: {
		albumArtist: string
		artist: string
		title: string
		year: string
	}
	source: {
		client: string
		date: string
		structure: string
		version: string
	}
	youtube: string
}

interface OutputDataItem {
	title: string
	cover: string
	duration: number
	src: string

	data: MapleBgmItem
}

const outputDir = fileURLToPath(new URL('./output', import.meta.url))
const dataDir = path.join(outputDir)
const bgmDir = path.join(outputDir, 'bgm')
const markDir = path.join(outputDir, 'mark')

const mkdir = (dir: string) => _mkdir(dir, { recursive: true }).catch(() => {})
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let downloadedMarks: Set<string>
let downloadedBgms: Set<string>

async function prepareDirs() {
	await mkdir(dataDir)
	await mkdir(bgmDir)
	await mkdir(markDir)

	downloadedMarks = new Set(fg.sync(path.join(markDir, '*.png')).map(file => path.basename(file)))
	downloadedBgms = new Set(fg.sync(path.join(bgmDir, '*.mp3')).map(file => path.basename(file)))
}

function getMarkFilename(item: OutputDataItem) {
	return `${item.data.mark}.png`
}

function isMarkDownloaded(item: OutputDataItem) {
	const markFilename = getMarkFilename(item)
	return downloadedMarks.has(markFilename)
}

async function downloadMark(item: OutputDataItem) {
	const markFilename = getMarkFilename(item)
	const markUrl = `https://maplestory-music.github.io/mark/${markFilename}`
	const markPath = path.join(markDir, markFilename)

	const response = await ofetch(markUrl, { responseType: 'arrayBuffer' })
	await writeFile(markPath, Buffer.from(response))
	downloadedMarks.add(markFilename)
}

function getBgmFilename(item: OutputDataItem) {
	return `${item.data.filename}.mp3`
}

async function getBgmDuration(item: OutputDataItem) {
	const bgmFilename = getBgmFilename(item)
	const bgmPath = path.join(bgmDir, bgmFilename)
	const duration = await new Promise<number>((resolve, reject) => {
		ffmpeg.ffprobe(bgmPath, (err, metadata) => {
			if (err)
				return reject(err)
			resolve(metadata.format.duration || 0)
		})
	})
	return duration
}

function isBgmDownloaded(item: OutputDataItem) {
	const bgmFilename = getBgmFilename(item)
	return downloadedBgms.has(bgmFilename)
}

async function downloadBgm(item: OutputDataItem) {
	const bgmFilename = getBgmFilename(item)
	const bgmYoutubeId = item.data.youtube
	const bgmPath = path.join(bgmDir, bgmFilename)

	await delay(5000) // To avoid hitting YouTube's rate limit
	await new Promise<void>((resolve, reject) => {
		const stream = ytdl(bgmYoutubeId, { quality: 'highestaudio', filter: 'audioonly' })
		ffmpeg(stream)
			.save(bgmPath)
			.on('end', () => resolve())
			.on('error', err => reject(err))
	})
	downloadedBgms.add(bgmFilename)
}

function chunkArray<T>(array: T[], size: number): T[][] {
	const result: T[][] = []
	for (let i = 0; i < array.length; i += size) {
		result.push(array.slice(i, i + size))
	}
	return result
}

async function main() {
	await prepareDirs()
	const outputData: OutputDataItem[] = (await ofetch<MapleBgmItem[]>('https://raw.githubusercontent.com/maplestory-music/maplebgm-db/prod/bgm.min.json', { responseType: 'json' }))
		.filter(item => item.youtube)
		.map<OutputDataItem>(item => ({
			title: item.metadata.title,
			cover: `/mark/${item.mark}.png`,
			duration: 0, // Duration will be set after downloading the audio
			src: `/bgm/${item.filename}.mp3`,
			data: item,
		}))

	const errorLogs: { type: 'bgm' | 'mark', message: string }[] = []

	// 1. Download
	await (async () => {
		const toDownloadList = outputData.filter(i => !isMarkDownloaded(i) || !isBgmDownloaded(i))
		for (const item of toDownloadList) {
			const index = toDownloadList.indexOf(item) + 1
			const total = toDownloadList.length
			console.log(`Downloading ${item.data.filename}... (${index}/${total})`)
			const [markResult, bgmResult] = await Promise.allSettled([
				downloadMark(item),
				downloadBgm(item),
			])
			if (markResult.status === 'rejected') {
				errorLogs.push({ type: 'mark', message: `Failed to download mark for ${item.data.mark}: ${markResult.reason}` })
			}
			if (bgmResult.status === 'rejected') {
				errorLogs.push({ type: 'bgm', message: `Failed to download BGM for ${item.data.mark}: ${bgmResult.reason}` })
			}
		}
	})()

	// 2. Update duration info (batch)
	await (async () => {
		const batches = chunkArray(outputData, 50)
		for (const batch of batches) {
			const index = batches.indexOf(batch) + 1
			const total = batches.length
			console.log(`Updating duration info... (batch ${index}/${total})`)
			await Promise.all(batch.map(async (item) => {
				try {
					item.duration = await getBgmDuration(item)
				}
				catch (error) {
					errorLogs.push({ type: 'bgm', message: `Failed to get duration for ${item.data.filename}: ${error}` })
					item.duration = 0 // Set to 0 if failed
				}
			}))
		}
	})()

	// 3. Encode marks (batch)
	const marks: Record<string, string> = {}
	await (async () => {
		const batches = chunkArray(outputData, 50)
		for (const batch of batches) {
			const index = batches.indexOf(batch) + 1
			const total = batches.length
			console.log(`Encoding mark files... (batch ${index}/${total})`)
			await Promise.all(batch.map(async (item) => {
				const markFilename = getMarkFilename(item)
				const markPath = path.join(markDir, markFilename)
				const buf = new Uint8Array(readFileSync(markPath))
				const compressed = deflateSync(buf)
				marks[item.data.mark] = String.fromCharCode(...compressed)
			}))
		}
	})()

	if (errorLogs.length > 0) {
		const errorLogPath = path.join(outputDir, `error-${Date.now()}.log`)
		console.error('Errors occurred', errorLogPath)
		await writeFile(errorLogPath, JSON.stringify(errorLogs, null, 2), { encoding: 'utf-8' })
	}

	await writeFile(
		path.join(dataDir, 'data.json'),
		JSON.stringify({
			bgms: outputData,
			marks,
			builtAt: Date.now(),
		}),
		{ encoding: 'utf-8' },
	)

	await delay(1000) // Wait for a second before pushing to remote
}

main()
