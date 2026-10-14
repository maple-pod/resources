import type { SimpleGit } from 'simple-git'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process, { env } from 'node:process'
import { fileURLToPath } from 'node:url'
import simpleGit, { CheckRepoActions } from 'simple-git'
import { assertRunningInContainer } from './assert-container'
import { getNewlyReferencedAudioFiles, planResourceDeployment } from './deploy-plan'
import { waitForLiveAudioAssets } from './deploy-readiness'

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
		// Only explicitly published resource paths are eligible. output/ can also
		// contain ignored POC or diagnostic artifacts, which must never be pushed.
		const plan = planResourceDeployment(files)
		if (plan.staleAudioFiles.length > 0) {
			console.log(`[DEFERRED] ${plan.staleAudioFiles.length} stale audio deletion(s) remain pending locally. Cleanup requires separate explicit approval and a manual deployment.`)
		}
		if (plan.modifiedAudioFiles.length > 0) {
			throw new Error(`Refusing to publish changed audio at an existing URL without comparable remote hash proof: ${plan.modifiedAudioFiles.join(', ')}. Keep the old URL and publish the new bytes under a new immutable filename.`)
		}

		if (plan.metadataFiles.length === 0 && plan.newAudioFiles.length === 0) {
			console.log('No files to commit.')
			return
		}

		let part = 1
		const dateText = new Date()
			.toISOString()
			.split('T')[0]!

		// Publish new immutable audio paths before metadata can reference them.
		for (const [batchIdx, batch] of plan.audioBatches.entries()) {
			console.log(`Committing new audio batch ${batchIdx + 1}/${plan.audioBatches.length} (${batch.length} files) — Part ${part}...`)
			await git.add(batch)
			await git.commit(`${dateText} - Deploy resources - Part ${part}`, batch)
			part++
			await pushBranch(git)
		}

		// GitHub Pages and the custom domain update asynchronously. Check only the
		// audio paths newly referenced by the pending data.json. Comparing against
		// HEAD also retries readiness after a previous run pushed audio but stopped
		// before publishing metadata.
		if (plan.metadataFiles.length > 0) {
			if (plan.metadataFiles.includes('data.json')) {
				const currentDataJson = await readFile(path.join(dir, 'data.json'), 'utf8')
				let previousDataJson: string | undefined
				try {
					previousDataJson = await git.show(['HEAD:data.json'])
				}
				catch {
					// An empty orphan branch or first publish has no prior data.json.
				}
				const newlyReferencedAudioFiles = getNewlyReferencedAudioFiles(previousDataJson, currentDataJson)
				if (newlyReferencedAudioFiles.length > 0) {
					console.log(`Waiting for ${newlyReferencedAudioFiles.length} newly referenced audio asset(s) to become publicly visible...`)
					await waitForLiveAudioAssets(newlyReferencedAudioFiles)
					console.log('All newly referenced audio assets are publicly visible.')
				}
			}

			const filePaths = plan.metadataFiles
			console.log(`Committing ${plan.jsonFiles.length} JSON and ${plan.imageFiles.length} image files — Part ${part}...`)
			await git.add(filePaths)
			await git.commit(`${dateText} - Deploy resources - Part ${part}`, filePaths)
			part++
			await pushBranch(git)
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
