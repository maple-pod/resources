import type { MergedTrack, UpstreamTrack } from './supplemental-catalog'
import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getMapleStoryIoWzAudioUrl } from './wz-audio'

export interface BuildOutputTrack extends UpstreamTrack {
	id?: string
	stableId?: string
	aliases?: string[]
	acquisition: MergedTrack['acquisition']
	metadataAuthority?: MergedTrack['metadataAuthority']
	audioProvenance?: MergedTrack['audioProvenance']
	audio: unknown
	duration: number
}

export function toPublishedBgm(item: BuildOutputTrack): Record<string, unknown> {
	const {
		stableId,
		acquisition,
		metadataAuthority,
		audioProvenance,
		...publishedFields
	} = item
	const published = {
		...publishedFields,
		...(stableId ? { id: stableId } : {}),
	}
	if (!metadataAuthority || !audioProvenance || acquisition.type !== 'maplestory-io-wz-audio')
		return published

	return {
		...published,
		provenance: {
			metadata: metadataAuthority,
			audio: {
				...audioProvenance,
				url: getMapleStoryIoWzAudioUrl(acquisition),
			},
		},
	}
}

export async function writeBuildDataIfComplete(
	outputPath: string,
	data: unknown,
	failures: readonly unknown[],
): Promise<boolean> {
	if (failures.length > 0)
		return false

	const tempPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.tmp_${randomUUID()}`)
	try {
		await writeFile(tempPath, JSON.stringify(data), { encoding: 'utf-8', flag: 'wx' })
		await rename(tempPath, outputPath)
		return true
	}
	catch (error) {
		await rm(tempPath, { force: true }).catch(() => {})
		throw error
	}
}
