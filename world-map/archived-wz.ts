import type { WzCanvasProperty, WzImage, WzVectorProperty } from 'libwz'
import type { AcquiredWorldMapGraph, WorldMapGraphAcquisitionOptions } from './acquire'
import type { ArchivedWzPublishedProvenance } from './schema'
import type { WorldMapRegion } from './snapshot'
import type { GameMapDetail, GameWorldMap, GameWorldMapImage, GameWorldMapLink, GameWorldMapSpot } from './source'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { init as initWz, MapleVersion, ParseStatus, PropertyType, WzFile } from 'libwz'
import path from 'pathe'
import { assertRunningInContainer } from '../assert-container'
import { isArchivedWzPublishedProvenance } from './schema'

const execFileAsync = promisify(execFile)
const SEVEN_Z_SIGNATURE = Buffer.from([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C])
const SEVEN_Z_START_HEADER_SIZE = 32
const ARCHIVE_ORG_ITEM = 'twms-maplestory'

export type ArchivedWzMapleVersion = 'EMS' | 'BMS'

export interface ArchivedWzPackedBlockExpectation {
	blockNumber: number
	packedSize: number
	sharedMembers?: readonly string[]
}

export interface ArchivedWzMemberSourceDefinition {
	logicalRegion: WorldMapRegion
	version: string
	providerRegion: string
	providerVersion: string
	archiveItem: string
	archiveFile: string
	archiveSize: number
	archiveSha1: string
	memberName: string
	memberPath: string
	memberSha256: string | null
	memberSize?: number | null
	memberCrc?: string | null
	expectedPackedBlock?: ArchivedWzPackedBlockExpectation | null
	mapleVersion: ArchivedWzMapleVersion
}

export interface ArchivedStringWzSourceDefinition extends ArchivedWzMemberSourceDefinition {
	memberName: 'String.wz'
	memberSha256: string
}

export interface ArchivedWzMemberProvenance {
	provider: 'archived-wz'
	logicalRegion: WorldMapRegion
	version: string
	providerRegion: string
	providerVersion: string
	archiveItem: string
	archiveFile: string
	archiveUrl: string
	archiveSize: number
	archiveSha1: string
	memberName: string
	memberPath: string
	memberSize: number | null
	memberCrc: string | null
	memberSha256: string
	packedBlock: {
		offset: number
		size: number
		block?: number
	}
	mapleVersion?: ArchivedWzMapleVersion
	wzFile?: string
	wzSha256?: string
}

export interface ArchivedStringWzProvenance extends ArchivedWzMemberProvenance {
	wzFile: 'String.wz'
	wzSha256: string
}

export interface ArchivedWzMemberCacheManifest {
	schemaVersion: 1
	provenance: ArchivedWzMemberProvenance
}

export interface ArchivedStringWzCacheManifest {
	schemaVersion: 1
	provenance: ArchivedStringWzProvenance
	worldMapNames: Record<string, string>
}

export const ARCHIVED_TWMS_STRING_WZ_SOURCES: readonly ArchivedStringWzSourceDefinition[] = [
	{
		logicalRegion: 'TWMS',
		version: '124',
		providerRegion: 'TWMS',
		providerVersion: '124',
		archiveItem: ARCHIVE_ORG_ITEM,
		archiveFile: 'v124.7z',
		archiveSize: 2_443_673_638,
		archiveSha1: '9cb501d3e2349d79262425bcbb49d72aec40043c',
		memberName: 'String.wz',
		memberPath: 'v124/String.wz',
		memberSha256: '6b1ac1319b30109cce159eab7131ddc80fd91d88bc37730d462a6713a9ca39bd',
		memberSize: 2_569_241,
		memberCrc: '8F8F0B19',
		expectedPackedBlock: {
			blockNumber: 13,
			packedSize: 34_339_204,
			sharedMembers: ['v124/String.wz', 'v124/TamingMob.wz', 'v124/UI.wz'],
		},
		mapleVersion: 'EMS',
	},
	{
		logicalRegion: 'TWMS',
		version: '158',
		providerRegion: 'TWMS',
		providerVersion: '158',
		archiveItem: ARCHIVE_ORG_ITEM,
		archiveFile: 'v158.7z',
		archiveSize: 4_641_697_742,
		archiveSha1: '84a43fda9844e9bc6c0bfb26976115e6804bd98d',
		memberName: 'String.wz',
		memberPath: 'v158/String.wz',
		memberSha256: '6ddb8cea06e2c187409ff6a9e39126b8cde0a6d9c3373e87d73cff9910760bd0',
		memberSize: 5_152_535,
		memberCrc: '159DE60F',
		expectedPackedBlock: {
			blockNumber: 17,
			packedSize: 1_921_132,
			sharedMembers: ['v158/String.wz', 'v158/TamingMob.wz'],
		},
		mapleVersion: 'EMS',
	},
	{
		logicalRegion: 'TWMS',
		version: '171',
		providerRegion: 'TWMS',
		providerVersion: '171',
		archiveItem: ARCHIVE_ORG_ITEM,
		archiveFile: 'v171.7z',
		archiveSize: 7_092_223_508,
		archiveSha1: 'ebb1f8f230e8e3d7dbd35ce0770c2fe7e3d82033',
		memberName: 'String.wz',
		memberPath: 'v171/String.wz',
		memberSha256: 'dd42f43e8a2d7021a1fc80e3fbddd36b7f602335be0051004f6ee42a855ebbc4',
		memberSize: 6_598_826,
		memberCrc: 'AAE6AEA7',
		expectedPackedBlock: {
			blockNumber: 17,
			packedSize: 2_506_804,
			sharedMembers: ['v171/String.wz', 'v171/TamingMob.wz'],
		},
		mapleVersion: 'EMS',
	},
] as const

export const ARCHIVED_TWMS_MAP_WZ_SOURCES: readonly ArchivedWzMemberSourceDefinition[] = [
	{
		logicalRegion: 'TWMS',
		version: '124',
		providerRegion: 'TWMS',
		providerVersion: '124',
		archiveItem: ARCHIVE_ORG_ITEM,
		archiveFile: 'v124.7z',
		archiveSize: 2_443_673_638,
		archiveSha1: '9cb501d3e2349d79262425bcbb49d72aec40043c',
		memberName: 'Map.wz',
		memberPath: 'v124/Map.wz',
		memberSha256: 'bfc0190615ca19527b5aa12c3e0fc6c297d574d1e8341a12a2508c32d2ffaf99',
		memberSize: 814_504_293,
		memberCrc: '4165D8CF',
		expectedPackedBlock: {
			blockNumber: 4,
			packedSize: 723_290_006,
			sharedMembers: ['v124/Map.wz'],
		},
		mapleVersion: 'EMS',
	},
	{
		logicalRegion: 'TWMS',
		version: '158',
		providerRegion: 'TWMS',
		providerVersion: '158',
		archiveItem: ARCHIVE_ORG_ITEM,
		archiveFile: 'v158.7z',
		archiveSize: 4_641_697_742,
		archiveSha1: '84a43fda9844e9bc6c0bfb26976115e6804bd98d',
		memberName: 'Map.wz',
		memberPath: 'v158/Map.wz',
		memberSha256: '65330b5837a9511ab4e59d90c1e52a806f9bc7ab9970afeae7027b45ac26e5e6',
		memberSize: 1_284_050_942,
		memberCrc: '5D2B3257',
		expectedPackedBlock: {
			blockNumber: 7,
			packedSize: 1_171_302_698,
			sharedMembers: ['v158/Map.wz'],
		},
		mapleVersion: 'EMS',
	},
	{
		logicalRegion: 'TWMS',
		version: '171',
		providerRegion: 'TWMS',
		providerVersion: '171',
		archiveItem: ARCHIVE_ORG_ITEM,
		archiveFile: 'v171.7z',
		archiveSize: 7_092_223_508,
		archiveSha1: 'ebb1f8f230e8e3d7dbd35ce0770c2fe7e3d82033',
		memberName: 'Map.wz',
		memberPath: 'v171/Map.wz',
		memberSha256: '7cfadbd6b154563f5bdc4f68d7505f789c444597ac24dbd597d696bc76d8d955',
		memberSize: 1_777_450_234,
		memberCrc: '51A1AB13',
		expectedPackedBlock: {
			blockNumber: 7,
			packedSize: 1_623_634_593,
			sharedMembers: ['v171/Map.wz'],
		},
		mapleVersion: 'EMS',
	},
] as const

export function archivedWzMemberSource(
	region: WorldMapRegion,
	version: string | number,
	memberName: string,
): ArchivedWzMemberSourceDefinition | null {
	if (region !== 'TWMS')
		return null
	const normalizedVersion = String(version)
	if (memberName === 'String.wz')
		return ARCHIVED_TWMS_STRING_WZ_SOURCES.find(source => source.version === normalizedVersion) ?? null
	if (memberName === 'Map.wz')
		return ARCHIVED_TWMS_MAP_WZ_SOURCES.find(source => source.version === normalizedVersion) ?? null
	return null
}

export function archivedStringWzSource(
	region: WorldMapRegion,
	version: string | number,
): ArchivedStringWzSourceDefinition | null {
	return archivedWzMemberSource(region, version, 'String.wz') as ArchivedStringWzSourceDefinition | null
}

export function archivedMapWzSource(
	region: WorldMapRegion,
	version: string | number,
): ArchivedWzMemberSourceDefinition | null {
	return archivedWzMemberSource(region, version, 'Map.wz')
}

export function configuredArchivedWzPublishedProvenance(
	region: WorldMapRegion,
	version: string | number,
): ArchivedWzPublishedProvenance | null {
	const stringSource = archivedStringWzSource(region, version)
	const mapSource = archivedMapWzSource(region, version)
	if (stringSource == null || mapSource == null || stringSource.memberSha256 == null || mapSource.memberSha256 == null)
		return null
	if (stringSource.providerRegion !== mapSource.providerRegion
		|| stringSource.providerVersion !== mapSource.providerVersion
		|| stringSource.archiveItem !== mapSource.archiveItem
		|| stringSource.archiveFile !== mapSource.archiveFile
		|| stringSource.archiveSha1.toLowerCase() !== mapSource.archiveSha1.toLowerCase()) {
		throw new Error(`Configured archived WZ sources disagree for ${region}/${String(version)}`)
	}
	return {
		providerRegion: stringSource.providerRegion,
		providerVersion: stringSource.providerVersion,
		archiveItem: stringSource.archiveItem,
		archiveFile: stringSource.archiveFile,
		archiveSha1: stringSource.archiveSha1,
		members: {
			stringWz: { name: 'String.wz', sha256: stringSource.memberSha256 },
			mapWz: { name: 'Map.wz', sha256: mapSource.memberSha256 },
		},
	}
}

export function normalizeMemberPath(filePath: string): string {
	if (typeof filePath !== 'string' || filePath.trim().length === 0)
		throw new Error('Member path cannot be empty')
	if (filePath.includes('\0'))
		throw new Error(`Member path contains illegal NUL character: ${filePath}`)
	if (/^[A-Za-z]:/u.test(filePath))
		throw new Error(`Member path cannot be a Windows drive path: ${filePath}`)
	if (filePath.startsWith('//') || filePath.startsWith('\\\\'))
		throw new Error(`Member path cannot be a UNC path: ${filePath}`)
	if (filePath.startsWith('/') || filePath.startsWith('\\'))
		throw new Error(`Member path cannot be an absolute path: ${filePath}`)
	const normalized = filePath.replaceAll('\\', '/').replace(/^\.\//u, '')
	if (normalized.length === 0)
		throw new Error('Member path cannot be empty')
	const segments = normalized.split('/')
	if (segments.some(segment => segment.length === 0))
		throw new Error(`Member path contains empty segments: ${filePath}`)
	if (segments.includes('..'))
		throw new Error(`Member path contains illegal path traversal: ${filePath}`)
	return normalized
}

export interface SevenZipStartHeader {
	nextHeaderOffset: number
	nextHeaderSize: number
	nextHeaderAbsoluteOffset: number
}

function safeUint64(value: bigint, field: string): number {
	if (value > BigInt(Number.MAX_SAFE_INTEGER))
		throw new Error(`7z ${field} exceeds JavaScript safe integer range`)
	return Number(value)
}

function parseSevenZipSafeInteger(value: string | undefined, field: string): number | null {
	if (value == null)
		return null
	const trimmed = value.trim()
	if (trimmed.length === 0 || !/^\d+$/u.test(trimmed))
		return null
	return safeUint64(BigInt(trimmed), `listing ${field}`)
}

export function parseSevenZipStartHeader(bytes: Uint8Array): SevenZipStartHeader {
	if (bytes.byteLength !== SEVEN_Z_START_HEADER_SIZE)
		throw new Error(`7z start header must be exactly ${SEVEN_Z_START_HEADER_SIZE} bytes`)
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	if (!buffer.subarray(0, SEVEN_Z_SIGNATURE.length).equals(SEVEN_Z_SIGNATURE))
		throw new Error('Invalid 7z signature')
	const nextHeaderOffset = safeUint64(buffer.readBigUInt64LE(12), 'next header offset')
	const nextHeaderSize = safeUint64(buffer.readBigUInt64LE(20), 'next header size')
	if (nextHeaderSize <= 0)
		throw new Error('7z next header is empty')
	return {
		nextHeaderOffset,
		nextHeaderSize,
		nextHeaderAbsoluteOffset: SEVEN_Z_START_HEADER_SIZE + nextHeaderOffset,
	}
}

export interface SevenZipUintResult {
	value: number
	nextOffset: number
}

export function readSevenZipUint(bytes: Uint8Array, offset: number): SevenZipUintResult {
	if (!Number.isInteger(offset) || offset < 0 || offset >= bytes.length)
		throw new Error('Invalid 7z uint offset')
	const first = bytes[offset]!
	let cursor = offset + 1
	let mask = 0x80
	let value = 0n
	for (let index = 0; index < 8; index++) {
		if ((first & mask) === 0) {
			value |= BigInt(first & (mask - 1)) << BigInt(8 * index)
			return { value: safeUint64(value, 'uint'), nextOffset: cursor }
		}
		if (cursor >= bytes.length)
			throw new Error('Truncated 7z uint')
		value |= BigInt(bytes[cursor]!) << BigInt(8 * index)
		cursor++
		mask >>= 1
	}
	return { value: safeUint64(value, 'uint'), nextOffset: cursor }
}

/**
 * Locate the packed stream that contains the encoded 7z header. Archive.org's
 * TWMS 7z files use the standard `EncodedHeader -> PackInfo -> Size` shape.
 */
export function parseEncodedHeaderPackedRange(nextHeader: Uint8Array): { offset: number, size: number } {
	if (nextHeader.length < 6 || nextHeader[0] !== 0x17 || nextHeader[1] !== 0x06)
		throw new Error('Unsupported 7z next-header shape; expected encoded header PackInfo')
	let cursor = 2
	const packPosition = readSevenZipUint(nextHeader, cursor)
	cursor = packPosition.nextOffset
	const packStreamCount = readSevenZipUint(nextHeader, cursor)
	cursor = packStreamCount.nextOffset
	if (packStreamCount.value !== 1 || nextHeader[cursor] !== 0x09)
		throw new Error('Unsupported 7z encoded-header pack stream layout')
	cursor++
	const packSize = readSevenZipUint(nextHeader, cursor)
	if (packSize.value <= 0)
		throw new Error('7z encoded-header packed stream is empty')
	return { offset: SEVEN_Z_START_HEADER_SIZE + packPosition.value, size: packSize.value }
}

export interface SevenZipListingEntry {
	path: string
	size: number | null
	crc: string | null
	block: number | null
	packedSize: number | null
}

export function parseSevenZipTechnicalListing(text: string): SevenZipListingEntry[] {
	const result: SevenZipListingEntry[] = []
	let current: Record<string, string> = {}
	const flush = () => {
		if (current.Type != null || current['Physical Size'] != null) {
			current = {}
			return
		}
		if (current.Path != null && current.Path.trim().length > 0) {
			const normalizedPath = normalizeMemberPath(current.Path.trim())
			const size = parseSevenZipSafeInteger(current.Size, 'Size')
			const crc = current.CRC != null && current.CRC.trim().length > 0 ? current.CRC.trim().toUpperCase() : null
			const block = parseSevenZipSafeInteger(current.Block, 'Block')
			const packedSize = parseSevenZipSafeInteger(current['Packed Size'], 'Packed Size')
			result.push({ path: normalizedPath, size, crc, block, packedSize })
		}
		current = {}
	}
	for (const line of `${text}\n`.split(/\r?\n/u)) {
		if (line.trim().length === 0) {
			flush()
			continue
		}
		const separator = line.indexOf(' = ')
		if (separator > 0)
			current[line.slice(0, separator).trim()] = line.slice(separator + 3).trim()
	}
	flush()
	return result
}

export interface LocatedSevenZipMemberBlock {
	offset: number
	size: number
	block: number
	sharedMembers: string[]
	member: SevenZipListingEntry
}

export function locateSevenZipMemberBlock(
	entries: readonly SevenZipListingEntry[],
	memberPath: string,
	options?: { archiveSize?: number },
): LocatedSevenZipMemberBlock {
	const targetPath = normalizeMemberPath(memberPath)
	const member = entries.find(entry => entry.path === targetPath)
	if (member == null)
		throw new Error(`7z listing does not contain member ${targetPath}`)
	if (member.block == null)
		throw new Error(`7z listing does not identify a packed block for ${targetPath}`)

	const sizes = new Map<number, number>()
	const membersByBlock = new Map<number, string[]>()

	for (const entry of entries) {
		if (entry.block == null)
			continue
		const currentMembers = membersByBlock.get(entry.block) ?? []
		currentMembers.push(entry.path)
		membersByBlock.set(entry.block, currentMembers)

		if (entry.packedSize != null) {
			const existing = sizes.get(entry.block)
			if (existing != null && existing !== entry.packedSize) {
				throw new Error(
					`7z listing has conflicting packed sizes for block ${entry.block}: ${existing} vs ${entry.packedSize}`,
				)
			}
			sizes.set(entry.block, entry.packedSize)
		}
	}

	if (!sizes.has(member.block))
		throw new Error(`7z listing does not provide packed size for block ${member.block}`)

	for (let b = 0; b <= member.block; b++) {
		if (!sizes.has(b))
			throw new Error(`7z listing is missing packed size for preceding block ${b} before block ${member.block}`)
	}

	let offset = SEVEN_Z_START_HEADER_SIZE
	for (let b = 0; b < member.block; b++) {
		const blockSize = sizes.get(b)!
		if (!Number.isSafeInteger(blockSize) || blockSize <= 0)
			throw new Error(`Invalid packed size for block ${b}: ${blockSize}`)
		offset += blockSize
	}

	const targetSize = sizes.get(member.block)!
	if (!Number.isSafeInteger(targetSize) || targetSize <= 0)
		throw new Error(`Invalid packed size for block ${member.block}: ${targetSize}`)

	if (!Number.isSafeInteger(offset) || offset < SEVEN_Z_START_HEADER_SIZE)
		throw new Error(`Invalid packed offset for block ${member.block}: ${offset}`)

	if (options?.archiveSize != null && offset + targetSize > options.archiveSize) {
		throw new Error(
			`Block ${member.block} range ${offset}-${offset + targetSize} exceeds archive size ${options.archiveSize}`,
		)
	}

	return {
		offset,
		size: targetSize,
		block: member.block,
		sharedMembers: membersByBlock.get(member.block) ?? [targetPath],
		member,
	}
}

export interface ArchiveOrgMetadataFile {
	name?: unknown
	size?: unknown
	sha1?: unknown
}

export function validateArchiveOrgMetadata(
	files: readonly ArchiveOrgMetadataFile[],
	source: { archiveFile: string, archiveSize: number, archiveSha1: string },
): void {
	const file = files.find(candidate => candidate.name === source.archiveFile)
	if (file == null)
		throw new Error(`Archive.org metadata is missing ${source.archiveFile}`)
	if (String(file.size) !== String(source.archiveSize))
		throw new Error(`Archive.org size mismatch for ${source.archiveFile}: expected ${source.archiveSize}, got ${String(file.size)}`)
	if (typeof file.sha1 !== 'string' || file.sha1.toLowerCase() !== source.archiveSha1.toLowerCase())
		throw new Error(`Archive.org SHA-1 mismatch for ${source.archiveFile}`)
}

export function archivedStringWzCacheDirectory(
	workspace: string,
	source: { logicalRegion: string, version: string | number },
): string {
	return path.join(workspace, '.cache', 'world-map', 'archived-wz', source.logicalRegion, String(source.version))
}

export function archivedWzMemberCacheDirectory(
	workspace: string,
	source: { logicalRegion: string, version: string | number },
	memberName?: string,
): string {
	const base = path.join(workspace, '.cache', 'world-map', 'archived-wz', source.logicalRegion, String(source.version))
	return memberName != null && memberName !== 'String.wz' ? path.join(base, memberName) : base
}

export async function findCachedArchivedWzMember(
	workspace: string,
	source: ArchivedWzMemberSourceDefinition,
): Promise<string | null> {
	const directPath = path.join(archivedStringWzCacheDirectory(workspace, source), source.memberName)
	try {
		const s = await stat(directPath)
		if (s.isFile())
			return directPath
	}
	catch {
		// Not in direct directory
	}
	const subPath = path.join(archivedWzMemberCacheDirectory(workspace, source, source.memberName), source.memberName)
	try {
		const s = await stat(subPath)
		if (s.isFile())
			return subPath
	}
	catch {
		// Not in member directory
	}
	return null
}

function sha256(bytes: Uint8Array): string {
	return createHash('sha256')
		.update(bytes)
		.digest('hex')
}

/** Hash a materialized WZ member without allocating a buffer for the whole file. */
export async function sha256File(filePath: string): Promise<string> {
	const hash = createHash('sha256')
	const stream = createReadStream(filePath)
	for await (const chunk of stream)
		hash.update(chunk)
	return hash.digest('hex')
}

export function parseArchivedLibwzPatchVersion(version: unknown): number {
	if (typeof version !== 'number' && typeof version !== 'string')
		throw new Error(`Archived libwz requires positive integer patch version, got: ${String(version)}`)
	const str = String(version).trim()
	if (!/^\d+$/u.test(str))
		throw new Error(`Archived libwz requires positive integer patch version, got: ${str}`)
	const numeric = Number(str)
	if (!Number.isSafeInteger(numeric) || numeric <= 0)
		throw new Error(`Archived libwz requires positive integer patch version, got: ${str}`)
	return numeric
}

export async function parseArchivedWorldMapNames(
	stringWzFile: string,
	version: string | number,
	mapleVersion: ArchivedWzMapleVersion,
): Promise<Record<string, string>> {
	const patchVersion = parseArchivedLibwzPatchVersion(version)
	await initWz({ forceWasm: true })
	const file = new WzFile(stringWzFile, patchVersion, mapleVersion === 'EMS' ? MapleVersion.EMS : MapleVersion.BMS)
	try {
		const status = file.parseWzFile()
		if (status !== ParseStatus.SUCCESS)
			throw new Error(`libwz could not parse String.wz (status ${status})`)
		const image = file.getWzDirectory()?.getImageByName('WorldMap.img') ?? null
		if (image == null)
			return {}
		image.parseImage()
		const names: Record<string, string> = {}
		for (const property of image.wzProperties()) {
			const key = property.getName()
			const nameProperty = property.getChildByName('name')
			if (nameProperty == null)
				continue
			let name: string
			try {
				name = nameProperty.getString().trim()
			}
			catch {
				continue
			}
			if (name.length === 0)
				continue
			const worldMapId = key === '0' ? 'WorldMap' : /^\d+$/u.test(key) ? `WorldMap${key}` : key
			names[worldMapId] = name
		}
		return names
	}
	finally {
		file.close()
	}
}

export async function parseArchivedMapStrings(
	stringWzFile: string,
	version: string | number,
	mapleVersion: ArchivedWzMapleVersion,
): Promise<Record<string, { mapName: string | null, streetName: string | null }>> {
	const patchVersion = parseArchivedLibwzPatchVersion(version)
	await initWz({ forceWasm: true })
	const file = new WzFile(stringWzFile, patchVersion, mapleVersion === 'EMS' ? MapleVersion.EMS : MapleVersion.BMS)
	try {
		const status = file.parseWzFile()
		if (status !== ParseStatus.SUCCESS)
			throw new Error(`libwz could not parse String.wz (status ${status})`)
		const image = file.getWzDirectory()?.getImageByName('Map.img') ?? null
		if (image == null)
			return {}
		image.parseImage()
		const strings: Record<string, { mapName: string | null, streetName: string | null }> = {}
		for (const category of image.wzProperties()) {
			if (category.getPropertyType() === PropertyType.SUB) {
				for (const mapProp of category.wzProperties()) {
					const id = mapProp.getName().trim()
					if (!/^\d+$/u.test(id))
						continue
					const mapNameProp = mapProp.getChildByName('mapName') ?? mapProp.getChildByName('name')
					const streetNameProp = mapProp.getChildByName('streetName')
					strings[id] = {
						mapName: mapNameProp?.getString().trim() || null,
						streetName: streetNameProp?.getString().trim() || null,
					}
				}
			}
			else {
				const id = category.getName().trim()
				if (/^\d+$/u.test(id)) {
					const mapNameProp = category.getChildByName('mapName') ?? category.getChildByName('name')
					const streetNameProp = category.getChildByName('streetName')
					strings[id] = {
						mapName: mapNameProp?.getString().trim() || null,
						streetName: streetNameProp?.getString().trim() || null,
					}
				}
			}
		}
		return strings
	}
	finally {
		file.close()
	}
}

export interface ParseArchivedMapWzOptions {
	mapleVersion?: ArchivedWzMapleVersion
	priorityMapIds?: readonly string[]
	mode?: 'preview' | 'full'
	previewMapDetailLimit?: number
	mapStrings?: Record<string, { mapName: string | null, streetName: string | null }>
	worldMapNames?: Record<string, string>
}

export interface ParsedArchivedMapWzResult {
	roots: string[]
	nodes: GameWorldMap[]
	maps: GameMapDetail[]
	warnings: string[]
}

function findMapImage(file: WzFile, mapId: string): WzImage | null {
	const padded = mapId.padStart(9, '0')
	const rootDir = file.getWzDirectory()
	if (rootDir == null)
		return null
	const mapDir = rootDir.getDirectoryByName('Map') ?? rootDir
	const subDirName = `Map${padded[0]}`
	const subDir = mapDir.getDirectoryByName(subDirName)
	if (subDir != null) {
		const img = subDir.getImageByName(`${padded}.img`) ?? subDir.getImageByName(`${mapId}.img`)
		if (img != null)
			return img
	}
	return mapDir.getImageByName(`${padded}.img`) ?? mapDir.getImageByName(`${mapId}.img`)
}

async function extractCanvasToGameWorldMapImage(
	canvas: WzCanvasProperty,
	tempDir: string,
	prefix: string,
): Promise<GameWorldMapImage> {
	const originProp = canvas.getChildByName('origin')
	let origin = { x: 0, y: 0 }
	if (originProp != null && 'getX' in originProp && 'getY' in originProp) {
		const vec = originProp as WzVectorProperty
		origin = { x: vec.getX(), y: vec.getY() }
	}
	const randomPart = Math.random().toString(36)
	const randomSuffix = `${Date.now()}-${randomPart.slice(2)}`
	const tempPngPath = path.resolve(path.join(tempDir, `${prefix}-${randomSuffix}.png`))
	const saved = canvas.saveToFile(tempPngPath)
	if (!saved)
		throw new Error(`Failed to save canvas to ${tempPngPath}`)
	try {
		const bytes = await readFile(tempPngPath)
		return {
			image: bytes.toString('base64'),
			origin,
		}
	}
	finally {
		await rm(tempPngPath, { force: true })
	}
}

export async function parseArchivedMapWz(
	mapWzFile: string,
	version: string | number,
	options: ParseArchivedMapWzOptions = {},
): Promise<ParsedArchivedMapWzResult> {
	const patchVersion = parseArchivedLibwzPatchVersion(version)
	const mapleVersion = options.mapleVersion ?? 'EMS'
	await initWz({ forceWasm: true })
	const file = new WzFile(mapWzFile, patchVersion, mapleVersion === 'EMS' ? MapleVersion.EMS : MapleVersion.BMS)
	const tempDir = await mkdtemp(path.join(tmpdir(), 'world-map-canvas-'))
	try {
		const status = file.parseWzFile()
		if (status !== ParseStatus.SUCCESS)
			throw new Error(`libwz could not parse Map.wz (status ${status})`)
		const rootDir = file.getWzDirectory()
		const worldMapDir = rootDir?.getDirectoryByName('WorldMap') ?? rootDir
		if (worldMapDir == null)
			throw new Error('Map.wz contains no WorldMap directory')
		const screenImages = (worldMapDir.wzImages() ?? []).filter((img): img is WzImage => img != null && img.getName().endsWith('.img'))
		const nodes: GameWorldMap[] = []
		const warnings: string[] = []

		for (const screen of screenImages) {
			screen.parseImage()
			const id = screen.getName().replace(/\.img$/iu, '')
			const baseImgProp = screen.getFromPath('BaseImg') ?? screen.getFromPath('baseImage')
			const baseImages: GameWorldMapImage[] = []
			if (baseImgProp != null) {
				const canvases = baseImgProp.wzProperties().filter((p): p is WzCanvasProperty => p.getPropertyType() === PropertyType.CANVAS)
				canvases.sort((left, right) => left.getName().localeCompare(right.getName(), undefined, { numeric: true }))
				for (const [index, canvas] of canvases.entries()) {
					baseImages.push(await extractCanvasToGameWorldMapImage(canvas, tempDir, `${id}-base-${index}`))
				}
			}
			if (baseImages.length === 0) {
				if (options.mode === 'full')
					throw new Error(`Archived Map.wz WorldMap ${id} has no renderable base image`)
				warnings.push(`Skipped archived Map.wz WorldMap ${id}: no renderable base image`)
				continue
			}

			const links: GameWorldMapLink[] = []
			const mapLinkProp = screen.getFromPath('MapLink') ?? screen.getFromPath('links')
			if (mapLinkProp != null) {
				for (const [index, linkChild] of mapLinkProp.wzProperties().entries()) {
					const toolTipProp = linkChild.getChildByName('toolTip')
					const toolTip = toolTipProp?.getString().trim() || null
					const linkMapProp = linkChild.getFromPath('link/linkMap')
						?? linkChild.getChildByName('linkMap')
						?? linkChild.getChildByName('linksTo')
						?? linkChild.getChildByName('link')
					const linksTo = linkMapProp?.getPropertyType() === PropertyType.STRING
						? linkMapProp.getString().trim()
						: null
					if (!linksTo) {
						if (options.mode === 'full')
							throw new Error(`Archived Map.wz WorldMap ${id} has malformed MapLink ${index} target`)
						warnings.push(`Skipped malformed archived Map.wz MapLink ${id}/${index}`)
						continue
					}
					const linkImgProp = linkChild.getFromPath('link/linkImg')
						?? linkChild.getChildByName('linkImg')
						?? linkChild.getChildByName('linkImage')
					let linkImage: GameWorldMapImage | null = null
					if (linkImgProp != null && linkImgProp.getPropertyType() === PropertyType.CANVAS) {
						linkImage = await extractCanvasToGameWorldMapImage(linkImgProp as WzCanvasProperty, tempDir, `${id}-link-${index}`)
					}
					else if (linkImgProp != null && options.mode === 'full') {
						throw new Error(`Archived Map.wz WorldMap ${id} has malformed MapLink ${index} image`)
					}
					links.push({
						toolTip,
						linksTo,
						linkImage,
					})
				}
			}

			const maps: GameWorldMapSpot[] = []
			const mapListProp = screen.getFromPath('MapList') ?? screen.getFromPath('maps')
			if (mapListProp != null) {
				for (const [spotIndex, spotChild] of mapListProp.wzProperties().entries()) {
					const spotProp = spotChild.getChildByName('spot')
					if (spotProp == null || spotProp.getPropertyType() !== PropertyType.VECTOR) {
						if (options.mode === 'full')
							throw new Error(`Archived Map.wz WorldMap ${id} has malformed MapList spot ${spotIndex}`)
						warnings.push(`Skipped malformed archived MapList spot ${id}/${spotIndex}`)
						continue
					}
					const spot = { x: (spotProp as WzVectorProperty).getX(), y: (spotProp as WzVectorProperty).getY() }
					const typeProp = spotChild.getChildByName('type')
					if (typeProp == null || (typeProp.getPropertyType() !== PropertyType.INT && typeProp.getPropertyType() !== PropertyType.SHORT)) {
						if (options.mode === 'full')
							throw new Error(`Archived Map.wz WorldMap ${id} has malformed MapList type ${spotIndex}`)
						warnings.push(`Skipped malformed archived MapList type ${id}/${spotIndex}`)
						continue
					}
					const type = typeProp.getInt()
					const mapNoProp = spotChild.getFromPath('mapNo')
						?? spotChild.getChildByName('mapNo')
						?? spotChild.getChildByName('maps')
					const mapNumbers: string[] = []
					if (mapNoProp != null) {
						for (const p of mapNoProp.wzProperties()) {
							if (p.getPropertyType() === PropertyType.INT || p.getPropertyType() === PropertyType.SHORT)
								mapNumbers.push(String(p.getInt()))
							else if (p.getPropertyType() === PropertyType.STRING)
								mapNumbers.push(p.getString().trim())
						}
					}
					maps.push({ spot, type, mapNumbers })
				}
			}

			const parentProp = screen.getFromPath('info/parentMap') ?? screen.getFromPath('info/parentWorld')
			const parentWorld = parentProp != null && parentProp.getPropertyType() === PropertyType.STRING
				? parentProp.getString().trim() || null
				: null

			const worldMapName = options.worldMapNames?.[id] ?? id
			nodes.push({
				id,
				worldMapName,
				parentWorld,
				links,
				baseImages,
				maps,
				mapNumbers: maps.flatMap(spot => spot.mapNumbers),
			})
		}

		const roots = nodes.filter(node => node.parentWorld === null).map(node => node.id)
		const allMapIds: string[] = []
		const representativeMapIds: string[] = []
		const seenAll = new Set<string>()
		const seenRep = new Set<string>()

		for (const mapId of options.priorityMapIds ?? []) {
			if (!seenRep.has(mapId)) {
				seenRep.add(mapId)
				representativeMapIds.push(mapId)
			}
			if (!seenAll.has(mapId)) {
				seenAll.add(mapId)
				allMapIds.push(mapId)
			}
		}

		for (const node of nodes) {
			for (const spot of node.maps) {
				for (const mapId of spot.mapNumbers) {
					if (!seenAll.has(mapId)) {
						seenAll.add(mapId)
						allMapIds.push(mapId)
					}
				}
				if (spot.mapNumbers[0] != null && !seenRep.has(spot.mapNumbers[0])) {
					seenRep.add(spot.mapNumbers[0])
					representativeMapIds.push(spot.mapNumbers[0])
				}
			}
		}

		const detailIds = options.mode === 'preview'
			? representativeMapIds.slice(0, options.previewMapDetailLimit ?? 32)
			: allMapIds

		const mapDetails: GameMapDetail[] = []
		for (const mapId of detailIds) {
			const mapImg = findMapImage(file, mapId)
			let bgm: string | null = null
			let mapMark: string | null = null
			if (mapImg != null) {
				mapImg.parseImage()
				const info = mapImg.getFromPath('info')
				const bgmProp = info?.getChildByName('bgm')
				const markProp = info?.getChildByName('mapMark')
				bgm = bgmProp?.getString().trim() || null
				mapMark = markProp?.getString().trim() || null
			}
			const stringInfo = options.mapStrings?.[mapId]
			mapDetails.push({
				id: mapId,
				mapMark,
				name: stringInfo?.mapName ?? null,
				streetName: stringInfo?.streetName ?? null,
				backgroundMusic: bgm,
			})
		}

		return {
			roots,
			nodes,
			maps: mapDetails,
			warnings,
		}
	}
	finally {
		file.close()
		await rm(tempDir, { recursive: true, force: true })
	}
}

export interface ArchivedWzWorldMapGraphSources {
	stringWzFile: string
	mapWzFile: string
	archiveItem?: string
	/** Required for published full-generation provenance; optional for parser-only callers. */
	provenance?: ArchivedWzPublishedProvenance
}

function assertSameArchiveIdentity(stringProvenance: ArchivedWzMemberProvenance, mapProvenance: ArchivedWzMemberProvenance): void {
	for (const field of ['logicalRegion', 'version', 'providerRegion', 'providerVersion', 'archiveItem', 'archiveFile', 'archiveSha1'] as const) {
		if (stringProvenance[field] !== mapProvenance[field])
			throw new Error(`Archived WZ cache manifests disagree on ${field}`)
	}
}

export function archivedWzPublishedProvenance(
	stringProvenance: ArchivedStringWzProvenance,
	mapProvenance: ArchivedWzMemberProvenance,
): ArchivedWzPublishedProvenance {
	if (stringProvenance.provider !== 'archived-wz' || mapProvenance.provider !== 'archived-wz')
		throw new Error('Archived WZ cache manifests have invalid provider provenance')
	assertSameArchiveIdentity(stringProvenance, mapProvenance)
	if (stringProvenance.memberName !== 'String.wz' || mapProvenance.memberName !== 'Map.wz')
		throw new Error('Archived WZ cache manifests must contain String.wz and Map.wz')
	if (!/^[a-f0-9]{64}$/iu.test(stringProvenance.memberSha256) || !/^[a-f0-9]{64}$/iu.test(mapProvenance.memberSha256))
		throw new Error('Archived WZ cache manifests contain invalid member SHA-256 values')
	return {
		providerRegion: stringProvenance.providerRegion,
		providerVersion: stringProvenance.providerVersion,
		archiveItem: stringProvenance.archiveItem,
		archiveFile: stringProvenance.archiveFile,
		archiveSha1: stringProvenance.archiveSha1,
		members: {
			stringWz: { name: 'String.wz', sha256: stringProvenance.memberSha256 },
			mapWz: { name: 'Map.wz', sha256: mapProvenance.memberSha256 },
		},
	}
}

interface CachedArchivedWzManifestRecord {
	schemaVersion?: unknown
	provenance?: Record<string, unknown>
}

function cachedManifestRecord(value: unknown, file: string): CachedArchivedWzManifestRecord {
	if (value == null || typeof value !== 'object' || Array.isArray(value))
		throw new Error(`Archived WZ cache manifest ${file} is not an object`)
	const record = value as CachedArchivedWzManifestRecord
	if (record.schemaVersion !== 1 || record.provenance == null || typeof record.provenance !== 'object' || Array.isArray(record.provenance))
		throw new Error(`Archived WZ cache manifest ${file} has an unsupported schema`)
	return record
}

function cachedManifestString(value: Record<string, unknown>, key: string): string | null {
	return typeof value[key] === 'string' && value[key].length > 0 ? value[key] as string : null
}

function sourceBackedArchivedWzMemberProvenance(
	source: ArchivedWzMemberSourceDefinition,
	memberSha256: string,
): ArchivedWzMemberProvenance {
	return {
		provider: 'archived-wz',
		logicalRegion: source.logicalRegion,
		version: String(source.version),
		providerRegion: source.providerRegion,
		providerVersion: source.providerVersion,
		archiveItem: source.archiveItem,
		archiveFile: source.archiveFile,
		archiveUrl: `https://archive.org/download/${source.archiveItem}/${source.archiveFile}`,
		archiveSize: source.archiveSize,
		archiveSha1: source.archiveSha1,
		memberName: source.memberName,
		memberPath: source.memberPath,
		memberSize: source.memberSize ?? null,
		memberCrc: source.memberCrc ?? null,
		memberSha256,
		packedBlock: { offset: 0, size: 0 },
		mapleVersion: source.mapleVersion,
		wzFile: source.memberName,
		wzSha256: memberSha256,
	}
}

export async function verifyArchivedWzPublishedProvenance(
	paths: { stringWzFile: string, mapWzFile: string },
	provenance: ArchivedWzPublishedProvenance,
	configured: ArchivedWzPublishedProvenance,
): Promise<void> {
	if (!isArchivedWzPublishedProvenance(provenance))
		throw new Error('Archived WZ published provenance has an invalid shape')
	if (!isArchivedWzPublishedProvenance(configured))
		throw new Error('Configured archived WZ published provenance has an invalid shape')
	const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()
	if (provenance.providerRegion !== configured.providerRegion
		|| provenance.providerVersion !== configured.providerVersion
		|| provenance.archiveItem !== configured.archiveItem
		|| provenance.archiveFile !== configured.archiveFile
		|| !same(provenance.archiveSha1, configured.archiveSha1)
		|| !same(provenance.members.stringWz.sha256, configured.members.stringWz.sha256)
		|| !same(provenance.members.mapWz.sha256, configured.members.mapWz.sha256)) {
		throw new Error('Archived WZ published provenance does not match the configured exact registry identity or hashes')
	}
	const [stringSha256, mapSha256] = await Promise.all([sha256File(paths.stringWzFile), sha256File(paths.mapWzFile)])
	if (stringSha256.toLowerCase() !== configured.members.stringWz.sha256.toLowerCase())
		throw new Error(`String.wz SHA-256 does not match configured archived-WZ registry: expected ${configured.members.stringWz.sha256}, got ${stringSha256}`)
	if (mapSha256.toLowerCase() !== configured.members.mapWz.sha256.toLowerCase())
		throw new Error(`Map.wz SHA-256 does not match configured archived-WZ registry: expected ${configured.members.mapWz.sha256}, got ${mapSha256}`)
}

export async function readCachedArchivedWzProvenance(
	workspace: string,
	stringSource: ArchivedStringWzSourceDefinition,
	mapSource: ArchivedWzMemberSourceDefinition,
): Promise<ArchivedWzPublishedProvenance> {
	const cacheDirectory = archivedStringWzCacheDirectory(workspace, stringSource)
	let stringRecord: CachedArchivedWzManifestRecord
	let mapRecord: CachedArchivedWzManifestRecord | null = null
	try {
		stringRecord = cachedManifestRecord(JSON.parse(await readFile(path.join(cacheDirectory, 'manifest.json'), 'utf8')), 'manifest.json')
		try {
			mapRecord = cachedManifestRecord(JSON.parse(await readFile(path.join(cacheDirectory, 'manifest-map.json'), 'utf8')), 'manifest-map.json')
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
				throw error
			// Older materialized caches used one String.wz manifest and did not
			// write a separate Map.wz manifest. The configured Map.wz source is
			// still exact, and the full-generation byte verification below checks
			// the materialized member before publication.
		}
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(`Archived WZ cache provenance is unavailable for ${stringSource.logicalRegion}/${stringSource.version}: ${message}`)
	}
	const stringManifestProvenance = stringRecord.provenance!
	const stringSha256 = cachedManifestString(stringManifestProvenance, 'memberSha256')
		?? cachedManifestString(stringManifestProvenance, 'wzSha256')
		?? stringSource.memberSha256
	const mapSha256 = mapRecord == null
		? mapSource.memberSha256
		: cachedManifestString(mapRecord.provenance!, 'memberSha256')
			?? cachedManifestString(mapRecord.provenance!, 'wzSha256')
	if (stringSha256 == null || mapSha256 == null)
		throw new Error(`Archived WZ cache provenance is missing String.wz or Map.wz SHA-256 for ${stringSource.logicalRegion}/${stringSource.version}`)
	const stringProvenance: ArchivedStringWzProvenance = {
		...sourceBackedArchivedWzMemberProvenance(stringSource, stringSha256),
		wzFile: 'String.wz',
		wzSha256: stringSha256,
	}
	const mapProvenance = mapRecord == null
		? sourceBackedArchivedWzMemberProvenance(mapSource, mapSha256)
		: {
			...sourceBackedArchivedWzMemberProvenance(mapSource, mapSha256),
			providerRegion: cachedManifestString(mapRecord.provenance!, 'providerRegion') ?? mapSource.providerRegion,
			providerVersion: cachedManifestString(mapRecord.provenance!, 'providerVersion') ?? mapSource.providerVersion,
			archiveItem: cachedManifestString(mapRecord.provenance!, 'archiveItem') ?? mapSource.archiveItem,
			archiveFile: cachedManifestString(mapRecord.provenance!, 'archiveFile') ?? mapSource.archiveFile,
			archiveSha1: cachedManifestString(mapRecord.provenance!, 'archiveSha1') ?? mapSource.archiveSha1,
		} satisfies ArchivedWzMemberProvenance
	const published = archivedWzPublishedProvenance(stringProvenance, mapProvenance)
	if (published.providerRegion !== stringSource.providerRegion
		|| published.providerVersion !== stringSource.providerVersion
		|| published.archiveItem !== stringSource.archiveItem
		|| published.archiveFile !== stringSource.archiveFile
		|| published.archiveSha1.toLowerCase() !== stringSource.archiveSha1.toLowerCase()
		|| published.members.stringWz.sha256.toLowerCase() !== stringSource.memberSha256.toLowerCase()
		|| (mapSource.memberSha256 != null && published.members.mapWz.sha256.toLowerCase() !== mapSource.memberSha256.toLowerCase())) {
		throw new Error(`Archived WZ cache provenance does not match the configured ${stringSource.logicalRegion}/${stringSource.version} sources`)
	}
	return published
}

export async function acquireArchivedWzWorldMapGraph(
	sources: ArchivedWzWorldMapGraphSources,
	region: WorldMapRegion,
	version: string,
	options: WorldMapGraphAcquisitionOptions,
	mapleVersion: ArchivedWzMapleVersion = 'EMS',
): Promise<AcquiredWorldMapGraph> {
	const worldMapNames = await parseArchivedWorldMapNames(sources.stringWzFile, version, mapleVersion)
	const mapStrings = await parseArchivedMapStrings(sources.stringWzFile, version, mapleVersion)
	const parsed = await parseArchivedMapWz(sources.mapWzFile, version, {
		mapleVersion,
		priorityMapIds: options.priorityMapIds,
		mode: options.mode,
		previewMapDetailLimit: options.previewMapDetailLimit,
		mapStrings,
		worldMapNames,
	})
	const warnings = [...parsed.warnings]
	if (Object.keys(worldMapNames).length === 0)
		warnings.push('Archived String.wz contains no WorldMap.img; node labels fall back to inbound link tooltips.')
	return {
		provider: 'archived-wz',
		region,
		logicalRegion: region,
		version,
		apiBase: `https://archive.org/download/${sources.provenance?.archiveItem ?? sources.archiveItem ?? 'archive'}`,
		roots: parsed.roots,
		nodes: parsed.nodes,
		maps: parsed.maps,
		worldMapNames,
		warnings,
		archivedWz: sources.provenance,
	}
}

export interface HttpRangeResponse {
	bytes: Uint8Array
	totalSize: number
}

export type RangeFetcher = (url: string, start: number, endInclusive: number) => Promise<HttpRangeResponse>

export async function fetchHttpRange(url: string, start: number, endInclusive: number): Promise<HttpRangeResponse> {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endInclusive) || start < 0 || endInclusive < start)
		throw new Error(`Invalid HTTP byte range ${start}-${endInclusive}`)
	const response = await fetch(url, { headers: { 'Range': `bytes=${start}-${endInclusive}`, 'user-agent': 'maple-pod-resources/archived-wz-sync' } })
	if (response.status !== 206)
		throw new Error(`Range request ${start}-${endInclusive} returned HTTP ${response.status}`)
	const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get('content-range') ?? '')
	if (match == null || Number(match[1]) !== start || Number(match[2]) !== endInclusive)
		throw new Error(`Invalid Content-Range for ${start}-${endInclusive}`)
	const bytes = new Uint8Array(await response.arrayBuffer())
	if (bytes.byteLength !== endInclusive - start + 1)
		throw new Error(`Range ${start}-${endInclusive} returned ${bytes.byteLength} bytes`)
	return { bytes, totalSize: Number(match[3]) }
}

async function writeSparseRange(file: Awaited<ReturnType<typeof open>>, offset: number, bytes: Uint8Array): Promise<void> {
	const { bytesWritten } = await file.write(bytes, 0, bytes.byteLength, offset)
	if (bytesWritten !== bytes.byteLength)
		throw new Error(`Short sparse archive write at ${offset}: ${bytesWritten}/${bytes.byteLength}`)
}

async function runSevenZipListing(sevenZip: string, archiveFile: string): Promise<SevenZipListingEntry[]> {
	const { stdout } = await execFileAsync(sevenZip, ['l', '-slt', archiveFile], { maxBuffer: 16 * 1024 * 1024 })
	return parseSevenZipTechnicalListing(stdout)
}

async function extractSevenZipMember(sevenZip: string, archiveFile: string, memberPath: string, outputDirectory: string): Promise<string> {
	await mkdir(outputDirectory, { recursive: true })
	await execFileAsync(sevenZip, ['e', '-y', `-o${outputDirectory}`, archiveFile, memberPath], { maxBuffer: 4 * 1024 * 1024 })
	return path.join(outputDirectory, path.basename(memberPath))
}

async function archiveMetadata(source: { archiveItem: string, archiveFile: string, archiveSize: number, archiveSha1: string }): Promise<void> {
	const url = `https://archive.org/metadata/${encodeURIComponent(source.archiveItem)}`
	const response = await fetch(url, { headers: { 'user-agent': 'maple-pod-resources/archived-wz-sync' } })
	if (!response.ok)
		throw new Error(`Archive.org metadata request returned HTTP ${response.status}`)
	const payload = await response.json() as { files?: ArchiveOrgMetadataFile[] }
	if (!Array.isArray(payload.files))
		throw new Error('Archive.org metadata response has no files array')
	validateArchiveOrgMetadata(payload.files, source)
}

export interface MaterializeSevenZipMemberTarget {
	logicalRegion: WorldMapRegion
	version: string | number
	providerRegion?: string
	providerVersion?: string
	archiveItem: string
	archiveFile: string
	archiveSize: number
	archiveSha1: string
	memberName: string
	memberPath: string
	expectedSha256?: string | null
	expectedSize?: number | null
	expectedCrc?: string | null
	expectedPackedBlock?: ArchivedWzPackedBlockExpectation | null
	mapleVersion?: ArchivedWzMapleVersion
}

export interface InspectArchivedSevenZipMemberOptions {
	archiveUrl?: string
	archiveBaseUrl?: string
	sevenZip?: string
	fetchRange?: RangeFetcher
	verifyArchiveMetadata?: boolean
	maxPackedBlockBytes?: number
}

export interface MaterializeSevenZipMemberOptions extends InspectArchivedSevenZipMemberOptions {
	outputDirectory?: string
}

export interface ArchivedSevenZipMemberPlan {
	target: MaterializeSevenZipMemberTarget
	archiveUrl: string
	archiveSize: number
	archiveSha1: string
	memberName: string
	memberPath: string
	memberSize: number | null
	memberCrc: string | null
	packedBlock: {
		block: number
		offset: number
		size: number
		sharedMembers: readonly string[]
	}
	listing: SevenZipListingEntry
}

export interface MaterializedSevenZipMemberResult {
	bytes: Uint8Array
	extractedPath: string
	provenance: ArchivedWzMemberProvenance
}

interface PreparedSparseArchivePlanning {
	archiveUrl: string
	sparseArchive: string
	normalizedMemberPath: string
	memberBlock: LocatedSevenZipMemberBlock
	fetchVerifiedRange: (start: number, endInclusive: number, segmentName: string) => Promise<Uint8Array>
}

async function prepareSparseSevenZipArchive(
	target: MaterializeSevenZipMemberTarget,
	options: InspectArchivedSevenZipMemberOptions,
	workDir: string,
): Promise<PreparedSparseArchivePlanning> {
	if (typeof target.memberName !== 'string' || !/^[A-Za-z0-9][\w.-]*$/u.test(target.memberName.trim()))
		throw new Error(`Invalid target member name: ${String(target.memberName)}`)

	const normalizedMemberPath = normalizeMemberPath(target.memberPath)
	if (path.basename(normalizedMemberPath) !== target.memberName) {
		throw new Error(
			`Target memberName "${target.memberName}" does not match basename of memberPath "${normalizedMemberPath}"`,
		)
	}

	if (typeof target.archiveFile !== 'string' || !/^[A-Za-z0-9][\w.-]*$/u.test(target.archiveFile.trim()))
		throw new Error(`Invalid target archive file: ${String(target.archiveFile)}`)

	if (typeof target.archiveItem !== 'string' || target.archiveItem.trim().length === 0 || target.archiveItem.includes('/') || target.archiveItem.includes('\\'))
		throw new Error(`Invalid target archive item: ${String(target.archiveItem)}`)

	if (typeof target.archiveSize !== 'number' || !Number.isSafeInteger(target.archiveSize) || target.archiveSize <= SEVEN_Z_START_HEADER_SIZE)
		throw new Error(`Invalid target archive size: ${String(target.archiveSize)}`)

	if (typeof target.archiveSha1 !== 'string' || !/^[0-9a-f]{40}$/iu.test(target.archiveSha1.trim()))
		throw new Error(`Invalid target archive SHA-1: ${String(target.archiveSha1)}`)

	if (target.expectedSha256 != null && (typeof target.expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/iu.test(target.expectedSha256.trim())))
		throw new Error(`Invalid expected SHA-256: ${String(target.expectedSha256)}`)

	if (target.expectedSize != null && (typeof target.expectedSize !== 'number' || !Number.isSafeInteger(target.expectedSize) || target.expectedSize < 0))
		throw new Error(`Invalid expected member size: ${String(target.expectedSize)}`)

	if (target.expectedCrc != null && (typeof target.expectedCrc !== 'string' || !/^[0-9a-f]{1,8}$/iu.test(target.expectedCrc.trim())))
		throw new Error(`Invalid expected member CRC: ${String(target.expectedCrc)}`)

	if (target.expectedPackedBlock != null) {
		const { blockNumber, packedSize, sharedMembers } = target.expectedPackedBlock
		if (typeof blockNumber !== 'number' || !Number.isSafeInteger(blockNumber) || blockNumber < 0)
			throw new Error(`Invalid expected packed block number: ${String(blockNumber)}`)
		if (typeof packedSize !== 'number' || !Number.isSafeInteger(packedSize) || packedSize <= 0)
			throw new Error(`Invalid expected packed block size: ${String(packedSize)}`)
		if (sharedMembers != null && (!Array.isArray(sharedMembers) || sharedMembers.some(m => typeof m !== 'string' || m.trim().length === 0)))
			throw new Error('Invalid expected shared members: must be an array of non-empty strings')
	}

	if (options.verifyArchiveMetadata !== false)
		await archiveMetadata(target)

	const rangeFetcher = options.fetchRange ?? fetchHttpRange
	const archiveBaseUrl = options.archiveBaseUrl ?? `https://archive.org/download/${encodeURIComponent(target.archiveItem)}`
	const archiveUrl = options.archiveUrl ?? `${archiveBaseUrl}/${encodeURIComponent(target.archiveFile)}`

	const fetchVerifiedRange = async (start: number, endInclusive: number, segmentName: string): Promise<Uint8Array> => {
		const response = await rangeFetcher(archiveUrl, start, endInclusive)
		if (response.totalSize !== target.archiveSize) {
			throw new Error(
				`Archive size mismatch while fetching ${segmentName} for ${target.archiveFile}: expected ${target.archiveSize}, got ${response.totalSize}`,
			)
		}
		return response.bytes
	}

	const startBytes = await fetchVerifiedRange(0, SEVEN_Z_START_HEADER_SIZE - 1, 'start header')
	const parsedStart = parseSevenZipStartHeader(startBytes)
	if (parsedStart.nextHeaderAbsoluteOffset + parsedStart.nextHeaderSize > target.archiveSize)
		throw new Error(`7z next header range exceeds archive boundary: ${parsedStart.nextHeaderAbsoluteOffset + parsedStart.nextHeaderSize} > ${target.archiveSize}`)

	const nextHeaderBytes = await fetchVerifiedRange(
		parsedStart.nextHeaderAbsoluteOffset,
		parsedStart.nextHeaderAbsoluteOffset + parsedStart.nextHeaderSize - 1,
		'next header',
	)
	let encodedHeaderBytes: Uint8Array | null = null
	let encodedHeaderOffset = 0
	if (nextHeaderBytes.length > 0 && nextHeaderBytes[0] === 0x17) {
		const encodedHeader = parseEncodedHeaderPackedRange(nextHeaderBytes)
		if (encodedHeader.offset + encodedHeader.size > target.archiveSize)
			throw new Error(`7z encoded header stream exceeds archive boundary: ${encodedHeader.offset + encodedHeader.size} > ${target.archiveSize}`)
		encodedHeaderBytes = await fetchVerifiedRange(
			encodedHeader.offset,
			encodedHeader.offset + encodedHeader.size - 1,
			'encoded header',
		)
		encodedHeaderOffset = encodedHeader.offset
	}
	else if (nextHeaderBytes.length > 0 && nextHeaderBytes[0] === 0x01) {
		// Unencoded header (common in smaller archives and uncompressed headers)
	}
	else {
		throw new Error(`Unsupported 7z next-header ID: 0x${nextHeaderBytes[0]?.toString(16) ?? 'empty'}`)
	}

	const sparseArchive = path.join(workDir, target.archiveFile)
	const sparse = await open(sparseArchive, 'w+')
	try {
		await sparse.truncate(target.archiveSize)
		await writeSparseRange(sparse, 0, startBytes)
		if (encodedHeaderBytes != null)
			await writeSparseRange(sparse, encodedHeaderOffset, encodedHeaderBytes)
		await writeSparseRange(sparse, parsedStart.nextHeaderAbsoluteOffset, nextHeaderBytes)
	}
	finally {
		await sparse.close()
	}

	const sevenZip = options.sevenZip ?? '7zz'
	const entries = await runSevenZipListing(sevenZip, sparseArchive)
	const memberBlock = locateSevenZipMemberBlock(entries, normalizedMemberPath, { archiveSize: target.archiveSize })

	// Enforce expected technical-listing size before block download
	if (target.expectedSize != null) {
		if (memberBlock.member.size == null) {
			throw new Error(
				`${target.memberName} technical listing is missing size for ${target.logicalRegion}/${target.version}`,
			)
		}
		if (memberBlock.member.size !== target.expectedSize) {
			throw new Error(
				`${target.memberName} size mismatch for ${target.logicalRegion}/${target.version}: expected ${target.expectedSize}, got ${memberBlock.member.size}`,
			)
		}
	}

	// Enforce expected technical-listing CRC before block download (case-insensitive)
	if (target.expectedCrc != null) {
		if (memberBlock.member.crc == null) {
			throw new Error(
				`${target.memberName} technical listing is missing CRC for ${target.logicalRegion}/${target.version}`,
			)
		}
		const expectedNormalizedCrc = target.expectedCrc.trim().toUpperCase()
		const actualNormalizedCrc = memberBlock.member.crc.trim().toUpperCase()
		if (actualNormalizedCrc !== expectedNormalizedCrc) {
			throw new Error(
				`${target.memberName} CRC mismatch for ${target.logicalRegion}/${target.version}: expected ${expectedNormalizedCrc}, got ${actualNormalizedCrc}`,
			)
		}
	}

	// Enforce expected packed-block expectations before block download
	if (target.expectedPackedBlock != null) {
		const { blockNumber, packedSize, sharedMembers } = target.expectedPackedBlock
		if (memberBlock.block !== blockNumber) {
			throw new Error(
				`${target.memberName} packed block mismatch for ${target.logicalRegion}/${target.version}: expected block ${blockNumber}, got ${memberBlock.block}`,
			)
		}
		if (memberBlock.size !== packedSize) {
			throw new Error(
				`${target.memberName} packed block size mismatch for ${target.logicalRegion}/${target.version}: expected packed size ${packedSize}, got ${memberBlock.size}`,
			)
		}
		if (sharedMembers != null) {
			const expectedMembers = [...sharedMembers].map(normalizeMemberPath).sort()
			const actualMembers = [...memberBlock.sharedMembers].map(normalizeMemberPath).sort()
			const matches = expectedMembers.length === actualMembers.length
				&& expectedMembers.every((member, index) => member === actualMembers[index])
			if (!matches) {
				throw new Error(
					`${target.memberName} shared members mismatch for ${target.logicalRegion}/${target.version}: expected [${expectedMembers.join(', ')}], got [${actualMembers.join(', ')}]`,
				)
			}
		}
	}

	// Enforce safety budget if configured
	if (options.maxPackedBlockBytes != null) {
		if (typeof options.maxPackedBlockBytes !== 'number' || !Number.isSafeInteger(options.maxPackedBlockBytes) || options.maxPackedBlockBytes < 0) {
			throw new Error(`Invalid maxPackedBlockBytes budget: ${String(options.maxPackedBlockBytes)}`)
		}
		if (memberBlock.size > options.maxPackedBlockBytes) {
			throw new Error(
				`${target.memberName} packed block size ${memberBlock.size} exceeds safety budget of ${options.maxPackedBlockBytes} bytes for ${target.logicalRegion}/${target.version}`,
			)
		}
	}

	return {
		archiveUrl,
		sparseArchive,
		normalizedMemberPath,
		memberBlock,
		fetchVerifiedRange,
	}
}

export async function inspectArchivedSevenZipMemberPlan(
	target: MaterializeSevenZipMemberTarget,
	options: InspectArchivedSevenZipMemberOptions = {},
): Promise<ArchivedSevenZipMemberPlan> {
	const normalizedMemberPath = normalizeMemberPath(target.memberPath)
	const work = await mkdtemp(path.join(tmpdir(), `maple-pod-7z-plan-${target.logicalRegion.toLowerCase()}-${target.version}-${path.basename(normalizedMemberPath)}-`))
	try {
		const prepared = await prepareSparseSevenZipArchive(target, options, work)
		return {
			target,
			archiveUrl: prepared.archiveUrl,
			archiveSize: target.archiveSize,
			archiveSha1: target.archiveSha1,
			memberName: target.memberName,
			memberPath: prepared.normalizedMemberPath,
			memberSize: prepared.memberBlock.member.size,
			memberCrc: prepared.memberBlock.member.crc,
			packedBlock: {
				block: prepared.memberBlock.block,
				offset: prepared.memberBlock.offset,
				size: prepared.memberBlock.size,
				sharedMembers: prepared.memberBlock.sharedMembers,
			},
			listing: prepared.memberBlock.member,
		}
	}
	finally {
		await rm(work, { recursive: true, force: true })
	}
}

export async function materializeArchivedSevenZipMember(
	target: MaterializeSevenZipMemberTarget,
	options: MaterializeSevenZipMemberOptions = {},
): Promise<MaterializedSevenZipMemberResult> {
	const normalizedMemberPath = normalizeMemberPath(target.memberPath)
	const work = await mkdtemp(path.join(tmpdir(), `maple-pod-7z-${target.logicalRegion.toLowerCase()}-${target.version}-${path.basename(normalizedMemberPath)}-`))
	try {
		const prepared = await prepareSparseSevenZipArchive(target, options, work)
		const { memberBlock, sparseArchive, archiveUrl, fetchVerifiedRange } = prepared

		const blockBytes = await fetchVerifiedRange(
			memberBlock.offset,
			memberBlock.offset + memberBlock.size - 1,
			'payload block',
		)
		const sparseWithBlock = await open(sparseArchive, 'r+')
		try {
			await writeSparseRange(sparseWithBlock, memberBlock.offset, blockBytes)
		}
		finally {
			await sparseWithBlock.close()
		}

		const sevenZip = options.sevenZip ?? '7zz'
		const extractDir = path.join(work, 'extracted')
		const extracted = await extractSevenZipMember(sevenZip, sparseArchive, normalizedMemberPath, extractDir)
		const memberBytes = await readFile(extracted)
		const computedSha256 = sha256(memberBytes)
		if (target.expectedSha256 != null && computedSha256 !== target.expectedSha256)
			throw new Error(`${target.memberName} SHA-256 mismatch for ${target.logicalRegion}/${target.version}: expected ${target.expectedSha256}, got ${computedSha256}`)

		let finalExtractedPath = extracted
		if (options.outputDirectory != null) {
			await mkdir(options.outputDirectory, { recursive: true })
			finalExtractedPath = path.join(options.outputDirectory, path.basename(normalizedMemberPath))
			await writeFile(finalExtractedPath, memberBytes)
		}

		const provenance: ArchivedWzMemberProvenance = {
			provider: 'archived-wz',
			logicalRegion: target.logicalRegion,
			version: String(target.version),
			providerRegion: target.providerRegion ?? target.logicalRegion,
			providerVersion: target.providerVersion ?? String(target.version),
			archiveItem: target.archiveItem,
			archiveFile: target.archiveFile,
			archiveUrl,
			archiveSize: target.archiveSize,
			archiveSha1: target.archiveSha1,
			memberName: target.memberName,
			memberPath: normalizedMemberPath,
			memberSize: memberBlock.member.size,
			memberCrc: memberBlock.member.crc,
			memberSha256: computedSha256,
			packedBlock: {
				offset: memberBlock.offset,
				size: memberBlock.size,
				block: memberBlock.block,
			},
			mapleVersion: target.mapleVersion,
			wzFile: target.memberName,
			wzSha256: computedSha256,
		}

		return {
			bytes: memberBytes,
			extractedPath: finalExtractedPath,
			provenance,
		}
	}
	finally {
		await rm(work, { recursive: true, force: true })
	}
}

export interface SyncArchivedStringWzOptions {
	workspace?: string
	sevenZip?: string
	fetchRange?: RangeFetcher
	verifyArchiveMetadata?: boolean
}

export async function syncArchivedStringWz(
	region: WorldMapRegion,
	version: string | number,
	options: SyncArchivedStringWzOptions = {},
): Promise<ArchivedStringWzCacheManifest> {
	const source = archivedStringWzSource(region, version)
	if (source == null)
		throw new Error(`No archived String.wz source is configured for ${region}/${version}`)
	const workspace = options.workspace ?? path.resolve(process.cwd())
	const cacheDirectory = archivedStringWzCacheDirectory(workspace, source)
	const cachedWz = path.join(cacheDirectory, 'String.wz')
	const cachedManifest = path.join(cacheDirectory, 'manifest.json')
	try {
		const bytes = await readFile(cachedWz)
		if (sha256(bytes) === source.memberSha256) {
			const parsed = JSON.parse(await readFile(cachedManifest, 'utf8')) as ArchivedStringWzCacheManifest
			if (parsed.provenance.wzSha256 === source.memberSha256)
				return parsed
		}
	}
	catch {
		// Missing/stale cache is materialized below.
	}

	const materialized = await materializeArchivedSevenZipMember({
		logicalRegion: source.logicalRegion,
		version: String(source.version),
		providerRegion: source.providerRegion,
		providerVersion: source.providerVersion,
		archiveItem: source.archiveItem,
		archiveFile: source.archiveFile,
		archiveSize: source.archiveSize,
		archiveSha1: source.archiveSha1,
		memberName: source.memberName,
		memberPath: source.memberPath,
		expectedSha256: source.memberSha256,
		expectedSize: source.memberSize,
		expectedCrc: source.memberCrc,
		expectedPackedBlock: source.expectedPackedBlock,
		mapleVersion: source.mapleVersion,
	}, {
		sevenZip: options.sevenZip,
		fetchRange: options.fetchRange,
		verifyArchiveMetadata: options.verifyArchiveMetadata,
		outputDirectory: cacheDirectory,
	})

	const worldMapNames = await parseArchivedWorldMapNames(materialized.extractedPath, source.version, source.mapleVersion)
	const manifest: ArchivedStringWzCacheManifest = {
		schemaVersion: 1,
		provenance: {
			...materialized.provenance,
			wzFile: 'String.wz',
			wzSha256: materialized.provenance.memberSha256,
		},
		worldMapNames,
	}
	await writeFile(cachedManifest, `${JSON.stringify(manifest, null, 2)}\n`)
	return manifest
}

export interface SyncArchivedMapWzOptions {
	workspace?: string
	archiveBaseUrl?: string
	archiveUrl?: string
	sevenZip?: string
	fetchRange?: RangeFetcher
	verifyArchiveMetadata?: boolean
	maxPackedBlockBytes?: number
	source?: ArchivedWzMemberSourceDefinition
}

export async function syncArchivedMapWz(
	region: WorldMapRegion,
	version: string | number,
	options: SyncArchivedMapWzOptions = {},
): Promise<ArchivedWzMemberCacheManifest> {
	const source = options.source ?? archivedMapWzSource(region, version)
	if (source == null)
		throw new Error(`No archived Map.wz source is configured for ${region}/${version}`)
	const workspace = options.workspace ?? path.resolve(process.cwd())
	const cacheDirectory = archivedStringWzCacheDirectory(workspace, source)
	const cachedWz = path.join(cacheDirectory, 'Map.wz')
	const cachedManifest = path.join(cacheDirectory, 'manifest-map.json')
	try {
		const bytes = await readFile(cachedWz)
		const computed = sha256(bytes)
		if (source.memberSha256 == null || computed === source.memberSha256) {
			const parsed = JSON.parse(await readFile(cachedManifest, 'utf8')) as ArchivedWzMemberCacheManifest
			if (parsed.provenance.memberSha256 === computed || parsed.provenance.wzSha256 === computed)
				return parsed
		}
	}
	catch {
		// Missing/stale cache is materialized below.
	}

	const materialized = await materializeArchivedSevenZipMember({
		logicalRegion: source.logicalRegion,
		version: String(source.version),
		providerRegion: source.providerRegion,
		providerVersion: source.providerVersion,
		archiveItem: source.archiveItem,
		archiveFile: source.archiveFile,
		archiveSize: source.archiveSize,
		archiveSha1: source.archiveSha1,
		memberName: source.memberName,
		memberPath: source.memberPath,
		expectedSha256: source.memberSha256,
		expectedSize: source.memberSize,
		expectedCrc: source.memberCrc,
		expectedPackedBlock: source.expectedPackedBlock,
		mapleVersion: source.mapleVersion,
	}, {
		archiveBaseUrl: options.archiveBaseUrl,
		archiveUrl: options.archiveUrl,
		sevenZip: options.sevenZip,
		fetchRange: options.fetchRange,
		verifyArchiveMetadata: options.verifyArchiveMetadata,
		outputDirectory: cacheDirectory,
		maxPackedBlockBytes: options.maxPackedBlockBytes ?? (source.expectedPackedBlock?.packedSize ?? undefined),
	})

	const manifest: ArchivedWzMemberCacheManifest = {
		schemaVersion: 1,
		provenance: materialized.provenance,
	}
	await writeFile(cachedManifest, `${JSON.stringify(manifest, null, 2)}\n`)
	return manifest
}

export function parseArchivedWzSyncRequest(value: string): { region: WorldMapRegion, version: string } {
	const match = /^(GMS|TWMS)\/([A-Za-z0-9][\w.-]*)$/u.exec(value)
	if (match == null || match[1] == null || match[2] == null || match[2] === 'latest')
		throw new Error(`Invalid archived WZ sync request: ${value}`)
	return { region: match[1] as WorldMapRegion, version: match[2] }
}

if (process.argv[1] != null && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	assertRunningInContainer('pnpm run world-map:sync')
	const request = process.argv.find(argument => argument.startsWith('--snapshot='))
	if (request == null) {
		console.error('Usage: pnpm run world-map:sync -- --snapshot=TWMS/158 [--inspect|--plan] [--member=Map.wz]')
		process.exitCode = 1
	}
	else {
		const { region, version } = parseArchivedWzSyncRequest(request.slice('--snapshot='.length))
		const isPlan = process.argv.includes('--inspect') || process.argv.includes('--plan')
		const memberArg = process.argv.find(argument => argument.startsWith('--member='))
		const memberName = memberArg != null ? memberArg.slice('--member='.length) : 'String.wz'

		if (isPlan) {
			const source = archivedWzMemberSource(region, version, memberName)
			if (source == null) {
				console.error(`No source configured for ${region}/${version} ${memberName}`)
				process.exitCode = 1
			}
			else {
				inspectArchivedSevenZipMemberPlan(source)
					.then((plan) => {
						console.log(`Inspected ${region}/${version} ${memberName}:`)
						console.log(`  Member size: ${plan.memberSize}`)
						console.log(`  Member CRC: ${plan.memberCrc}`)
						console.log(`  Packed block: ${plan.packedBlock.block}`)
						console.log(`  Packed block size: ${plan.packedBlock.size}`)
						console.log(`  Packed block offset: ${plan.packedBlock.offset}`)
						console.log(`  Shared members: ${plan.packedBlock.sharedMembers.join(', ')}`)
					})
					.catch((error) => {
						console.error(error instanceof Error ? error.message : String(error))
						process.exitCode = 1
					})
			}
		}
		else if (memberName === 'Map.wz') {
			syncArchivedMapWz(region, version)
				.then((manifest) => {
					console.log(`Synced ${region}/${version} Map.wz`)
					console.log(`  SHA-256: ${manifest.provenance.memberSha256}`)
					console.log(`  Member size: ${manifest.provenance.memberSize}`)
				})
				.catch((error) => {
					console.error(error instanceof Error ? error.message : String(error))
					process.exitCode = 1
				})
		}
		else if (memberName === 'String.wz') {
			syncArchivedStringWz(region, version)
				.then((manifest) => {
					console.log(`Synced ${region}/${version} String.wz`)
					console.log(`  SHA-256: ${manifest.provenance.wzSha256}`)
					console.log(`  WorldMap names: ${Object.keys(manifest.worldMapNames).length}`)
				})
				.catch((error) => {
					console.error(error instanceof Error ? error.message : String(error))
					process.exitCode = 1
				})
		}
		else {
			console.error(`Unsupported member: ${memberName}`)
			process.exitCode = 1
		}
	}
}
