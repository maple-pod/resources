export interface DeployFileStatus {
	path: string
	index?: string
	working_dir?: string
}

export interface DeployPlan {
	/** New audio paths that can be published without replacing a public URL. */
	newAudioFiles: string[]
	/** All locally changed, non-deleted audio paths. */
	audioFiles: string[]
	audioBatches: string[][]
	/** Changed paths that already exist in the local gh-pages history. */
	modifiedAudioFiles: string[]
	jsonFiles: string[]
	imageFiles: string[]
	metadataFiles: string[]
	/** Stale audio paths remain as local pending deletions for separately approved cleanup. */
	staleAudioFiles: string[]
}

export const DEPLOY_AUDIO_BATCH_SIZE = 100

const SNAPSHOT_JSON = /^world-map\/snapshots\/(?:GMS|TWMS)\/[^/]+\/(?:world-maps|manifest)\.json$|^world-map\/snapshots\/(?:GMS|TWMS)\/[^/]+\/nodes\/[^/]+\.json$/
const JSON_PATH = /^(?:data\.json|bg\.json|loudness-analysis\.json|world-map\/(?:catalog\.json|world-maps\.json|manifest\.json)|world-map\/nodes\/[^/]+\.json)$/
const IMAGE_PATH = /^(?:mark\/[^/]+\.png|bg\/[^/]+\.jpg|world-map\/(?:images\/[^/]+|gms\/\d+\/[^/]+\/(?:base|link)-\d+|snapshots\/(?:GMS|TWMS)\/[^/]+\/assets\/[^/]+\/(?:base|link)-\d+)\.(?:png|jpg|jpeg|webp))$/

function chunkArray(array: string[], size: number): string[][] {
	const result: string[][] = []
	for (let i = 0; i < array.length; i += size)
		result.push(array.slice(i, i + size))
	return result
}

function uniquePaths(files: readonly DeployFileStatus[], include: (file: DeployFileStatus) => boolean): string[] {
	const result: string[] = []
	const seen = new Set<string>()
	for (const file of files) {
		if (!include(file) || seen.has(file.path))
			continue
		seen.add(file.path)
		result.push(file.path)
	}
	return result
}

function isAudio(file: DeployFileStatus): boolean {
	return /^bgm\/[^/]+$/.test(file.path)
}

function isDeleted(file: DeployFileStatus): boolean {
	return file.index === 'D' || file.working_dir === 'D'
}

function isDefinitelyNew(file: DeployFileStatus): boolean {
	return (file.index === '?' && file.working_dir === '?')
		|| file.index === 'A'
		|| file.working_dir === 'A'
}

function publishedAudioPaths(dataJson: string): string[] {
	const parsed = JSON.parse(dataJson) as { bgms?: unknown }
	if (!Array.isArray(parsed.bgms))
		throw new Error('Cannot inspect audio references in invalid data.json')

	const paths: string[] = []
	const seen = new Set<string>()
	for (const track of parsed.bgms) {
		if (track == null || typeof track !== 'object' || Array.isArray(track))
			throw new Error('Cannot inspect audio references in invalid data.json')
		const audio = (track as Record<string, unknown>).audio
		if (audio == null || typeof audio !== 'object' || Array.isArray(audio))
			throw new Error('Cannot inspect audio references in invalid data.json')
		const file = (audio as Record<string, unknown>).file
		if (typeof file !== 'string' || !file || file.startsWith('/')
			|| file.split('/').some(segment => !segment || segment === '.' || segment === '..')
			|| file.includes('\\')) {
			throw new Error('Cannot inspect audio references in invalid data.json')
		}
		const resourcePath = file.startsWith('bgm/') ? file : `bgm/${file}`
		if (!seen.has(resourcePath)) {
			seen.add(resourcePath)
			paths.push(resourcePath)
		}
	}
	return paths
}

/** Return newly referenced audio paths so a retry still waits for earlier audio pushes. */
export function getNewlyReferencedAudioFiles(previousDataJson: string | undefined, currentDataJson: string): string[] {
	const previous = new Set(previousDataJson == null ? [] : publishedAudioPaths(previousDataJson))
	return publishedAudioPaths(currentDataJson).filter(file => !previous.has(file))
}

/** Plan explicitly published paths, keeping new audio additions apart from local deletions. */
export function planResourceDeployment(
	files: readonly DeployFileStatus[],
	batchSize = DEPLOY_AUDIO_BATCH_SIZE,
): DeployPlan {
	if (!Number.isInteger(batchSize) || batchSize < 1)
		throw new Error('Deploy audio batch size must be a positive integer')

	const audioFiles = uniquePaths(files, file => isAudio(file) && !isDeleted(file))
	const newAudioFiles = uniquePaths(files, file => isAudio(file) && !isDeleted(file) && isDefinitelyNew(file))
	const modifiedAudioFiles = uniquePaths(files, file => isAudio(file) && !isDeleted(file) && !isDefinitelyNew(file))
	const staleAudioFiles = uniquePaths(files, file => isAudio(file) && isDeleted(file))
	const jsonFiles = uniquePaths(files, file => !isDeleted(file) && (JSON_PATH.test(file.path) || SNAPSHOT_JSON.test(file.path)))
	const imageFiles = uniquePaths(files, file => !isDeleted(file) && IMAGE_PATH.test(file.path))

	return {
		newAudioFiles,
		audioFiles,
		audioBatches: chunkArray(newAudioFiles, batchSize),
		modifiedAudioFiles,
		jsonFiles,
		imageFiles,
		metadataFiles: [...jsonFiles, ...imageFiles],
		staleAudioFiles,
	}
}
