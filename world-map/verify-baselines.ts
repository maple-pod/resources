import type { MapleStoryIoClient } from './acquire'
import type { WorldMapGraph, WorldMapIndex } from './schema'
import type { WorldMapSnapshotId } from './snapshot'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import path from 'pathe'
import { assertRunningInContainer } from '../assert-container'
import { BGM_DB_URL, MapleStoryIoClient as DefaultMapleStoryIoClient } from './acquire'
import { runWorldMapGeneration, validatePublishedSnapshotSource } from './generate'
import { validateWorldMapRuntimeOutputAgainstIndex } from './runtime'
import { fingerprintWorldMapGraph, parseWorldMapSnapshotId } from './snapshot'
import { gameDataSourceMatches } from './source'
import { validateWorldMapIndex } from './validate'

export const PUBLIC_BASELINE_SNAPSHOT_IDS = [
	'GMS/93',
	'GMS/137',
	'GMS/179',
	'GMS/246',
	'GMS/270',
	'TWMS/124',
	'TWMS/158',
	'TWMS/171',
	'TWMS/209',
	'TWMS/217',
	'TWMS/236',
	'TWMS/253',
	'TWMS/256',
] as const satisfies readonly WorldMapSnapshotId[]

// Bump when verification semantics change; old success records must not be
// trusted after completeness or artifact-validation rules change.
export const BASELINE_VERIFIER_SCHEMA_VERSION = 16 as const
export const DEFAULT_BASELINE_VERIFIER_CONCURRENCY = 2
const MAX_BASELINE_VERIFIER_CONCURRENCY = 3

export interface BaselineLabelSourceMetrics {
	stringWz: number
	inboundTooltip: number
	nullCount: number
}

export interface BaselineSnapshotMetric {
	verifierSchemaVersion: typeof BASELINE_VERIFIER_SCHEMA_VERSION
	id: WorldMapSnapshotId
	status: 'running' | 'success' | 'failed'
	startedAt: string
	finishedAt?: string
	elapsedMs?: number
	runDirectory: string
	roots?: string[]
	nodeCount?: number
	hotspotCount?: number
	labelSources?: BaselineLabelSourceMetrics
	warnings?: string[]
	fingerprint?: {
		topology: string
		geometry: string
		assets: string
		worldMapNames: string
		mapDetails: string
		combined: string
	}
	selectable?: boolean
	error?: string
}

export interface BaselineVerifierCheckpoint {
	verifierSchemaVersion: typeof BASELINE_VERIFIER_SCHEMA_VERSION
	updatedAt: string
	concurrency: number
	metrics: Partial<Record<WorldMapSnapshotId, BaselineSnapshotMetric>>
}

export interface BaselineVerifierOptions {
	outputRoot?: string
	catalogSource?: string
	concurrency?: number
	snapshots?: readonly WorldMapSnapshotId[]
	clientFactory?: () => MapleStoryIoClient
	now?: () => number
}

export function parseBaselineVerifierConcurrency(value: string | undefined): number {
	if (value == null || value.trim() === '')
		return DEFAULT_BASELINE_VERIFIER_CONCURRENCY
	if (!/^\d+$/u.test(value))
		throw new Error(`Invalid baseline verifier concurrency: ${value}`)
	const concurrency = Number(value)
	if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_BASELINE_VERIFIER_CONCURRENCY)
		throw new Error(`Baseline verifier concurrency must be an integer from 1 to ${MAX_BASELINE_VERIFIER_CONCURRENCY}`)
	return concurrency
}

export function summarizeBaselineGraph(graph: WorldMapGraph): Pick<BaselineSnapshotMetric, 'roots' | 'nodeCount' | 'hotspotCount' | 'labelSources'> {
	let hotspotCount = 0
	let stringWz = 0
	let inboundTooltip = 0
	let nullCount = 0
	for (const node of graph.nodes) {
		hotspotCount += node.spots.length
		if (node.canonicalLabelSource === 'string-wz')
			stringWz++
		else if (node.canonicalLabelSource === 'inbound-link-tooltip')
			inboundTooltip++
		else
			nullCount++
	}
	return {
		roots: [...graph.roots],
		nodeCount: graph.nodes.length,
		hotspotCount,
		labelSources: { stringWz, inboundTooltip, nullCount },
	}
}

function nowIso(now: () => number): string {
	return new Date(now()).toISOString()
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
	return value != null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: null
}

async function readCheckpoint(file: string, concurrency: number, now: () => number): Promise<BaselineVerifierCheckpoint> {
	try {
		const parsed = parseJsonRecord(JSON.parse(await readFile(file, 'utf8')))
		if (parsed?.verifierSchemaVersion === BASELINE_VERIFIER_SCHEMA_VERSION && parsed.metrics != null && typeof parsed.metrics === 'object' && !Array.isArray(parsed.metrics)) {
			return {
				verifierSchemaVersion: BASELINE_VERIFIER_SCHEMA_VERSION,
				updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : nowIso(now),
				concurrency: typeof parsed.concurrency === 'number' ? parsed.concurrency : concurrency,
				metrics: parsed.metrics as BaselineVerifierCheckpoint['metrics'],
			}
		}
	}
	catch {
		// A missing or malformed checkpoint is treated as an empty resumable run.
	}
	return {
		verifierSchemaVersion: BASELINE_VERIFIER_SCHEMA_VERSION,
		updatedAt: nowIso(now),
		concurrency,
		metrics: {},
	}
}

async function hasCompatibleCheckpoint(file: string): Promise<boolean> {
	try {
		const parsed = parseJsonRecord(JSON.parse(await readFile(file, 'utf8')))
		return parsed?.verifierSchemaVersion === BASELINE_VERIFIER_SCHEMA_VERSION
	}
	catch {
		return false
	}
}

async function writeJsonAtomically(file: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true })
	const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
	await rename(temporary, file)
}

function fingerprintMatches(actual: ReturnType<typeof fingerprintWorldMapGraph>, expected: unknown): boolean {
	return JSON.stringify(actual) === JSON.stringify(expected)
}

function snapshotReferencedBgmIds(index: WorldMapIndex): Set<string> {
	const ids = new Set<string>()
	const add = (value: string | null | undefined) => {
		if (value != null)
			ids.add(value)
	}
	for (const node of index.graph?.nodes ?? []) {
		for (const spot of node.spots) {
			for (const map of spot.maps) {
				add(map.gameBgm?.trackId)
				add(map.selection.trackId)
			}
		}
	}
	return ids
}

export async function hasResumableSuccess(metric: BaselineSnapshotMetric | undefined): Promise<boolean> {
	if (metric?.verifierSchemaVersion !== BASELINE_VERIFIER_SCHEMA_VERSION || metric.status !== 'success' || metric.selectable !== true || metric.fingerprint == null)
		return false
	try {
		if (!(await stat(metric.runDirectory)).isDirectory())
			return false
		const snapshot = parseWorldMapSnapshotId(metric.id)
		const snapshotDirectory = path.join(metric.runDirectory, 'world-map', 'snapshots', snapshot.region, snapshot.version)
		const canonical = JSON.parse(await readFile(path.join(snapshotDirectory, 'world-maps.json'), 'utf8')) as WorldMapIndex
		if (canonical.graph == null)
			return false
		const manifest = await validateWorldMapRuntimeOutputAgainstIndex(snapshotDirectory, canonical, { bgmIds: snapshotReferencedBgmIds(canonical) })
		validatePublishedSnapshotSource(metric.id, manifest.source)
		const firstSource = canonical.graph.nodes[0]?.provenance
		if (firstSource == null || !gameDataSourceMatches(firstSource, manifest.source) || !canonical.graph.nodes.every(node => gameDataSourceMatches(node.provenance, manifest.source)))
			return false
		await validateWorldMapIndex(canonical, {
			assetRoot: metric.runDirectory,
			bgmIds: snapshotReferencedBgmIds(canonical),
			requireGraph: true,
			canonicalSourceRegion: firstSource.region,
		})
		const catalog = JSON.parse(await readFile(path.join(metric.runDirectory, 'world-map', 'catalog.json'), 'utf8')) as { entries?: Array<{ id: string, selectable: boolean, fingerprint: unknown }> }
		const entry = catalog.entries?.find(candidate => candidate.id === metric.id)
		if (entry?.selectable !== true || entry.fingerprint == null)
			return false
		const actual = fingerprintWorldMapGraph(canonical.graph)
		return fingerprintMatches(actual, entry.fingerprint) && fingerprintMatches(actual, metric.fingerprint)
	}
	catch {
		return false
	}
}

async function defaultCatalogSource(): Promise<string> {
	const local = path.resolve('output/data.json')
	try {
		if ((await stat(local)).isFile())
			return local
	}
	catch {
		// Fall back to the published catalog below.
	}
	return BGM_DB_URL
}

async function verifySnapshot(
	id: WorldMapSnapshotId,
	options: Required<Pick<BaselineVerifierOptions, 'outputRoot' | 'catalogSource' | 'clientFactory' | 'now'>>,
	checkpoint: BaselineVerifierCheckpoint,
	resultDirectory: string,
	persistCheckpoint: () => Promise<void>,
): Promise<void> {
	const parsed = parseWorldMapSnapshotId(id)
	const startedAtMs = options.now()
	const startedAt = nowIso(options.now)
	const runDirectory = path.join(options.outputRoot, 'runs', parsed.region, parsed.version)
	const running: BaselineSnapshotMetric = {
		verifierSchemaVersion: BASELINE_VERIFIER_SCHEMA_VERSION,
		id,
		status: 'running',
		startedAt,
		runDirectory,
	}
	checkpoint.metrics[id] = running
	await persistCheckpoint()
	await writeJsonAtomically(path.join(resultDirectory, `${parsed.region}-${parsed.version}.json`), running)
	await rm(runDirectory, { recursive: true, force: true })
	try {
		console.log(`Starting full public baseline verification for ${id}...`)
		const result = await runWorldMapGeneration({
			mode: 'full',
			snapshot: parsed,
			outputDir: runDirectory,
			catalogSource: options.catalogSource,
			sources: [],
			localizations: [],
			gameClient: options.clientFactory(),
			rawWzAudit: true,
		})
		const snapshotDirectory = path.join(runDirectory, 'world-map', 'snapshots', parsed.region, parsed.version)
		const canonical = JSON.parse(await readFile(path.join(snapshotDirectory, 'world-maps.json'), 'utf8')) as WorldMapIndex
		if (canonical.graph == null)
			throw new Error('canonical graph is missing')
		await validateWorldMapRuntimeOutputAgainstIndex(snapshotDirectory, canonical, { bgmIds: snapshotReferencedBgmIds(canonical) })
		const catalog = JSON.parse(await readFile(path.join(runDirectory, 'world-map', 'catalog.json'), 'utf8')) as { entries?: Array<{ id: string, selectable: boolean, fingerprint: unknown }> }
		const entry = catalog.entries?.find(candidate => candidate.id === id)
		if (entry?.selectable !== true || entry.fingerprint == null)
			throw new Error('full artifact was not marked selectable with a fingerprint')
		const fingerprint = fingerprintWorldMapGraph(canonical.graph)
		if (!fingerprintMatches(fingerprint, entry.fingerprint))
			throw new Error('catalog fingerprint does not match canonical graph')
		const finishedAt = nowIso(options.now)
		const metric: BaselineSnapshotMetric = {
			...running,
			...summarizeBaselineGraph(canonical.graph),
			status: 'success',
			finishedAt,
			elapsedMs: options.now() - startedAtMs,
			warnings: result.warnings,
			fingerprint,
			selectable: true,
		}
		checkpoint.metrics[id] = metric
		await writeJsonAtomically(path.join(resultDirectory, `${parsed.region}-${parsed.version}.json`), metric)
		await persistCheckpoint()
		console.log(`Completed ${id}: ${metric.nodeCount} nodes, ${metric.hotspotCount} hotspots, ${metric.elapsedMs}ms, fingerprint ${fingerprint.combined}`)
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		const metric: BaselineSnapshotMetric = {
			...running,
			status: 'failed',
			finishedAt: nowIso(options.now),
			elapsedMs: options.now() - startedAtMs,
			error: message,
			selectable: false,
		}
		checkpoint.metrics[id] = metric
		await writeJsonAtomically(path.join(resultDirectory, `${parsed.region}-${parsed.version}.json`), metric)
		await persistCheckpoint()
		console.error(`Failed ${id} after ${metric.elapsedMs}ms: ${message}`)
	}
}

export async function runPublicBaselineVerification(options: BaselineVerifierOptions = {}): Promise<BaselineVerifierCheckpoint> {
	const outputRoot = path.resolve(options.outputRoot ?? 'output/world-map-baseline-verification')
	const catalogSource = options.catalogSource ?? await defaultCatalogSource()
	const concurrency = options.concurrency ?? DEFAULT_BASELINE_VERIFIER_CONCURRENCY
	parseBaselineVerifierConcurrency(String(concurrency))
	const snapshots = options.snapshots ?? PUBLIC_BASELINE_SNAPSHOT_IDS
	const now = options.now ?? Date.now
	const clientFactory = options.clientFactory ?? (() => new DefaultMapleStoryIoClient({
		// Two clients at the default one-second delay materially shortens the
		// matrix while keeping aggregate request pressure bounded.
		delayMs: 1000,
		timeoutMs: 15000,
		maxRetries: 2,
		rawAuditCacheDir: path.resolve('.cache/world-map/maplestory-io-raw-audit'),
		normalizedResponseCacheDir: path.resolve('.cache/world-map/maplestory-io-normalized'),
	}))
	const checkpointFile = path.join(outputRoot, 'checkpoint.json')
	const resultDirectory = path.join(outputRoot, 'results')
	if (!(await hasCompatibleCheckpoint(checkpointFile)))
		console.warn('Ignoring incompatible baseline verifier checkpoint; preserving existing checkpoint/results as diagnostic evidence.')
	const checkpoint = await readCheckpoint(checkpointFile, concurrency, now)
	checkpoint.concurrency = concurrency
	let checkpointWrite = Promise.resolve()
	const persistCheckpoint = () => {
		const snapshot = structuredClone({ ...checkpoint, updatedAt: nowIso(now) })
		checkpointWrite = checkpointWrite.then(() => writeJsonAtomically(checkpointFile, snapshot))
		return checkpointWrite
	}
	await persistCheckpoint()

	const pending: WorldMapSnapshotId[] = []
	for (const id of snapshots) {
		if (await hasResumableSuccess(checkpoint.metrics[id])) {
			console.log(`Skipping already verified ${id}`)
			continue
		}
		pending.push(id)
	}
	let next = 0
	async function worker(): Promise<void> {
		while (next < pending.length) {
			const id = pending[next++]!
			await verifySnapshot(id, { outputRoot, catalogSource, clientFactory, now }, checkpoint, resultDirectory, persistCheckpoint)
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, pending.length)) }, () => worker()))
	await checkpointWrite
	return checkpoint
}

function parseCliConcurrency(argv: readonly string[]): number {
	const value = argv.find(argument => argument.startsWith('--concurrency='))?.slice('--concurrency='.length)
	return parseBaselineVerifierConcurrency(value)
}

if (process.argv[1] != null && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	assertRunningInContainer('pnpm run world-map:verify-baselines')
	runPublicBaselineVerification({ concurrency: parseCliConcurrency(process.argv.slice(2)) })
		.then((checkpoint) => {
			const metrics = Object.values(checkpoint.metrics)
			const successful = metrics.filter(metric => metric?.status === 'success').length
			const failed = metrics.filter(metric => metric?.status === 'failed').length
			console.log(`Baseline verification complete: ${successful} successful, ${failed} failed; checkpoint updated at ${checkpoint.updatedAt}`)
			if (failed > 0)
				process.exitCode = 1
		})
		.catch((error) => {
			console.error('Fatal baseline verifier error:', error instanceof Error ? error.message : String(error))
			process.exitCode = 1
		})
}
