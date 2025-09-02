import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { mkdir as _mkdir, rm as _rm, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import fg from 'fast-glob'
import { deflateSync, strFromU8 } from 'fflate'
import path from 'pathe'
import sharp from 'sharp'

const root = fileURLToPath(new URL('.', import.meta.url))
const outputDir = path.join(root, 'output/bg')

const mkdir = (dir: string) => _mkdir(dir, { recursive: true }).catch(() => {})

async function run() {
	await mkdir(outputDir)
	const bgImgs = new Set(fg.sync(path.join(root, 'assets/bg', '*.png')).map(file => path.basename(file)))
	const bgData = {
		list: [] as string[],
		preview: {} as Record<string, string>,
	}
	for (const img of bgImgs) {
		const name = path.basename(img, '.png')
		await sharp(path.join(root, 'assets/bg', img))
			.resize(1920, 1080, { fit: 'cover' })
			.jpeg({ quality: 90, mozjpeg: true })
			.toFile(path.join(outputDir, `${name}.jpg`))

		const buffer = await sharp(path.join(root, 'assets/bg', img))
			.resize(240, 135, { fit: 'cover' })
			.jpeg({ quality: 90, mozjpeg: true })
			.toBuffer()

		bgData.list.push(name)
		bgData.preview[name] = String.fromCharCode(...deflateSync(new Uint8Array(buffer)))
	}
	await writeFile(
		path.join(outputDir, 'bg.json'),
		JSON.stringify(bgData),
		{ encoding: 'utf-8' },
	)
}
run()
