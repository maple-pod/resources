import type { SimpleGit } from 'simple-git'
import process, { env } from 'node:process'
import { fileURLToPath } from 'node:url'
import simpleGit, { CheckRepoActions } from 'simple-git'
import { assertRunningInContainer } from './assert-container'

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

async function run() {
	const dir = fileURLToPath(new URL('./output', import.meta.url))
	const git: SimpleGit = simpleGit(dir)

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

		const { files } = await git.status()
		// Only publish known resource paths. output/ may also contain ignored POC or
		// diagnostic artifacts, which must never leak into the gh-pages branch.
		const jsonFiles = files.filter(f => f.path === 'data.json' || f.path === 'bg/bg.json')
		const imageFiles = files.filter(f => /^mark\/[^/]+\.png$/.test(f.path) || /^bg\/[^/]+\.jpg$/.test(f.path))
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
