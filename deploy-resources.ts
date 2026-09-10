import type { SimpleGit } from 'simple-git'
import { cp, copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import process, { env } from 'node:process'
import { fileURLToPath } from 'node:url'
import simpleGit, { CheckRepoActions } from 'simple-git'
import { assertRunningInContainer } from './assert-container'

interface BackgroundIndex {
	list: string[]
	preview: Record<string, string>
}

function chunkArray<T>(array: T[], size: number): T[][] {
	const result: T[][] = []
	for (let i = 0; i < array.length; i += size) {
		result.push(array.slice(i, i + size))
	}
	return result
}

assertRunningInContainer('pnpm deploy')

const origin = 'origin'
const repoUrl = 'https://github.com/maple-pod/resources.git'
const branch = 'gh-pages'
const outputDir = fileURLToPath(new URL('./output', import.meta.url))
const outputBgDir = fileURLToPath(new URL('./output/bg', import.meta.url))
const outputBgIndex = fileURLToPath(new URL('./output/bg.json', import.meta.url))
const staticBgDir = fileURLToPath(new URL('./static/bg', import.meta.url))
const staticBgIndex = fileURLToPath(new URL('./static/bg.json', import.meta.url))

// The remote stored in .git/config never carries the token — otherwise every
// deploy would leave a plaintext credential on disk. The authenticated URL is
// only ever passed to the individual `git push` invocation that needs it.
const pushTarget = env.GH_TOKEN
	? `https://${env.GH_TOKEN}@${repoUrl.slice('https://'.length)}`
	: origin

if (env.GH_TOKEN)
	console.log('Pushing with GH_TOKEN credentials (token not written to disk)')
else
	console.log(`No GH_TOKEN set — pushing to ${origin} (${repoUrl})`)

// git echoes the push target in its output, so strip the token before anything
// reaches the console or a log file.
function redact(text: string): string {
	return env.GH_TOKEN ? text.replaceAll(env.GH_TOKEN, '***') : text
}

async function pushBranch(git: SimpleGit): Promise<void> {
	console.log('Pushing...')
	await git.push([pushTarget, `HEAD:refs/heads/${branch}`])
}

async function syncStaticBackgrounds(): Promise<void> {
	const parsed = JSON.parse(await readFile(staticBgIndex, 'utf8')) as Partial<BackgroundIndex>
	if (!Array.isArray(parsed.list) || parsed.list.length === 0 || !parsed.list.every(name => typeof name === 'string'))
		throw new Error('static/bg.json must contain a non-empty string list')
	if (parsed.preview == null || typeof parsed.preview !== 'object' || Array.isArray(parsed.preview))
		throw new Error('static/bg.json must contain a preview object')

	const imageNames = (await readdir(staticBgDir, { withFileTypes: true }))
		.filter(entry => entry.isFile() && entry.name.endsWith('.jpg'))
		.map(entry => entry.name.slice(0, -'.jpg'.length))
	const listedNames = new Set(parsed.list)
	if (listedNames.size !== parsed.list.length)
		throw new Error('static/bg.json contains duplicate background names')
	if (imageNames.length !== parsed.list.length || imageNames.some(name => !listedNames.has(name)))
		throw new Error(`Static background files do not match static/bg.json (${imageNames.length} JPGs, ${parsed.list.length} listed)`)
	if (Object.keys(parsed.preview).length !== parsed.list.length || parsed.list.some(name => typeof parsed.preview![name] !== 'string'))
		throw new Error('static/bg.json preview entries do not match the background list')

	await rm(outputBgDir, { recursive: true, force: true })
	await cp(staticBgDir, outputBgDir, { recursive: true })
	await copyFile(staticBgIndex, outputBgIndex)
	console.log(`Synced ${parsed.list.length} static background image(s).`)
}

async function run() {
	await mkdir(outputDir, { recursive: true })
	const git: SimpleGit = simpleGit(outputDir)

	try {
		if (await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT)) {
			console.log('Repository already initialized.')
			// Rewrites any token-bearing URL left in .git/config by earlier runs
			await git.remote(['set-url', origin, repoUrl])
		}
		else {
			await git.init()
			await git.addRemote(origin, repoUrl)
			await git.checkout(['--orphan', branch])
		}

		await syncStaticBackgrounds()

		const { files } = await git.status()
		// Only publish known resource paths. output/ may also contain ignored POC or
		// diagnostic artifacts, which must never leak into the gh-pages branch.
		const jsonFiles = files.filter(f => ['data.json', 'bg.json', 'loudness-analysis.json', 'world-map/world-maps.json', 'world-map/manifest.json'].includes(f.path) || /^world-map\/nodes\/[^/]+\.json$/.test(f.path))
		const imageFiles = files.filter(f => /^mark\/[^/]+\.png$/.test(f.path) || /^bg\/[^/]+\.jpg$/.test(f.path) || /^world-map\/(?:images\/[^/]+|gms\/\d+\/[^/]+\/(?:base|link)-\d+)\.(?:png|jpg|jpeg|webp)$/.test(f.path))
		const audioFiles = files.filter(f => /^bgm\/[^/]+$/.test(f.path))

		if (jsonFiles.length === 0 && imageFiles.length === 0 && audioFiles.length === 0) {
			console.log('No files to commit.')
			return
		}

		let part = 1
		const dateText = new Date()
			.toISOString()
			.split('T')[0]!

		// Commit metadata and images first.
		if (jsonFiles.length > 0 || imageFiles.length > 0) {
			const filePaths = [...jsonFiles, ...imageFiles].map(f => f.path)
			console.log(`Committing ${jsonFiles.length} JSON and ${imageFiles.length} image files — Part ${part}...`)
			await git.add(filePaths)
			await git.commit(`${dateText} - Deploy resources - Part ${part}`, filePaths)
			part++
			await pushBranch(git)
		}

		// Commit source-preserved audio files (and stale representation deletions)
		// in batches to avoid oversized commits.
		if (audioFiles.length > 0) {
			const batches = chunkArray(audioFiles, 100)
			for (const [batchIdx, batch] of batches.entries()) {
				const filePaths = batch.map(f => f.path)
				console.log(`Committing audio batch ${batchIdx + 1}/${batches.length} (${filePaths.length} files) — Part ${part}...`)
				await git.add(filePaths)
				await git.commit(`${dateText} - Deploy resources - Part ${part}`, filePaths)
				part++
				await pushBranch(git)
			}
		}

		console.log('Deployment completed successfully!')
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error(`[ERROR] Deployment failed: ${redact(message)}`)
		if (/non-fast-forward|rejected|fetch first/i.test(message)) {
			console.error(`       The local output/ history has diverged from origin/${branch}.`)
			console.error('       Reconcile it deliberately — this script no longer force-pushes.')
		}
		process.exit(1)
	}
}

run()
