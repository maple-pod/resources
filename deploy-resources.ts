import type { SimpleGit } from 'simple-git'
import process, { env } from 'node:process'
import { fileURLToPath } from 'node:url'
import simpleGit, { CheckRepoActions } from 'simple-git'

function chunkArray<T>(array: T[], size: number): T[][] {
	const result: T[][] = []
	for (let i = 0; i < array.length; i += size) {
		result.push(array.slice(i, i + size))
	}
	return result
}

const origin = 'origin'
const repoUrl = 'https://github.com/maple-pod/resources.git'
let remoteUrl = repoUrl
if (env.GH_TOKEN) {
	remoteUrl = `https://${env.GH_TOKEN}@${repoUrl.slice(8)}`
	console.log('Using authenticated remote URL (token hidden)')
}
else {
	console.log(`Remote URL: ${repoUrl}`)
}
const branch = 'gh-pages'

async function run() {
	const dir = fileURLToPath(new URL('./output', import.meta.url))
	const git: SimpleGit = simpleGit(dir)

	try {
		if (await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT)) {
			console.log('Repository already initialized.')
			await git.remote(['set-url', origin, remoteUrl])
		}
		else {
			await git.init()
			await git.addRemote(origin, remoteUrl)
			await git.checkout(['--orphan', branch])
		}

		const { files } = await git.status()
		// Only commit actual content files; skip hidden/state files (e.g. .build-state.json)
		const jsonFiles = files.filter(f => f.path.endsWith('.json') && !f.path.startsWith('.'))
		const pngFiles = files.filter(f => f.path.endsWith('.png'))
		const mp3Files = files.filter(f => f.path.endsWith('.mp3'))

		if (jsonFiles.length === 0 && pngFiles.length === 0 && mp3Files.length === 0) {
			console.log('No files to commit.')
			return
		}

		let part = 1
		const dateText = new Date().toISOString().split('T')[0]!

		// Commit JSON + PNG files first
		if (jsonFiles.length > 0 || pngFiles.length > 0) {
			const filePaths = [...jsonFiles, ...pngFiles].map(f => f.path)
			console.log(`Committing ${jsonFiles.length} JSON and ${pngFiles.length} PNG files — Part ${part}...`)
			await git.add(filePaths)
			await git.commit(`${dateText} - Deploy resources - Part ${part}`, filePaths)
			part++
			console.log('Pushing...')
			await git.push(['-u', origin, branch, '--force'])
		}

		// Commit MP3 files in batches to avoid oversized commits
		if (mp3Files.length > 0) {
			const batches = chunkArray(mp3Files, 100)
			for (const [batchIdx, batch] of batches.entries()) {
				const filePaths = batch.map(f => f.path)
				console.log(`Committing MP3 batch ${batchIdx + 1}/${batches.length} (${filePaths.length} files) — Part ${part}...`)
				await git.add(filePaths)
				await git.commit(`${dateText} - Deploy resources - Part ${part}`, filePaths)
				part++
				console.log('Pushing...')
				await git.push(['-u', origin, branch, '--force'])
			}
		}

		console.log('Deployment completed successfully!')
	}
	catch (error) {
		console.error(`[ERROR] Deployment failed: ${error instanceof Error ? error.message : error}`)
		process.exit(1)
	}
}

run()
