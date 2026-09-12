import type { WorldMapRuntimeCompileOptions } from './runtime'
import type { GameDataSource, WorldMapIndex } from './schema'
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'pathe'
import { compileWorldMapRuntime } from './runtime'

export const LEGACY_WORLD_MAP_SCHEMA_VERSION = 6 as const
export const LEGACY_WORLD_MAP_RUNTIME_SCHEMA_VERSION = 1 as const

interface LegacyGameDataSource {
	provider: 'maplestory-io'
	region: string
	version: number | null
	apiBase: string
}

function legacySource(source: GameDataSource): LegacyGameDataSource {
	if (source.provider !== 'maplestory-io')
		throw new Error(`Legacy world-map compatibility output cannot represent provider ${source.provider}`)
	if (source.version === null)
		return { provider: source.provider, region: source.region, version: null, apiBase: source.apiBase }
	if (!/^\d+$/u.test(source.version))
		throw new Error(`Legacy world-map compatibility output requires a numeric version, got ${source.version}`)
	const version = Number(source.version)
	if (!Number.isSafeInteger(version) || version <= 0)
		throw new Error(`Legacy world-map compatibility output requires a positive safe-integer version, got ${source.version}`)
	return { provider: source.provider, region: source.region, version, apiBase: source.apiBase }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

function legacyValue(value: unknown): unknown {
	if (Array.isArray(value))
		return value.map(legacyValue)
	if (!isRecord(value))
		return value
	if ('provider' in value && 'region' in value && 'version' in value && 'apiBase' in value)
		return legacySource(value as unknown as GameDataSource)
	const result: Record<string, unknown> = {}
	for (const [key, child] of Object.entries(value)) {
		if (key === 'canonicalLabelSource' || key === 'hitPath')
			continue
		result[key] = legacyValue(child)
	}
	return result
}

export function createLegacyWorldMapCompatibilityIndex(index: WorldMapIndex): Record<string, unknown> {
	const legacy = legacyValue(index) as Record<string, unknown>
	legacy.schemaVersion = LEGACY_WORLD_MAP_SCHEMA_VERSION
	return legacy
}

function legacyRuntimeCacheKey(graph: unknown): string {
	return createHash('sha256')
		.update(JSON.stringify({ canonicalSchemaVersion: LEGACY_WORLD_MAP_SCHEMA_VERSION, graph }))
		.digest('hex')
}

export async function writeLegacyWorldMapCompatibility(
	index: WorldMapIndex,
	worldMapDirectory: string,
	options: WorldMapRuntimeCompileOptions = {},
): Promise<void> {
	const legacyIndex = createLegacyWorldMapCompatibilityIndex(index)
	const legacyGraph = legacyIndex.graph
	if (!isRecord(legacyGraph) || !Array.isArray(legacyGraph.nodes))
		throw new Error('Legacy world-map compatibility output requires a canonical graph')

	const compiled = compileWorldMapRuntime(index, options)
	const source = legacySource(compiled.manifest.source)
	const nativeVersion = source.version
	if (nativeVersion === null)
		throw new Error('Legacy world-map compatibility runtime requires an available source version')
	const manifest = {
		...compiled.manifest,
		schemaVersion: LEGACY_WORLD_MAP_RUNTIME_SCHEMA_VERSION,
		canonicalSchemaVersion: LEGACY_WORLD_MAP_SCHEMA_VERSION,
		cacheKey: legacyRuntimeCacheKey(legacyGraph),
		source,
		assets: {
			root: 'world-map' as const,
			canonicalImagePath: 'world-map/images' as const,
			nativeWz: {
				region: compiled.manifest.assets.nativeWz.region,
				version: nativeVersion,
				pathPrefix: compiled.manifest.assets.nativeWz.pathPrefix,
			},
		},
	}

	await mkdir(worldMapDirectory, { recursive: true })
	await writeFile(path.join(worldMapDirectory, 'world-maps.json'), `${JSON.stringify(legacyIndex, null, 2)}\n`, 'utf8')
	const nodesDirectory = path.join(worldMapDirectory, 'nodes')
	await rm(nodesDirectory, { recursive: true, force: true })
	await mkdir(nodesDirectory, { recursive: true })
	for (const [chunkPath, chunk] of compiled.chunks) {
		const legacyChunk = {
			schemaVersion: LEGACY_WORLD_MAP_RUNTIME_SCHEMA_VERSION,
			canonicalSchemaVersion: LEGACY_WORLD_MAP_SCHEMA_VERSION,
			worldMapId: chunk.worldMapId,
			node: legacyValue(chunk.node),
		}
		await writeFile(path.join(worldMapDirectory, chunkPath), `${JSON.stringify(legacyChunk)}\n`, 'utf8')
	}
	await writeFile(path.join(worldMapDirectory, 'manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8')
}
