import type { WzImageProperty, WzVectorProperty } from 'libwz'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { init as initWz, MapleVersion, PropertyType, WzFile, WzImage } from 'libwz'
import path from 'pathe'

/**
 * A deliberately small representation of a parsed .img property tree. Canvas
 * bytes are not decoded here: the MapleStory.IO raw leaf remains the exact
 * Canvas/hash authority because libwz 0.1.1 can fail PNG inflate on old GMS
 * images.
 */
export interface RawWzImageNode {
	type: number
	value?: unknown
	children: Record<string, RawWzImageNode>
}

export type RawWzImageParser = (bytes: Uint8Array, imageName: string, expectedRootNames: readonly string[]) => Promise<RawWzImageNode>

const RAW_CANVAS_TYPE = 12
const CANDIDATE_MAPLE_VERSIONS = [
	MapleVersion.BMS,
	MapleVersion.CLASSIC,
	MapleVersion.GMS,
	MapleVersion.EMS,
] as const

function propertyValue(property: WzImageProperty): unknown {
	switch (property.getPropertyType()) {
		case PropertyType.SHORT:
		case PropertyType.INT:
			return property.getInt()
		case PropertyType.LONG: {
			const value = property.getLong()
			return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
		}
		case PropertyType.FLOAT:
			return property.getFloat()
		case PropertyType.DOUBLE:
			return property.getDouble()
		case PropertyType.STRING:
			return property.getString()
		case PropertyType.VECTOR: {
			const vector = property as WzVectorProperty
			return { x: vector.getX(), y: vector.getY(), isEmpty: false }
		}
		case PropertyType.CANVAS:
			// Keep the raw API's Canvas discriminator without touching PNG data.
			return '__bulk-canvas__'
		default:
			return undefined
	}
}

function convertProperty(property: WzImageProperty): RawWzImageNode {
	const type = property.getPropertyType() === PropertyType.CANVAS ? RAW_CANVAS_TYPE : property.getPropertyType()
	const children: Record<string, RawWzImageNode> = {}
	for (const child of property.wzProperties())
		children[child.getName()] = convertProperty(child)
	const value = propertyValue(property)
	return value === undefined ? { type, children } : { type, value, children }
}

function convertImage(image: WzImage, expectedRootNames: readonly string[]): RawWzImageNode {
	const children: Record<string, RawWzImageNode> = {}
	for (const property of image.wzProperties())
		children[property.getName()] = convertProperty(property)
	if (Object.keys(children).length === 0)
		throw new Error('libwz parsed a raw WZ image with no properties')
	if (expectedRootNames.length > 0 && !expectedRootNames.some(name => children[name] != null))
		throw new Error(`libwz parsed a raw WZ image without an expected root (${expectedRootNames.join(', ')})`)
	return { type: 1, children }
}

/**
 * Parse a MapleStory.IO rawImage response with the libwz 0.1.1 WASM binding.
 *
 * libwz 0.1.1's WzImage.fromFile adapter does not map a host path through
 * NODEFS. Creating and closing a WzFile first mounts NODEFS, after which the
 * equivalent /mnt path works on the Linux generation container. Keep this
 * workaround here so callers do not depend on the binding detail.
 */
export async function parseRawWzImage(bytes: Uint8Array, imageName: string, expectedRootNames: readonly string[]): Promise<RawWzImageNode> {
	if (bytes.byteLength === 0)
		throw new Error(`Cannot parse empty raw WZ image ${imageName}`)
	if (!/^[\w.-]+$/u.test(imageName))
		throw new Error(`Invalid raw WZ image name ${imageName}`)
	await initWz({ forceWasm: true })
	const directory = await mkdtemp(path.join(tmpdir(), 'maple-pod-raw-wz-'))
	const hostPath = path.join(directory, imageName)
	const wasmPath = `/mnt${hostPath}`
	await writeFile(hostPath, bytes)
	// See the function comment: this deliberately uses the host path only to
	// trigger NODEFS setup, then closes the probe before parsing the image.
	const mountProbe = new WzFile(hostPath, MapleVersion.GMS)
	mountProbe.close()
	try {
		let lastError: unknown = null
		for (const mapleVersion of CANDIDATE_MAPLE_VERSIONS) {
			let image: WzImage | null = null
			try {
				image = WzImage.fromFile(wasmPath, mapleVersion)
				image.parseImage()
				if (!image.isParsed())
					throw new Error(`libwz did not parse ${imageName} as ${MapleVersion[mapleVersion]}`)
				return convertImage(image, expectedRootNames)
			}
			catch (error) {
				lastError = error
			}
			finally {
				image?.close()
			}
		}
		throw new Error(`libwz could not parse raw WZ image ${imageName}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
	}
	finally {
		await rm(directory, { recursive: true, force: true })
	}
}
