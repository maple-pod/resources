import type { GameDataSource, WorldMapGraph, WorldMapIndex } from './schema'
import type { WorldMapSnapshotFingerprint } from './snapshot'
import { readFile, stat } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import path from 'pathe'
import { assertRunningInContainer } from '../assert-container'
import { validateWorldMapRuntimeOutputAgainstIndex } from './runtime'
import { fingerprintWorldMapGraph } from './snapshot'
import { gameDataSourceMatches } from './source'

export interface WorldMapArtifactComparison {
	left: { artifact: string, generatedAt: string, source: GameDataSource, fingerprint: WorldMapSnapshotFingerprint }
	right: { artifact: string, generatedAt: string, source: GameDataSource, fingerprint: WorldMapSnapshotFingerprint }
	sourceEqual: boolean
	facetsEqual: Record<keyof WorldMapSnapshotFingerprint, boolean>
	nodes: { added: string[], removed: string[], changed: string[] }
	links: { added: string[], removed: string[], changed: string[] }
	assets: { changed: string[] }
	worldMapNames: { changed: string[] }
	mapDetails: { changed: string[] }
}

function json(value: unknown): string {
	return JSON.stringify(value)
}

function nodeMap(graph: WorldMapGraph): Map<string, WorldMapGraph['nodes'][number]> {
	return new Map(graph.nodes.map(node => [node.worldMapId, node]))
}

function graphSource(graph: WorldMapGraph): GameDataSource {
	const source = graph.nodes[0]?.provenance
	if (source == null)
		throw new Error('World-map comparison requires both graphs to contain a node with provenance')
	return source
}

function sorted(values: Iterable<string>): string[] {
	return [...values].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
}

function changedKeys<T>(left: Map<string, T>, right: Map<string, T>): string[] {
	const keys = new Set([...left.keys(), ...right.keys()])
	return sorted([...keys].filter(key => json(left.get(key)) !== json(right.get(key))))
}

function linkMap(graph: WorldMapGraph): Map<string, unknown> {
	const result = new Map<string, unknown>()
	for (const node of graph.nodes) {
		for (const link of node.links)
			result.set(`${node.worldMapId}/${link.id}`, { target: link.targetWorldMapId, canonicalLabel: link.canonicalLabel, screenOrigin: link.screenOrigin, hitRect: link.hitRect })
	}
	return result
}

function assetMap(graph: WorldMapGraph): Map<string, unknown> {
	const result = new Map<string, unknown>()
	for (const node of graph.nodes) {
		for (const [index, asset] of node.baseImages.entries())
			result.set(`${node.worldMapId}/base-${index}`, { sha1: asset.sha1, width: asset.width, height: asset.height, origin: asset.origin })
		for (const link of node.links) {
			if (link.linkImage != null)
				result.set(`${node.worldMapId}/${link.id}`, { sha1: link.linkImage.sha1, width: link.linkImage.width, height: link.linkImage.height, origin: link.linkImage.origin })
		}
	}
	return result
}

function worldMapNameMap(graph: WorldMapGraph): Map<string, unknown> {
	const result = new Map<string, unknown>()
	for (const node of graph.nodes) {
		result.set(`${node.worldMapId}/node`, { worldMapName: node.worldMapName, canonicalLabel: node.canonicalLabel, canonicalLabelSource: node.canonicalLabelSource ?? null })
		for (const link of node.links)
			result.set(`${node.worldMapId}/${link.id}`, link.canonicalLabel)
	}
	return result
}

function mapDetailMap(graph: WorldMapGraph): Map<string, unknown> {
	const result = new Map<string, unknown>()
	for (const node of graph.nodes) {
		for (const spot of node.spots) {
			for (const map of spot.maps)
				result.set(`${node.worldMapId}/${map.mapId}`, { name: map.name, streetName: map.streetName, mapMark: map.mapMark, gameBgm: map.gameBgm == null ? null : { path: map.gameBgm.path, structure: map.gameBgm.structure, filename: map.gameBgm.filename } })
		}
	}
	return result
}

export function compareWorldMapGraphs(left: WorldMapGraph, right: WorldMapGraph, labels: { left: string, right: string } = { left: 'left', right: 'right' }): WorldMapArtifactComparison {
	const leftFingerprint = fingerprintWorldMapGraph(left)
	const rightFingerprint = fingerprintWorldMapGraph(right)
	const leftSource = graphSource(left)
	const rightSource = graphSource(right)
	const leftNodes = nodeMap(left)
	const rightNodes = nodeMap(right)
	const nodeIds = new Set([...leftNodes.keys(), ...rightNodes.keys()])
	const addedNodes = [...nodeIds].filter(id => !leftNodes.has(id) && rightNodes.has(id))
	const removedNodes = [...nodeIds].filter(id => leftNodes.has(id) && !rightNodes.has(id))
	const changedNodes = [...nodeIds].filter(id => leftNodes.has(id) && rightNodes.has(id) && json(leftNodes.get(id)) !== json(rightNodes.get(id)))
	const facetKeys = ['topology', 'geometry', 'assets', 'worldMapNames', 'mapDetails', 'combined'] as const
	return {
		left: { artifact: labels.left, generatedAt: '', source: leftSource, fingerprint: leftFingerprint },
		right: { artifact: labels.right, generatedAt: '', source: rightSource, fingerprint: rightFingerprint },
		sourceEqual: gameDataSourceMatches(leftSource, rightSource),
		facetsEqual: Object.fromEntries(facetKeys.map(key => [key, leftFingerprint[key] === rightFingerprint[key]])) as Record<keyof WorldMapSnapshotFingerprint, boolean>,
		nodes: { added: sorted(addedNodes), removed: sorted(removedNodes), changed: sorted(changedNodes) },
		links: {
			added: sorted([...linkMap(right)].filter(([key]) => !linkMap(left).has(key)).map(([key]) => key)),
			removed: sorted([...linkMap(left)].filter(([key]) => !linkMap(right).has(key)).map(([key]) => key)),
			changed: changedKeys(linkMap(left), linkMap(right)),
		},
		assets: { changed: changedKeys(assetMap(left), assetMap(right)) },
		worldMapNames: { changed: changedKeys(worldMapNameMap(left), worldMapNameMap(right)) },
		mapDetails: { changed: changedKeys(mapDetailMap(left), mapDetailMap(right)) },
	}
}

async function readArtifact(input: string): Promise<{ index: WorldMapIndex, directory: string }> {
	const resolved = path.resolve(input)
	const info = await stat(resolved)
	const directory = info.isDirectory() ? resolved : path.dirname(resolved)
	const file = info.isDirectory() ? path.join(resolved, 'world-maps.json') : resolved
	const index = JSON.parse(await readFile(file, 'utf8')) as WorldMapIndex
	if (index.graph == null)
		throw new Error(`Artifact has no canonical graph: ${file}`)
	return { index, directory }
}

export async function compareWorldMapArtifacts(leftInput: string, rightInput: string): Promise<WorldMapArtifactComparison> {
	const left = await readArtifact(leftInput)
	const right = await readArtifact(rightInput)
	const leftManifest = await validateWorldMapRuntimeOutputAgainstIndex(left.directory, left.index)
	const rightManifest = await validateWorldMapRuntimeOutputAgainstIndex(right.directory, right.index)
	const comparison = compareWorldMapGraphs(left.index.graph!, right.index.graph!, { left: path.resolve(leftInput), right: path.resolve(rightInput) })
	comparison.left.generatedAt = left.index.generatedAt
	comparison.right.generatedAt = right.index.generatedAt
	comparison.left.source = leftManifest.source
	comparison.right.source = rightManifest.source
	comparison.sourceEqual = gameDataSourceMatches(leftManifest.source, rightManifest.source)
	return comparison
}

function parseArgument(name: string): string {
	const value = process.argv.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3)
	if (value == null || value.length === 0)
		throw new Error(`Missing --${name}=...`)
	return value
}

if (process.argv[1] != null && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	assertRunningInContainer('pnpm run world-map:compare')
	compareWorldMapArtifacts(parseArgument('left'), parseArgument('right'))
		.then((comparison) => {
			if (process.argv.includes('--json')) {
				console.log(JSON.stringify(comparison, null, 2))
			}
			else {
				console.log(`Left: ${comparison.left.artifact}`)
				console.log(`Right: ${comparison.right.artifact}`)
				console.log(`Sources: ${comparison.sourceEqual ? 'equal' : 'different'}`)
				const facetParts = Object.entries(comparison.facetsEqual).map(([key, equal]) => `${key}=${equal ? 'equal' : 'different'}`)
				const facetSummary = facetParts.join(', ')
				console.log(`Facets: ${facetSummary}`)
				console.log(`Nodes: +${comparison.nodes.added.length} -${comparison.nodes.removed.length} changed=${comparison.nodes.changed.length}`)
				console.log(`Links: +${comparison.links.added.length} -${comparison.links.removed.length} changed=${comparison.links.changed.length}`)
				console.log(`Assets changed=${comparison.assets.changed.length}; names changed=${comparison.worldMapNames.changed.length}; map details changed=${comparison.mapDetails.changed.length}`)
			}
		})
		.catch((error) => {
			console.error(error instanceof Error ? error.message : String(error))
			process.exitCode = 1
		})
}
