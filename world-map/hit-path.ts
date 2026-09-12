import type { Buffer } from 'node:buffer'
import type { WorldMapHitPath, WorldMapOrigin } from './schema'
import sharp from 'sharp'

/**
 * Default alpha threshold for determining solid pixels in anti-aliased link images.
 * Pixels with alpha >= 32 are considered clickable/solid.
 * Threshold 32 suppresses isolated 1-2px anti-alias/glow noise on link images
 * while retaining principal silhouettes.
 */
export const DEFAULT_HIT_PATH_ALPHA_THRESHOLD = 32

export interface Point {
	x: number
	y: number
}

interface DirectedEdge {
	toX: number
	toY: number
	dir: number // 0: East (+x), 1: South (+y), 2: West (-x), 3: North (-y)
}

function simplifyCollinear(loop: readonly Point[]): Point[] {
	if (loop.length <= 2)
		return [...loop]
	const result: Point[] = []
	const n = loop.length
	for (let i = 0; i < n; i++) {
		const prev = loop[(i - 1 + n) % n]!
		const cur = loop[i]!
		const next = loop[(i + 1) % n]!
		if ((cur.x === prev.x && cur.x === next.x) || (cur.y === prev.y && cur.y === next.y))
			continue
		result.push(cur)
	}
	return result
}

/**
 * Fills enclosed transparent regions in the binary mask by flood-filling
 * transparent background from the image borders. Any remaining transparent
 * pixels not reachable from the exterior borders are interior holes and
 * are filled solid.
 */
function fillInteriorHoles(mask: Uint8Array, width: number, height: number): void {
	const exterior = new Uint8Array(width * height)
	const queue: number[] = []

	for (let x = 0; x < width; x++) {
		const topIdx = x
		if (mask[topIdx] === 0 && exterior[topIdx] === 0) {
			exterior[topIdx] = 1
			queue.push(x, 0)
		}
		const bottomIdx = (height - 1) * width + x
		if (mask[bottomIdx] === 0 && exterior[bottomIdx] === 0) {
			exterior[bottomIdx] = 1
			queue.push(x, height - 1)
		}
	}
	for (let y = 1; y < height - 1; y++) {
		const leftIdx = y * width
		if (mask[leftIdx] === 0 && exterior[leftIdx] === 0) {
			exterior[leftIdx] = 1
			queue.push(0, y)
		}
		const rightIdx = y * width + (width - 1)
		if (mask[rightIdx] === 0 && exterior[rightIdx] === 0) {
			exterior[rightIdx] = 1
			queue.push(width - 1, y)
		}
	}

	let head = 0
	while (head < queue.length) {
		const qx = queue[head++]!
		const qy = queue[head++]!

		const neighbors: [number, number][] = [
			[qx + 1, qy],
			[qx - 1, qy],
			[qx, qy + 1],
			[qx, qy - 1],
		]
		for (const [nx, ny] of neighbors) {
			if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
				const nidx = ny * width + nx
				if (mask[nidx] === 0 && exterior[nidx] === 0) {
					exterior[nidx] = 1
					queue.push(nx, ny)
				}
			}
		}
	}

	for (let i = 0; i < width * height; i++) {
		if (mask[i] === 0 && exterior[i] === 0)
			mask[i] = 1
	}
}

/**
 * Derives a deterministic SVG path from an alpha channel buffer.
 * Enclosed interior transparent holes are filled so that the entire internal
 * area of each silhouette is clickable.
 * Traces exterior pixel boundaries into closed loops.
 * Only actually closed loops are serialized.
 * Applies collinear simplification and screenOrigin translation.
 */
export function deriveHitPathFromAlpha(
	alpha: Uint8Array,
	width: number,
	height: number,
	screenOrigin: WorldMapOrigin,
	alphaThreshold = DEFAULT_HIT_PATH_ALPHA_THRESHOLD,
): WorldMapHitPath | null {
	if (width <= 0 || height <= 0 || alpha.length < width * height)
		return null

	const mask = new Uint8Array(width * height)
	let solidCount = 0
	for (let i = 0; i < width * height; i++) {
		if (alpha[i]! >= alphaThreshold) {
			mask[i] = 1
			solidCount++
		}
	}
	if (solidCount === 0)
		return null

	fillInteriorHoles(mask, width, height)

	const getPixel = (x: number, y: number): number => {
		if (x < 0 || x >= width || y < 0 || y >= height)
			return 0
		return mask[y * width + x]!
	}

	const edges = new Map<string, DirectedEdge[]>()
	for (let y = 0; y <= height; y++) {
		for (let x = 0; x <= width; x++) {
			if (x < width) {
				const top = getPixel(x, y - 1)
				const bottom = getPixel(x, y)
				if (top !== bottom) {
					if (bottom === 1) {
						const k = `${x},${y}`
						const list = edges.get(k) ?? []
						list.push({ toX: x + 1, toY: y, dir: 0 })
						edges.set(k, list)
					}
					else {
						const k = `${x + 1},${y}`
						const list = edges.get(k) ?? []
						list.push({ toX: x, toY: y, dir: 2 })
						edges.set(k, list)
					}
				}
			}
			if (y < height) {
				const left = getPixel(x - 1, y)
				const right = getPixel(x, y)
				if (left !== right) {
					if (right === 1) {
						const k = `${x},${y + 1}`
						const list = edges.get(k) ?? []
						list.push({ toX: x, toY: y, dir: 3 })
						edges.set(k, list)
					}
					else {
						const k = `${x},${y}`
						const list = edges.get(k) ?? []
						list.push({ toX: x, toY: y + 1, dir: 1 })
						edges.set(k, list)
					}
				}
			}
		}
	}

	const visited = new Set<string>()
	const loops: Point[][] = []

	for (let y = 0; y <= height; y++) {
		for (let x = 0; x <= width; x++) {
			const k = `${x},${y}`
			const outs = edges.get(k)
			if (outs == null)
				continue
			for (const edge of outs) {
				const edgeKey = `${x},${y}->${edge.toX},${edge.toY}`
				if (visited.has(edgeKey))
					continue
				const loop: Point[] = [{ x, y }]
				visited.add(edgeKey)
				let curX = edge.toX
				let curY = edge.toY
				let prevDir = edge.dir
				let isClosed = false
				while (true) {
					if (curX === x && curY === y) {
						isClosed = true
						break
					}
					loop.push({ x: curX, y: curY })
					const curK = `${curX},${curY}`
					const curOuts = edges.get(curK)
					if (curOuts == null || curOuts.length === 0)
						break
					let bestEdge: DirectedEdge | null = null
					let bestScore = -1
					for (const cand of curOuts) {
						const candKey = `${curX},${curY}->${cand.toX},${cand.toY}`
						if (visited.has(candKey))
							continue
						const turn = (cand.dir - prevDir + 4) % 4
						const score = turn === 1 ? 3 : (turn === 0 ? 2 : (turn === 3 ? 1 : 0))
						if (score > bestScore) {
							bestScore = score
							bestEdge = cand
						}
					}
					if (bestEdge == null)
						break
					visited.add(`${curX},${curY}->${bestEdge.toX},${bestEdge.toY}`)
					prevDir = bestEdge.dir
					curX = bestEdge.toX
					curY = bestEdge.toY
				}
				// Serialize only actually closed traced loops
				if (isClosed && loop.length >= 3)
					loops.push(loop)
			}
		}
	}

	const simplifiedLoops = loops
		.map(simplifyCollinear)
		.filter(loop => loop.length >= 3)

	if (simplifiedLoops.length === 0)
		return null

	const formattedSubpaths = simplifiedLoops.map((loop) => {
		const points = loop.map(p => `${p.x + screenOrigin.x} ${p.y + screenOrigin.y}`)
		return `M ${points[0]} L ${points.slice(1).join(' L ')} Z`
	})

	return {
		d: formattedSubpaths.join(' '),
		fillRule: 'evenodd',
	}
}

/**
 * Derives a deterministic SVG path from a published PNG image buffer.
 * Reads the alpha channel robustly using the actual channel count from sharp.
 */
export async function deriveHitPathFromPng(
	imageBytes: Buffer,
	screenOrigin: WorldMapOrigin,
	alphaThreshold = DEFAULT_HIT_PATH_ALPHA_THRESHOLD,
): Promise<WorldMapHitPath | null> {
	const { data, info } = await sharp(imageBytes)
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true })

	const channels = info.channels
	const alphaChannelOffset = channels - 1
	const pixelCount = info.width * info.height
	const alpha = new Uint8Array(pixelCount)
	for (let i = 0; i < pixelCount; i++) {
		alpha[i] = data[i * channels + alphaChannelOffset]!
	}
	return deriveHitPathFromAlpha(alpha, info.width, info.height, screenOrigin, alphaThreshold)
}

/**
 * Validates whether a value is a valid SVG path 'd' string formatted by deriveHitPathFromAlpha.
 */
export function isValidSvgHitPathString(value: unknown): value is string {
	if (typeof value !== 'string' || value.trim() === '')
		return false
	const tokens = value.trim().split(/\s+/)
	let i = 0
	let subpathCount = 0
	while (i < tokens.length) {
		if (tokens[i] !== 'M')
			return false
		i++
		if (i >= tokens.length || !Number.isFinite(Number(tokens[i])))
			return false
		i++
		if (i >= tokens.length || !Number.isFinite(Number(tokens[i])))
			return false
		i++
		let pointsInSubpath = 1
		while (i < tokens.length && tokens[i] === 'L') {
			i++
			if (i >= tokens.length || !Number.isFinite(Number(tokens[i])))
				return false
			i++
			if (i >= tokens.length || !Number.isFinite(Number(tokens[i])))
				return false
			i++
			pointsInSubpath++
		}
		if (i >= tokens.length || tokens[i] !== 'Z')
			return false
		i++
		if (pointsInSubpath < 3)
			return false
		subpathCount++
	}
	return subpathCount > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validates whether a value is a valid WorldMapHitPath object.
 */
export function isValidWorldMapHitPath(value: unknown): value is WorldMapHitPath {
	if (!isRecord(value))
		return false
	if (value.fillRule !== 'evenodd')
		return false
	return isValidSvgHitPathString(value.d)
}

/**
 * Semantic point-in-path tester using evenodd winding rule.
 * Useful for non-brittle tests.
 */
export function isPointInEvenOddPath(point: Point, pathString: string): boolean {
	const tokens = pathString.trim().split(/\s+/)
	const polygons: Point[][] = []
	let i = 0
	while (i < tokens.length) {
		if (tokens[i] !== 'M')
			break
		i++
		const poly: Point[] = []
		poly.push({ x: Number(tokens[i]), y: Number(tokens[i + 1]) })
		i += 2
		while (i < tokens.length && tokens[i] === 'L') {
			i++
			poly.push({ x: Number(tokens[i]), y: Number(tokens[i + 1]) })
			i += 2
		}
		if (tokens[i] === 'Z')
			i++
		if (poly.length >= 3)
			polygons.push(poly)
	}

	let crossings = 0
	for (const poly of polygons) {
		const n = poly.length
		for (let j = 0; j < n; j++) {
			const a = poly[j]!
			const b = poly[(j + 1) % n]!
			if ((a.y <= point.y && b.y > point.y) || (b.y <= point.y && a.y > point.y)) {
				const intersectX = a.x + ((point.y - a.y) * (b.x - a.x)) / (b.y - a.y)
				if (intersectX > point.x)
					crossings++
			}
		}
	}
	return crossings % 2 === 1
}
