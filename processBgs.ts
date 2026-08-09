import { mkdir as _mkdir, rename, rm, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import fg from 'fast-glob'
import { deflateSync } from 'fflate'
import path from 'pathe'
import sharp from 'sharp'
import { assertRunningInContainer } from './assert-container'

const root = fileURLToPath(new URL('.', import.meta.url))
const outputDir = path.join(root, 'output/bg')

const mkdir = (dir: string) => _mkdir(dir, { recursive: true }).catch(() => {})

// Latin1 string of raw bytes, chunked because spreading a whole buffer into
// String.fromCharCode overflows the call stack on larger inputs.
function toBinaryString(bytes: Uint8Array): string {
	const chunkSize = 0x8000
	let result = ''
	for (let i = 0; i < bytes.length; i += chunkSize) {
		result += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
	}
	return result
}

async function run() {
	assertRunningInContainer('pnpm process-bgs')
	await mkdir(outputDir)

	const bgImgPaths = fg.sync(path.join(root, 'assets/bg', '*.png'))
	console.log(`Processing ${bgImgPaths.length} background image(s)...\n`)

	const bgData = {
		list: [] as string[],
		preview: {} as Record<string, string>,
	}
	const errors: { file: string, message: string }[] = []

	for (const [idx, imgPath] of bgImgPaths.entries()) {
		const imgName = path.basename(imgPath)
		const name = path.basename(imgName, '.png')
		const outJpeg = path.join(outputDir, `${name}.jpg`)
		const tempJpeg = `${outJpeg}.tmp`

		process.stdout.write(`  (${idx + 1}/${bgImgPaths.length}) ${imgName}...`)

		try {
			// Write full-res JPEG via temp file for atomicity
			await sharp(imgPath)
				.resize(1920, 1080, { fit: 'cover' })
				.jpeg({ quality: 90, mozjpeg: true })
				.toFile(tempJpeg)
			// Validate output is non-empty before committing
			const previewBuffer = await sharp(imgPath)
				.resize(240, 135, { fit: 'cover' })
				.jpeg({ quality: 90, mozjpeg: true })
				.toBuffer()
			if (previewBuffer.length === 0)
				throw new Error('Preview buffer is empty')

			// Atomic rename: only commit once both operations succeeded
			await rename(tempJpeg, outJpeg)

			bgData.list.push(name)
			bgData.preview[name] = toBinaryString(deflateSync(new Uint8Array(previewBuffer)))
			process.stdout.write(' done\n')
		}
		catch (error) {
			process.stdout.write('\n')
			const msg = error instanceof Error ? error.message : String(error)
			console.error(`  [ERROR] Failed to process "${imgName}": ${msg}`)
			// Remove any partial output files
			await rm(tempJpeg, { force: true }).catch(() => {})
			await rm(outJpeg, { force: true }).catch(() => {})
			errors.push({ file: imgName, message: msg })
		}
	}

	await writeFile(
		path.join(outputDir, 'bg.json'),
		JSON.stringify(bgData),
		{ encoding: 'utf-8' },
	)

	console.log()
	if (errors.length > 0) {
		console.error(`[WARN] ${errors.length} image(s) failed to process:`)
		for (const err of errors) {
			console.error(`  - ${err.file}: ${err.message}`)
		}
		process.exit(1)
	}
	else {
		console.log(`Done! Processed ${bgData.list.length} background image(s).`)
	}
}

run()
