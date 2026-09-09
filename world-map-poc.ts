import process from 'node:process'
import { assertRunningInContainer } from './assert-container'
import { parseCatalogSource, runWorldMapGeneration } from './world-map/generate'

assertRunningInContainer('pnpm run poc:world-map')

runWorldMapGeneration({ catalogSource: parseCatalogSource() }).catch((error) => {
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
})
