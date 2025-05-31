import { fileURLToPath } from 'node:url'
import simpleGit, { CheckRepoActions, type SimpleGit } from 'simple-git'

function chunkArray<T>(array: T[], size: number): T[][] {
	const result: T[][] = []
	for (let i = 0; i < array.length; i += size) {
		result.push(array.slice(i, i + size))
	}
	return result
}

const origin = 'https://github.com/maple-pod/resources.git'
const branch = 'gh-pages'

async function run() {
	const dir = fileURLToPath(new URL('./output', import.meta.url))
	const git: SimpleGit = simpleGit(dir)

	if (await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT)) {
		console.log('Force pulling latest changes from the repository...')
		await git.fetch(origin, branch)
		await git.reset(['--hard', `${origin}/${branch}`])
	}
	else {
		await git.init()
		await git.addRemote('origin', origin)
		await git.checkout(['--orphan', branch])
	}

	const { files } = await git.status()
	const jsonFiles = files.filter(file => file.path.endsWith('.json'))
	const pngFiles = files.filter(file => file.path.endsWith('.png'))
	const mp3Files = files.filter(file => file.path.endsWith('.mp3'))

	if (jsonFiles.length === 0 && pngFiles.length === 0 && mp3Files.length === 0) {
		console.log('No files to commit.')
		return
	}

	let part = 1
	// eslint-disable-next-line style/newline-per-chained-call
	const dateText = new Date().toISOString().split('T')[0]
	// png + json files
	if (jsonFiles.length > 0 || pngFiles.length > 0) {
		console.log(`Committing JSON and PNG files - Part ${part}...`)
		await git.add([...jsonFiles, ...pngFiles].map(file => file.path))
		// Commit with a message `YYYY-MM-DD - Deploy resources - Part {part}`
		const commitMessage = `${dateText} - Deploy resources - Part ${part}`
		await git.commit(commitMessage, [...jsonFiles, ...pngFiles].map(file => file.path))
		part++
		console.log('Pushing commit to the remote repository...')
		await git.push(origin, branch, ['--force'])
	}

	// mp3 files
	if (mp3Files.length > 0) {
		const batchSize = 100
		const batches = chunkArray(mp3Files, batchSize)
		for (const batch of batches) {
			const batchCount = batches.indexOf(batch) + 1
			console.log(`Committing MP3 files - Part ${part} (${batchCount}/${batches.length})...`)
			await git.add(batch.map(file => file.path))
			// Commit with a message `YYYY-MM-DD - Deploy resources - Part {part}`
			const commitMessage = `${dateText} - Deploy resources - Part ${part}`
			await git.commit(commitMessage, batch.map(file => file.path))
			part++
			console.log('Pushing commit to the remote repository...')
			await git.push(origin, branch, ['--force'])
		}
	}

	console.log('Deployment completed successfully!')
}

run()
