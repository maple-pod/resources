import type { MapleBgmCatalogItem } from './source'

export interface ParsedGameBgmPath {
	path: string
	structure: string
	filename: string
}

export interface CatalogIndex {
	/** Raw occurrences are retained so duplicate catalog keys remain ambiguous. */
	byWikiKey: ReadonlyMap<string, readonly string[]>
	byGamePath: ReadonlyMap<string, readonly string[]>
	trackIds: ReadonlySet<string>
	duplicateWikiKeys: readonly string[]
	duplicateGamePaths: readonly string[]
}

function trackId(item: MapleBgmCatalogItem): string | null {
	const value = item.filename ?? item.id
	return value == null || value.trim() === '' ? null : value
}

function pathParts(item: MapleBgmCatalogItem): { structure: string, filename: string } | null {
	const structure = item.source?.structure
	const filename = item.filename ?? item.source?.filename
	return structure == null || structure === '' || filename == null || filename === ''
		? null
		: { structure, filename }
}

function pathKey(structure: string, filename: string): string {
	return `${structure}\u0000${filename}`
}

/**
 * Accept only a native two-segment BGM path. In particular, do not decode,
 * split on the last slash, or repair malformed values because that can turn a
 * catalog miss into a false canonical selection.
 */
export function parseGameBgmPath(value: string): ParsedGameBgmPath | null {
	const path = value.trim()
	const match = /^([^/]+)\/([^/]+)$/.exec(path)
	if (match == null || match[1]!.trim() !== match[1] || match[2]!.trim() !== match[2])
		return null
	return { path, structure: match[1]!, filename: match[2]! }
}

export function buildCatalogIndex(catalog: readonly MapleBgmCatalogItem[]): CatalogIndex {
	const byWikiKey = new Map<string, string[]>()
	const byGamePath = new Map<string, string[]>()
	const trackIds = new Set<string>()
	for (const item of catalog) {
		const id = trackId(item)
		if (id == null)
			continue
		trackIds.add(id)
		byWikiKey.set(id, [...(byWikiKey.get(id) ?? []), id])
		const parts = pathParts(item)
		if (parts != null) {
			const key = pathKey(parts.structure, parts.filename)
			byGamePath.set(key, [...(byGamePath.get(key) ?? []), id])
		}
	}
	return {
		byWikiKey,
		byGamePath,
		trackIds,
		duplicateWikiKeys: [...byWikiKey].filter(([, ids]) => ids.length !== 1).map(([key]) => key),
		duplicateGamePaths: [...byGamePath].filter(([, ids]) => ids.length !== 1).map(([key]) => key),
	}
}

export function uniqueCatalogMatch(values: readonly string[] | undefined): string | null {
	return values?.length === 1 ? values[0]! : null
}

export function gameBgmCatalogMatch(index: CatalogIndex, parsed: ParsedGameBgmPath): string | null {
	return uniqueCatalogMatch(index.byGamePath.get(pathKey(parsed.structure, parsed.filename)))
}
