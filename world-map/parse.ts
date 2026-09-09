import type { ParsedWorldMapPoint, WikiPage, WikiRevision } from './source'

export function getRevision(page: WikiPage, context: string): WikiRevision {
	const revision = page.revisions?.[0]
	if (revision == null)
		throw new Error(`Missing revision content for ${context}`)
	return revision
}

export function parseBaseImage(wikitext: string): string {
	const match = wikitext.match(/<div\s+style="[^"]*position\s*:\s*relative[^"]*"[^>]*>[\s\S]*?\[\[File:([^\]|]+)/i)
	if (match?.[1] == null)
		throw new Error('Could not locate world-map base image')
	return match[1].trim()
}

export function parsePoints(wikitext: string): ParsedWorldMapPoint[] {
	const result: ParsedWorldMapPoint[] = []
	const divPattern = /<div\s+style="([^"]*position\s*:\s*absolute[^"]*)"[^>]*>([\s\S]*?)<\/div>/gi
	for (const match of wikitext.matchAll(divPattern)) {
		const style = match[1] ?? ''
		const body = match[2] ?? ''
		const left = style.match(/(?:^|;)\s*left\s*:\s*(-?\d+(?:\.\d+)?)px/i)?.[1]
		const top = style.match(/(?:^|;)\s*top\s*:\s*(-?\d+(?:\.\d+)?)px/i)?.[1]
		const file = body.match(/\[\[File:([^\]|]+)/i)?.[1]
		const target = body.match(/\|link=([^\]|]+)/i)?.[1]
		if (left == null || top == null || file == null || target == null || target.trim() === '')
			continue
		const label = body.match(/\|link=[^\]|]+\|([^\]]+)\]\]/i)?.[1]?.trim()
		result.push({
			left: Number.parseFloat(left),
			top: Number.parseFloat(top),
			markerFile: file.trim(),
			target: target.trim(),
			label: label || target.trim().split('#', 1)[0]!,
		})
	}
	if (result.length === 0)
		throw new Error('Could not locate any linked world-map positions')
	return result
}

export function extractMapId(wikitext: string): string | null {
	return wikitext.match(/\{\{Map<!--(\d+)-->/i)?.[1] ?? null
}

/** Uses Wiki's MapIcon filename only as an external search hint. */
export function extractMapIconToken(wikitext: string): string | null {
	const file = wikitext.match(/\[\[File:MapIcon[ \t]([^|\]]+)(?:\|[^\]]*)?\]\]/i)?.[1]?.trim().replace(/\.png$/i, '')
	return file == null || file === '' ? null : file
}

export function extractBgmKeys(wikitext: string): string[] {
	const raw = wikitext.match(/^\s*\|bgm\s*=\s*([^\n\r}]*)/im)?.[1]?.trim()
	if (!raw)
		return []
	return [...new Set(raw
		.split(/<br\s*\/?>\s*|\s*,\s*/i)
		.map(value => value
			.replace(/^\[\[(?:File:)?/i, '')
			.replace(/\]\]$/, '')
			.replace(/\.ogg$/i, '')
			.trim())
		.filter(Boolean))]
}

export const parseBgmKeys = extractBgmKeys

export function normalizeWikiTitle(title: string): string {
	return title.replaceAll('_', ' ').trim()
}
