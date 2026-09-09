import type { MapleStoryIoClient } from './acquire'
import type { AcquiredWorldMapSource, GameDataSnapshot, GameMapDetail, GameMapSearchCandidate } from './source'
import { extractMapIconToken, extractMapId, normalizeWikiTitle } from './parse'
import { CANONICAL_GAME_REGION } from './source'

export const MAX_REGION_MAP_SEARCHES = 4
export const MAX_MAP_SEARCH_RESULTS = 50

export interface CanonicalMapDetailEnrichmentResult {
	gameData: GameDataSnapshot
	warnings: string[]
}

function normalizedLabel(value: string): string {
	return value.normalize('NFKC')
		.trim()
		.toLocaleLowerCase()
		.replace(/\s+/gu, ' ')
}

function labelsMatch(left: string, right: string): boolean {
	return normalizedLabel(left) === normalizedLabel(right)
}

function pageFor(source: AcquiredWorldMapSource, title: string) {
	return source.targetPages.get(normalizeWikiTitle(title).toLowerCase())
}

function hasExactMapMarkEvidence(gameData: GameDataSnapshot, title: string): boolean {
	const marks = new Set(gameData.maps
		.filter(map => [map.name, map.streetName, map.mapMark].some(value => value != null && labelsMatch(value, title)))
		.map(map => map.mapMark)
		.filter((mark): mark is string => mark != null && mark.trim() !== ''))
	return marks.size === 1
}

function topologyMapIds(gameData: GameDataSnapshot): Set<string> {
	return new Set(gameData.worldMaps.flatMap(worldMap => worldMap.mapNumbers))
}

function exactCandidate(candidate: GameMapSearchCandidate, title: string): boolean {
	return [candidate.name, candidate.streetName].some(value => value != null && labelsMatch(value, title))
}

function exactDetail(detail: GameMapDetail, title: string): boolean {
	return [detail.name, detail.streetName].some(value => value != null && labelsMatch(value, title))
}

function replaceMapDetail(gameData: GameDataSnapshot, detail: GameMapDetail): GameDataSnapshot {
	const existing = gameData.maps.filter(map => map.id === detail.id)
	if (existing.length > 1)
		throw new Error(`GMS snapshot already has conflicting map details for ${detail.id}`)
	return {
		...gameData,
		maps: existing.length === 1
			? gameData.maps.map(map => map.id === detail.id ? detail : map)
			: [...gameData.maps, detail],
	}
}

function regionHints(source: AcquiredWorldMapSource, gameData: GameDataSnapshot): Array<{ title: string, token: string }> {
	const hints = new Map<string, Set<string>>()
	for (const point of source.points) {
		const title = normalizeWikiTitle(point.target.split('#', 1)[0]!)
		const page = pageFor(source, title)
		if (page == null || page.missing || extractMapId(page.revisions?.[0]?.content ?? '') != null || hasExactMapMarkEvidence(gameData, title))
			continue
		const token = extractMapIconToken(page.revisions?.[0]?.content ?? '')
		if (token == null)
			continue
		const tokens = hints.get(title) ?? new Set<string>()
		tokens.add(token)
		hints.set(title, tokens)
	}
	return [...hints]
		.filter(([, tokens]) => tokens.size === 1)
		.map(([title, tokens]) => ({ title, token: [...tokens][0]! }))
}

/**
 * Uses Wiki MapIcon names only to query GMS search. The returned map detail is
 * accepted only after topology intersection plus exact name/streetName evidence.
 */
export async function enrichCanonicalMapDetails(
	client: MapleStoryIoClient,
	source: AcquiredWorldMapSource,
): Promise<CanonicalMapDetailEnrichmentResult> {
	if (source.gameData == null)
		throw new Error(`Missing required game-data snapshot for world "${source.config.id}"`)
	if (source.gameData.region !== CANONICAL_GAME_REGION)
		throw new Error(`Canonical map-detail enrichment requires GMS data for ${source.config.id}`)

	let gameData = source.gameData
	const warnings: string[] = []
	const topologyIds = topologyMapIds(gameData)
	const hints = regionHints(source, gameData)
	const searchCache = new Map<string, GameMapSearchCandidate[]>()
	for (const [index, hint] of hints.entries()) {
		if (index >= MAX_REGION_MAP_SEARCHES) {
			warnings.push(`${source.config.id}: skipped map search for ${hint.title}; search budget exceeded`)
			continue
		}
		let candidates: GameMapSearchCandidate[]
		try {
			candidates = searchCache.get(hint.token) ?? await client.searchMaps(CANONICAL_GAME_REGION, gameData.version, hint.token)
			searchCache.set(hint.token, candidates)
		}
		catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			warnings.push(`${source.config.id}: GMS map search failed for ${hint.title}/${hint.token}: ${message}`)
			continue
		}
		if (candidates.length === 0) {
			warnings.push(`${source.config.id}: GMS map search returned no candidates for ${hint.title}/${hint.token}`)
			continue
		}
		if (candidates.length > MAX_MAP_SEARCH_RESULTS) {
			warnings.push(`${source.config.id}: GMS map search returned too many candidates for ${hint.title}/${hint.token}`)
			continue
		}
		const candidateById = new Map<string, GameMapSearchCandidate>()
		let duplicateCandidate = false
		for (const candidate of candidates) {
			if (candidateById.has(candidate.id))
				duplicateCandidate = true
			candidateById.set(candidate.id, candidate)
		}
		const intersections = [...candidateById.values()].filter(candidate => topologyIds.has(candidate.id))
		if (duplicateCandidate || intersections.length !== 1) {
			warnings.push(`${source.config.id}: GMS map search for ${hint.title} has ${intersections.length} topology intersections`)
			continue
		}
		const candidate = intersections[0]!
		if (!exactCandidate(candidate, hint.title)) {
			warnings.push(`${source.config.id}: GMS map search candidate ${candidate.id} lacks exact name/streetName evidence for ${hint.title}`)
			continue
		}
		let detail: GameMapDetail
		try {
			detail = await client.fetchMap(CANONICAL_GAME_REGION, gameData.version, candidate.id)
		}
		catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			warnings.push(`${source.config.id}: GMS map detail fetch failed for ${hint.title}/${candidate.id}: ${message}`)
			continue
		}
		if (!exactDetail(detail, hint.title) || detail.mapMark == null || detail.mapMark.trim() === '') {
			warnings.push(`${source.config.id}: GMS map detail ${candidate.id} lacks exact region evidence or mapMark for ${hint.title}`)
			continue
		}
		try {
			gameData = replaceMapDetail(gameData, detail)
		}
		catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			warnings.push(`${source.config.id}: ignored conflicting GMS map detail ${candidate.id} for ${hint.title}: ${message}`)
		}
	}
	return { gameData, warnings }
}
