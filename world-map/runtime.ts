import type { GameDataSource, NormalizedRect, WorldMapAsset, WorldMapGraph, WorldMapIndex, WorldMapNode } from './schema'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'pathe'
import { WORLD_MAP_SCHEMA_VERSION } from './schema'

export const WORLD_MAP_RUNTIME_SCHEMA_VERSION = 1 as const

export interface WorldMapRuntimeNodeIndex {
	worldMapId: string
	chunk: string
	worldMapName: string
	canonicalLabel: string | null
	parentWorldMapId: string | null
	/** The native parent was retained but its node is absent from the acquired graph. */
	missingParentWorldMapId: string | null
	childWorldMapIds: string[]
	linkTargetWorldMapIds: string[]
	/** Link targets intentionally omitted by a bounded preview graph. */
	missingLinkTargetWorldMapIds: string[]
}

export interface WorldMapRuntimeAssetMetadata {
	root: 'world-map'
	canonicalImagePath: 'world-map/images'
	nativeWz: {
		region: string
		version: number
		pathPrefix: string
	}
}

export interface WorldMapRuntimeManifest {
	schemaVersion: typeof WORLD_MAP_RUNTIME_SCHEMA_VERSION
	canonicalSchemaVersion: typeof WORLD_MAP_SCHEMA_VERSION
	generatedAt: string
	/** SHA-256 of the canonical graph and schema versions; generatedAt is excluded. */
	cacheKey: string
	roots: string[]
	nodeCount: number
	nodes: WorldMapRuntimeNodeIndex[]
	unresolved: {
		missingParentWorldMapIds: string[]
		missingLinkTargetWorldMapIds: string[]
	}
	source: GameDataSource
	assets: WorldMapRuntimeAssetMetadata
}

export interface WorldMapRuntimeNodeChunk {
	schemaVersion: typeof WORLD_MAP_RUNTIME_SCHEMA_VERSION
	canonicalSchemaVersion: typeof WORLD_MAP_SCHEMA_VERSION
	worldMapId: string
	node: WorldMapNode
}

export interface WorldMapRuntimeCompilation {
	manifest: WorldMapRuntimeManifest
	chunks: Map<string, WorldMapRuntimeNodeChunk>
}

export interface WorldMapRuntimeCompileOptions {
	bgmIds?: ReadonlySet<string>
}

export interface WorldMapRuntimeWriteResult {
	manifestFile: string
	nodeFiles: string[]
	manifest: WorldMapRuntimeManifest
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

function fail(message: string): never {
	throw new Error(`World-map runtime validation failed: ${message}`)
}

function assertString(value: unknown, field: string, allowEmpty = false): asserts value is string {
	if (typeof value !== 'string' || (!allowEmpty && value.length === 0))
		fail(`${field} must be a non-empty string`)
}

function assertNullableString(value: unknown, field: string): asserts value is string | null {
	if (value !== null && typeof value !== 'string')
		fail(`${field} must be a string or null`)
}

function assertInteger(value: unknown, field: string): asserts value is number {
	if (!Number.isInteger(value))
		fail(`${field} must be an integer`)
}

function assertFiniteNumber(value: unknown, field: string): asserts value is number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		fail(`${field} must be finite`)
}

function validateSource(source: unknown, field: string, allowUnavailable = false): asserts source is GameDataSource {
	if (!isRecord(source))
		fail(`${field} must be an object`)
	if (source.provider !== 'maplestory-io' || typeof source.region !== 'string' || source.region.length === 0)
		fail(`${field} has invalid provider or region`)
	const validVersion = source.version === null
		? allowUnavailable
		: Number.isSafeInteger(source.version) && (source.version as number) > 0
	if (!validVersion)
		fail(`${field}.version must be a positive integer`)
	assertString(source.apiBase, `${field}.apiBase`)
	if (!/^https?:\/\//u.test(source.apiBase))
		fail(`${field}.apiBase must be an HTTP(S) URL`)
}

function validateLocalizedNames(names: unknown, field: string, join: 'mapId' | 'worldMapId'): void {
	if (!isRecord(names))
		fail(`${field} must be an object`)
	for (const [locale, value] of Object.entries(names)) {
		if (!locale || !isRecord(value))
			fail(`${field}.${locale} is invalid`)
		assertNullableString(value.name, `${field}.${locale}.name`)
		if (value.status !== 'available' && value.status !== 'unavailable')
			fail(`${field}.${locale}.status is invalid`)
		validateSource(value.source, `${field}.${locale}.source`, value.status === 'unavailable')
		if (value.status === 'unavailable' && (value.name !== null || value.join !== null))
			fail(`${field}.${locale} has inconsistent unavailable fields`)
		if (value.status === 'available') {
			if (value.name === null ? value.join !== null : value.join !== join)
				fail(`${field}.${locale} has an invalid name/join pair`)
		}
	}
}

function validateRect(rect: unknown, field: string): asserts rect is NormalizedRect | null {
	if (rect === null)
		return
	if (!isRecord(rect))
		fail(`${field} must be an object or null`)
	for (const key of ['left', 'top', 'width', 'height'])
		assertFiniteNumber(rect[key], `${field}.${key}`)
	if ((rect.width as number) <= 0 || (rect.height as number) <= 0)
		fail(`${field} must have positive dimensions`)
}

function validateAsset(asset: unknown, field: string, nullable = false): asserts asset is WorldMapAsset {
	if (asset === null && nullable)
		return
	if (!isRecord(asset))
		fail(`${field} must be an object`)
	assertString(asset.file, `${field}.file`)
	if (asset.file.startsWith('/') || asset.file.includes('..'))
		fail(`${field}.file is not a safe relative path`)
	assertInteger(asset.width, `${field}.width`)
	assertInteger(asset.height, `${field}.height`)
	if ((asset.width as number) <= 0 || (asset.height as number) <= 0)
		fail(`${field} has invalid dimensions`)
	if (typeof asset.sha1 !== 'string' || !/^[a-f0-9]{40}$/iu.test(asset.sha1))
		fail(`${field}.sha1 is invalid`)
	if (!isRecord(asset.origin))
		fail(`${field}.origin must be an object`)
	assertInteger(asset.origin.x, `${field}.origin.x`)
	assertInteger(asset.origin.y, `${field}.origin.y`)
}

function validateGraphBgm(value: unknown, field: string, bgmIds?: ReadonlySet<string>): void {
	if (value === null)
		return
	if (!isRecord(value))
		fail(`${field} must be an object or null`)
	assertString(value.path, `${field}.path`)
	assertNullableString(value.structure, `${field}.structure`)
	assertNullableString(value.filename, `${field}.filename`)
	assertNullableString(value.trackId, `${field}.trackId`)
	if (value.trackId != null && bgmIds != null && !bgmIds.has(value.trackId))
		fail(`${field}.trackId references an unknown track`)
}

function validateGraphMap(value: unknown, field: string, mapNumbers: readonly string[], bgmIds?: ReadonlySet<string>): void {
	if (!isRecord(value))
		fail(`${field} must be an object`)
	assertString(value.mapId, `${field}.mapId`)
	if (!/^\d+$/u.test(value.mapId) || !mapNumbers.includes(value.mapId))
		fail(`${field}.mapId is not present in the native mapNumbers`)
	assertNullableString(value.name, `${field}.name`)
	assertNullableString(value.streetName, `${field}.streetName`)
	assertNullableString(value.mapMark, `${field}.mapMark`)
	validateLocalizedNames(value.localizedNames, `${field}.localizedNames`, 'mapId')
	validateGraphBgm(value.gameBgm, `${field}.gameBgm`, bgmIds)
	if (!isRecord(value.selection))
		fail(`${field}.selection must be an object`)
	assertNullableString(value.selection.trackId, `${field}.selection.trackId`)
	if (value.selection.source !== null && value.selection.source !== 'gms-map-bgm')
		fail(`${field}.selection.source is invalid`)
	if (value.selection.trackId !== null && value.selection.source === null)
		fail(`${field}.selection has a track without a source`)
	if (value.selection.trackId != null && bgmIds != null && !bgmIds.has(value.selection.trackId))
		fail(`${field}.selection.trackId references an unknown track`)
}

function validateRuntimeNode(node: unknown, field: string, bgmIds?: ReadonlySet<string>): asserts node is WorldMapNode {
	if (!isRecord(node))
		fail(`${field} must be an object`)
	assertString(node.worldMapId, `${field}.worldMapId`)
	if (!/^[a-z][a-z0-9]*$/iu.test(node.worldMapId))
		fail(`${field}.worldMapId is invalid`)
	assertString(node.worldMapName, `${field}.worldMapName`, true)
	assertNullableString(node.canonicalLabel, `${field}.canonicalLabel`)
	validateLocalizedNames(node.localizedNames, `${field}.localizedNames`, 'worldMapId')
	assertNullableString(node.parentWorldMapId, `${field}.parentWorldMapId`)
	validateSource(node.provenance, `${field}.provenance`)
	if (!Array.isArray(node.baseImages) || node.baseImages.length === 0)
		fail(`${field}.baseImages must be a non-empty array`)
	for (const [index, asset] of node.baseImages.entries())
		validateAsset(asset, `${field}.baseImages[${index}]`)
	if (!Array.isArray(node.links))
		fail(`${field}.links must be an array`)
	const linkIds = new Set<string>()
	for (const [index, link] of node.links.entries()) {
		const linkField = `${field}.links[${index}]`
		if (!isRecord(link))
			fail(`${linkField} must be an object`)
		assertString(link.id, `${linkField}.id`)
		if (!linkIds.add(link.id))
			fail(`${field} has duplicate link id ${link.id}`)
		assertNullableString(link.canonicalLabel, `${linkField}.canonicalLabel`)
		validateLocalizedNames(link.localizedNames, `${linkField}.localizedNames`, 'worldMapId')
		assertString(link.targetWorldMapId, `${linkField}.targetWorldMapId`)
		if (!isRecord(link.screenOrigin))
			fail(`${linkField}.screenOrigin must be an object`)
		assertInteger(link.screenOrigin.x, `${linkField}.screenOrigin.x`)
		assertInteger(link.screenOrigin.y, `${linkField}.screenOrigin.y`)
		validateAsset(link.linkImage, `${linkField}.linkImage`, true)
		validateRect(link.hitRect, `${linkField}.hitRect`)
	}
	if (!Array.isArray(node.spots))
		fail(`${field}.spots must be an array`)
	const spotIds = new Set<string>()
	for (const [index, spot] of node.spots.entries()) {
		const spotField = `${field}.spots[${index}]`
		if (!isRecord(spot))
			fail(`${spotField} must be an object`)
		assertString(spot.id, `${spotField}.id`)
		if (!spotIds.add(spot.id))
			fail(`${field} has duplicate spot id ${spot.id}`)
		if (!isRecord(spot.spot))
			fail(`${spotField}.spot must be an object`)
		assertInteger(spot.spot.x, `${spotField}.spot.x`)
		assertInteger(spot.spot.y, `${spotField}.spot.y`)
		if (spot.type !== null && typeof spot.type !== 'number' && typeof spot.type !== 'string')
			fail(`${spotField}.type is invalid`)
		if (!Array.isArray(spot.mapNumbers) || spot.mapNumbers.some(mapId => typeof mapId !== 'string' || !/^\d+$/u.test(mapId)))
			fail(`${spotField}.mapNumbers is invalid`)
		if (!isRecord(spot.point))
			fail(`${spotField}.point must be an object`)
		for (const key of ['x', 'y', 'normalizedX', 'normalizedY'])
			assertFiniteNumber(spot.point[key], `${spotField}.point.${key}`)
		validateRect(spot.hitRect, `${spotField}.hitRect`)
		if (!Array.isArray(spot.maps))
			fail(`${spotField}.maps must be an array`)
		for (const [mapIndex, map] of spot.maps.entries())
			validateGraphMap(map, `${spotField}.maps[${mapIndex}]`, spot.mapNumbers, bgmIds)
	}
}

function sameStringArray(actual: readonly string[], expected: readonly string[]): boolean {
	return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function graphSource(graph: WorldMapGraph): GameDataSource & { version: number } {
	const first = graph.nodes[0]?.provenance
	if (first == null)
		throw new Error('World-map runtime compilation requires at least one graph node')
	if (first.version == null)
		throw new Error('World-map runtime compilation requires a canonical graph version')
	for (const node of graph.nodes) {
		if (JSON.stringify(node.provenance) !== JSON.stringify(first))
			throw new Error(`World-map runtime compilation found inconsistent provenance at ${node.worldMapId}`)
	}
	return { ...first, version: first.version }
}

function runtimeCacheKey(graph: WorldMapGraph): string {
	return createHash('sha256')
		.update(JSON.stringify({ canonicalSchemaVersion: WORLD_MAP_SCHEMA_VERSION, graph }))
		.digest('hex')
}

export function compileWorldMapRuntime(index: WorldMapIndex, options: WorldMapRuntimeCompileOptions = {}): WorldMapRuntimeCompilation {
	if (index.schemaVersion !== WORLD_MAP_SCHEMA_VERSION)
		throw new Error(`World-map runtime compilation requires canonical schema ${WORLD_MAP_SCHEMA_VERSION}`)
	if (!Number.isFinite(Date.parse(index.generatedAt)))
		throw new Error('World-map runtime compilation requires an ISO generatedAt')
	const graph = index.graph
	if (graph == null)
		throw new Error('World-map runtime compilation requires the canonical graph')
	const source = graphSource(graph)
	const nodeIds = new Set<string>()
	for (const node of graph.nodes) {
		if (!nodeIds.add(node.worldMapId))
			throw new Error(`World-map runtime compilation found duplicate node ${node.worldMapId}`)
		validateRuntimeNode(node, `graph.nodes.${node.worldMapId}`, options.bgmIds)
	}
	const roots = [...graph.roots]
	const nodes = graph.nodes.map((node) => {
		const missingParentWorldMapId = node.parentWorldMapId != null && !nodeIds.has(node.parentWorldMapId)
			? node.parentWorldMapId
			: null
		const childWorldMapIds = graph.nodes
			.filter(candidate => candidate.parentWorldMapId === node.worldMapId)
			.map(candidate => candidate.worldMapId)
		const linkTargetWorldMapIds = [...new Set(node.links.map(link => link.targetWorldMapId))]
		const missingLinkTargetWorldMapIds = linkTargetWorldMapIds.filter(target => !nodeIds.has(target))
		return {
			worldMapId: node.worldMapId,
			chunk: `nodes/${node.worldMapId}.json`,
			worldMapName: node.worldMapName,
			canonicalLabel: node.canonicalLabel,
			parentWorldMapId: node.parentWorldMapId,
			missingParentWorldMapId,
			childWorldMapIds,
			linkTargetWorldMapIds,
			missingLinkTargetWorldMapIds,
		}
	})
	const manifest: WorldMapRuntimeManifest = {
		schemaVersion: WORLD_MAP_RUNTIME_SCHEMA_VERSION,
		canonicalSchemaVersion: WORLD_MAP_SCHEMA_VERSION,
		generatedAt: index.generatedAt,
		cacheKey: runtimeCacheKey(graph),
		roots,
		nodeCount: nodes.length,
		nodes,
		unresolved: {
			missingParentWorldMapIds: [...new Set(nodes.flatMap(node => node.missingParentWorldMapId == null ? [] : [node.missingParentWorldMapId]))],
			missingLinkTargetWorldMapIds: [...new Set(nodes.flatMap(node => node.missingLinkTargetWorldMapIds))],
		},
		source,
		assets: {
			root: 'world-map',
			canonicalImagePath: 'world-map/images',
			nativeWz: {
				region: source.region,
				version: source.version,
				pathPrefix: `world-map/gms/${source.version}`,
			},
		},
	}
	const chunks = new Map(graph.nodes.map(node => [
		`nodes/${node.worldMapId}.json`,
		{
			schemaVersion: WORLD_MAP_RUNTIME_SCHEMA_VERSION,
			canonicalSchemaVersion: WORLD_MAP_SCHEMA_VERSION,
			worldMapId: node.worldMapId,
			node,
		},
	] as const))
	validateWorldMapRuntime(manifest, chunks, options)
	return { manifest, chunks }
}

export function validateWorldMapRuntime(
	manifest: WorldMapRuntimeManifest,
	chunks: ReadonlyMap<string, WorldMapRuntimeNodeChunk>,
	options: Pick<WorldMapRuntimeCompileOptions, 'bgmIds'> = {},
): void {
	if (manifest.schemaVersion !== WORLD_MAP_RUNTIME_SCHEMA_VERSION)
		fail(`unsupported manifest schemaVersion: ${String(manifest.schemaVersion)}`)
	if (manifest.canonicalSchemaVersion !== WORLD_MAP_SCHEMA_VERSION)
		fail(`unsupported canonicalSchemaVersion: ${String(manifest.canonicalSchemaVersion)}`)
	if (!Number.isFinite(Date.parse(manifest.generatedAt)))
		fail('manifest.generatedAt must be an ISO date')
	if (!/^[a-f0-9]{64}$/iu.test(manifest.cacheKey))
		fail('manifest.cacheKey must be a SHA-256')
	validateSource(manifest.source, 'manifest.source')
	if (!isRecord(manifest.assets) || manifest.assets.root !== 'world-map' || manifest.assets.canonicalImagePath !== 'world-map/images')
		fail('manifest.assets has invalid path metadata')
	if (!isRecord(manifest.assets.nativeWz) || manifest.assets.nativeWz.region !== manifest.source.region || manifest.assets.nativeWz.version !== manifest.source.version)
		fail('manifest.assets.nativeWz does not match manifest.source')
	assertString(manifest.assets.nativeWz.pathPrefix, 'manifest.assets.nativeWz.pathPrefix')
	if (manifest.nodeCount !== manifest.nodes.length)
		fail('manifest.nodeCount does not match nodes.length')
	const invalidUnresolved = !isRecord(manifest.unresolved)
		|| !Array.isArray(manifest.unresolved.missingParentWorldMapIds)
		|| !Array.isArray(manifest.unresolved.missingLinkTargetWorldMapIds)
		|| manifest.unresolved.missingParentWorldMapIds.some(value => typeof value !== 'string')
		|| manifest.unresolved.missingLinkTargetWorldMapIds.some(value => typeof value !== 'string')
	if (invalidUnresolved) {
		fail('manifest.unresolved has an invalid shape')
	}
	const nodeById = new Map<string, WorldMapRuntimeNodeIndex>()
	const chunkPaths = new Set<string>()
	for (const entry of manifest.nodes) {
		assertString(entry.worldMapId, 'manifest.nodes[].worldMapId')
		if (nodeById.has(entry.worldMapId))
			fail(`manifest has duplicate node ${entry.worldMapId}`)
		if (!nodeById.set(entry.worldMapId, entry))
			fail(`manifest could not index node ${entry.worldMapId}`)
		if (entry.chunk !== `nodes/${entry.worldMapId}.json` || chunkPaths.has(entry.chunk))
			fail(`manifest has an invalid or duplicate chunk for ${entry.worldMapId}`)
		chunkPaths.add(entry.chunk)
		assertString(entry.worldMapName, `manifest.${entry.worldMapId}.worldMapName`, true)
		assertNullableString(entry.canonicalLabel, `manifest.${entry.worldMapId}.canonicalLabel`)
		assertNullableString(entry.parentWorldMapId, `manifest.${entry.worldMapId}.parentWorldMapId`)
		assertNullableString(entry.missingParentWorldMapId, `manifest.${entry.worldMapId}.missingParentWorldMapId`)
		for (const [field, values] of Object.entries({ childWorldMapIds: entry.childWorldMapIds, linkTargetWorldMapIds: entry.linkTargetWorldMapIds, missingLinkTargetWorldMapIds: entry.missingLinkTargetWorldMapIds })) {
			if (!Array.isArray(values) || values.some(value => typeof value !== 'string'))
				fail(`manifest.${entry.worldMapId}.${field} is invalid`)
		}
		if (new Set(entry.missingLinkTargetWorldMapIds).size !== entry.missingLinkTargetWorldMapIds.length)
			fail(`manifest.${entry.worldMapId}.missingLinkTargetWorldMapIds contains duplicates`)
	}
	const roots = new Set(manifest.roots)
	if (roots.size !== manifest.roots.length)
		fail('manifest.roots contains duplicates')
	for (const root of manifest.roots) {
		const entry = nodeById.get(root)
		if (entry == null || entry.parentWorldMapId !== null)
			fail(`manifest root ${root} is not a parent-null node`)
	}
	for (const entry of manifest.nodes) {
		if (entry.parentWorldMapId === null) {
			if (!roots.has(entry.worldMapId))
				fail(`parent-null node ${entry.worldMapId} is missing from manifest.roots`)
		}
		else if (!nodeById.has(entry.parentWorldMapId)) {
			if (entry.missingParentWorldMapId !== entry.parentWorldMapId)
				fail(`${entry.worldMapId} has an unindexed missing parent ${entry.parentWorldMapId}`)
		}
		else if (entry.missingParentWorldMapId !== null) {
			fail(`${entry.worldMapId} marks a known parent as missing`)
		}
		if (entry.parentWorldMapId === null && entry.missingParentWorldMapId !== null)
			fail(`${entry.worldMapId} has a missing parent without a native parentWorldMapId`)
		const expectedChildren = manifest.nodes
			.filter(candidate => candidate.parentWorldMapId === entry.worldMapId)
			.map(candidate => candidate.worldMapId)
		if (!sameStringArray(entry.childWorldMapIds, expectedChildren))
			fail(`${entry.worldMapId}.childWorldMapIds does not match parent references`)
		const chunk = chunks.get(entry.chunk)
		if (chunk == null)
			fail(`manifest node ${entry.worldMapId} is missing chunk ${entry.chunk}`)
		if (chunk.worldMapId !== entry.worldMapId)
			fail(`chunk ${entry.chunk} has the wrong worldMapId`)
		if (chunk.schemaVersion !== WORLD_MAP_RUNTIME_SCHEMA_VERSION || chunk.canonicalSchemaVersion !== WORLD_MAP_SCHEMA_VERSION)
			fail(`chunk ${entry.chunk} has an unsupported schema version`)
		validateRuntimeNode(chunk.node, `chunk ${entry.chunk}.node`, options.bgmIds)
		if (chunk.node.worldMapId !== entry.worldMapId)
			fail(`chunk ${entry.chunk}.node.worldMapId does not match its manifest entry`)
		if (chunk.node.worldMapName !== entry.worldMapName || chunk.node.canonicalLabel !== entry.canonicalLabel || chunk.node.parentWorldMapId !== entry.parentWorldMapId)
			fail(`chunk ${entry.chunk}.node navigation metadata does not match its manifest entry`)
		const expectedLinks = [...new Set(chunk.node.links.map(link => link.targetWorldMapId))]
		if (!sameStringArray(entry.linkTargetWorldMapIds, expectedLinks))
			fail(`${entry.worldMapId}.linkTargetWorldMapIds does not match its node`)
		const expectedMissingLinks = expectedLinks.filter(target => !nodeById.has(target))
		if (!sameStringArray(entry.missingLinkTargetWorldMapIds, expectedMissingLinks))
			fail(`${entry.worldMapId}.missingLinkTargetWorldMapIds does not match its node`)
	}
	const expectedMissingParents = [...new Set(manifest.nodes.flatMap(entry => entry.missingParentWorldMapId == null ? [] : [entry.missingParentWorldMapId]))]
	const expectedMissingLinks = [...new Set(manifest.nodes.flatMap(entry => entry.missingLinkTargetWorldMapIds))]
	if (!sameStringArray(manifest.unresolved.missingParentWorldMapIds, expectedMissingParents))
		fail('manifest.unresolved.missingParentWorldMapIds does not match node entries')
	if (!sameStringArray(manifest.unresolved.missingLinkTargetWorldMapIds, expectedMissingLinks))
		fail('manifest.unresolved.missingLinkTargetWorldMapIds does not match node entries')
	if (chunks.size !== manifest.nodes.length)
		fail(`expected exactly ${manifest.nodes.length} chunks, found ${chunks.size}`)
	for (const chunkPath of chunks.keys()) {
		if (!chunkPaths.has(chunkPath))
			fail(`chunk ${chunkPath} is not indexed by the manifest`)
	}
}

export async function writeWorldMapRuntime(
	index: WorldMapIndex,
	worldMapDirectory: string,
	options: WorldMapRuntimeCompileOptions = {},
): Promise<WorldMapRuntimeWriteResult> {
	const compiled = compileWorldMapRuntime(index, options)
	const nodesDirectory = path.join(worldMapDirectory, 'nodes')
	await rm(nodesDirectory, { recursive: true, force: true })
	await mkdir(nodesDirectory, { recursive: true })
	const nodeFiles: string[] = []
	for (const [chunkPath, chunk] of compiled.chunks) {
		const file = path.join(worldMapDirectory, chunkPath)
		await writeFile(file, `${JSON.stringify(chunk)}\n`, 'utf8')
		nodeFiles.push(file)
	}
	const manifestFile = path.join(worldMapDirectory, 'manifest.json')
	await writeFile(manifestFile, `${JSON.stringify(compiled.manifest)}\n`, 'utf8')
	await validateWorldMapRuntimeOutput(worldMapDirectory, options)
	return { manifestFile, nodeFiles, manifest: compiled.manifest }
}

export async function validateWorldMapRuntimeOutput(
	worldMapDirectory: string,
	options: Pick<WorldMapRuntimeCompileOptions, 'bgmIds'> = {},
): Promise<WorldMapRuntimeManifest> {
	let manifest: WorldMapRuntimeManifest
	try {
		manifest = JSON.parse(await readFile(path.join(worldMapDirectory, 'manifest.json'), 'utf8')) as WorldMapRuntimeManifest
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(`Could not read world-map runtime manifest: ${message}`)
	}
	const nodesDirectory = path.join(worldMapDirectory, 'nodes')
	const entries = await readdir(nodesDirectory, { withFileTypes: true })
	const jsonFiles = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => `nodes/${entry.name}`)
	const chunks = new Map<string, WorldMapRuntimeNodeChunk>()
	for (const chunkPath of jsonFiles) {
		try {
			chunks.set(chunkPath, JSON.parse(await readFile(path.join(worldMapDirectory, chunkPath), 'utf8')) as WorldMapRuntimeNodeChunk)
		}
		catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			throw new Error(`Could not read world-map runtime chunk ${chunkPath}: ${message}`)
		}
	}
	validateWorldMapRuntime(manifest, chunks, options)
	return manifest
}
