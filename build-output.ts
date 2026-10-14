import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

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
