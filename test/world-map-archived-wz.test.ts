/* eslint-disable test/no-import-node-test */
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { init as initWz, MapleVersion, WzFile, WzProperty } from 'libwz'
import sharp from 'sharp'
import { MapleStoryIoClient } from '../world-map/acquire'
import {
	acquireArchivedWzWorldMapGraph,
	archivedMapWzSource,
	archivedStringWzCacheDirectory,
	archivedStringWzSource,
	archivedWzMemberCacheDirectory,
	archivedWzMemberSource,
	configuredArchivedWzPublishedProvenance,
	findCachedArchivedWzMember,
	inspectArchivedSevenZipMemberPlan,
	locateSevenZipMemberBlock,
	materializeArchivedSevenZipMember,
	normalizeMemberPath,
	parseArchivedLibwzPatchVersion,
	parseArchivedMapStrings,
	parseArchivedMapWz,
	parseArchivedWorldMapNames,
	parseArchivedWzSyncRequest,
	parseEncodedHeaderPackedRange,
	parseSevenZipStartHeader,
	parseSevenZipTechnicalListing,
	readCachedArchivedWzProvenance,
	readSevenZipUint,
	sha256File,
	syncArchivedMapWz,
	validateArchiveOrgMetadata,
	verifyArchivedWzPublishedProvenance,
} from '../world-map/archived-wz'
import { resolveWorldMapGenerationSnapshot, runWorldMapGeneration } from '../world-map/generate'
import { curatedWorldMapSnapshotEntries } from '../world-map/snapshot'

const execFileAsync = promisify(execFile)

function sha1(bytes: Uint8Array): string {
	return createHash('sha1')
		.update(bytes)
		.digest('hex')
}

function sha256(bytes: Uint8Array): string {
	return createHash('sha256')
		.update(bytes)
		.digest('hex')
}

test('hashes materialized WZ files incrementally', async () => {
	const tempDir = await mkdtemp(path.join(tmpdir(), 'archived-wz-sha256-'))
	try {
		const file = path.join(tempDir, 'Map.wz')
		const bytes = Buffer.from('streamed-map-wz-content')
		await writeFile(file, bytes)
		assert.equal(await sha256File(file), sha256(bytes))
	}
	finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('rejects archived-WZ paths with mismatched registry provenance or bytes', async () => {
	const tempDir = await mkdtemp(path.join(tmpdir(), 'archived-wz-provenance-'))
	try {
		const stringWzFile = path.join(tempDir, 'String.wz')
		const mapWzFile = path.join(tempDir, 'Map.wz')
		await writeFile(stringWzFile, 'caller-string-bytes')
		await writeFile(mapWzFile, 'caller-map-bytes')
		const configured = configuredArchivedWzPublishedProvenance('TWMS', '158')!
		const mismatched = { ...configured, archiveItem: 'caller-selected-archive' }
		await assert.rejects(
			verifyArchivedWzPublishedProvenance({ stringWzFile, mapWzFile }, mismatched, configured),
			/configured exact registry identity or hashes/,
		)
		await assert.rejects(
			verifyArchivedWzPublishedProvenance({ stringWzFile, mapWzFile }, configured, configured),
			/String\.wz SHA-256 does not match configured archived-WZ registry/,
		)
	}
	finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('pins the selected TWMS archived String.wz and Map.wz sources and hashes', () => {
	const source = archivedStringWzSource('TWMS', 158)!
	assert.equal(source.archiveItem, 'twms-maplestory')
	assert.equal(source.archiveFile, 'v158.7z')
	assert.equal(source.archiveSize, 4_641_697_742)
	assert.equal(source.archiveSha1, '84a43fda9844e9bc6c0bfb26976115e6804bd98d')
	assert.equal(source.memberName, 'String.wz')
	assert.equal(source.memberPath, 'v158/String.wz')
	assert.equal(source.memberSha256, '6ddb8cea06e2c187409ff6a9e39126b8cde0a6d9c3373e87d73cff9910760bd0')
	assert.equal(source.memberSize, 5_152_535)
	assert.equal(source.memberCrc, '159DE60F')
	assert.deepEqual(source.expectedPackedBlock, {
		blockNumber: 17,
		packedSize: 1_921_132,
		sharedMembers: ['v158/String.wz', 'v158/TamingMob.wz'],
	})
	assert.equal(source.mapleVersion, 'EMS')
	assert.equal(archivedStringWzSource('GMS', 158), null)
	assert.equal(archivedStringWzSource('TWMS', 157), null)
	assert.deepEqual(parseArchivedWzSyncRequest('TWMS/171'), { region: 'TWMS', version: '171' })
	assert.throws(() => parseArchivedWzSyncRequest('TWMS/latest'), /Invalid archived WZ sync request/)
	assert.equal(archivedStringWzCacheDirectory('/workspace', source), '/workspace/.cache/world-map/archived-wz/TWMS/158')
	assert.equal(archivedWzMemberCacheDirectory('/workspace', source, 'Map.wz'), '/workspace/.cache/world-map/archived-wz/TWMS/158/Map.wz')

	// Registry support for verified Map.wz member metadata:
	const map124 = archivedMapWzSource('TWMS', '124')!
	assert.equal(map124.memberName, 'Map.wz')
	assert.equal(map124.memberPath, 'v124/Map.wz')
	assert.equal(map124.memberSha256, 'bfc0190615ca19527b5aa12c3e0fc6c297d574d1e8341a12a2508c32d2ffaf99')
	assert.equal(map124.memberSize, 814_504_293)
	assert.equal(map124.memberCrc, '4165D8CF')
	assert.deepEqual(map124.expectedPackedBlock, {
		blockNumber: 4,
		packedSize: 723_290_006,
		sharedMembers: ['v124/Map.wz'],
	})

	const map158 = archivedMapWzSource('TWMS', '158')!
	assert.equal(map158.memberName, 'Map.wz')
	assert.equal(map158.memberPath, 'v158/Map.wz')
	assert.equal(map158.memberSha256, '65330b5837a9511ab4e59d90c1e52a806f9bc7ab9970afeae7027b45ac26e5e6')
	assert.equal(map158.memberSize, 1_284_050_942)
	assert.equal(map158.memberCrc, '5D2B3257')
	assert.deepEqual(map158.expectedPackedBlock, {
		blockNumber: 7,
		packedSize: 1_171_302_698,
		sharedMembers: ['v158/Map.wz'],
	})

	const map171 = archivedMapWzSource('TWMS', '171')!
	assert.equal(map171.memberName, 'Map.wz')
	assert.equal(map171.memberPath, 'v171/Map.wz')
	assert.equal(map171.memberSha256, '7cfadbd6b154563f5bdc4f68d7505f789c444597ac24dbd597d696bc76d8d955')
	assert.equal(map171.memberSize, 1_777_450_234)
	assert.equal(map171.memberCrc, '51A1AB13')
	assert.deepEqual(map171.expectedPackedBlock, {
		blockNumber: 7,
		packedSize: 1_623_634_593,
		sharedMembers: ['v171/Map.wz'],
	})

	assert.deepEqual(archivedWzMemberSource('TWMS', 158, 'String.wz'), source)
	assert.deepEqual(archivedWzMemberSource('TWMS', 158, 'Map.wz'), map158)
	assert.equal(archivedWzMemberSource('TWMS', 158, 'Unknown.wz'), null)
	assert.equal(archivedWzMemberSource('GMS', 270, 'Map.wz'), null)

	// Invariants: TWMS 124/158/171 must NOT be selectable merely because generic materializer exists
	const entries = curatedWorldMapSnapshotEntries()
	for (const version of ['124', '158', '171']) {
		const entry = entries.find(e => e.id === `TWMS/${version}`)!
		assert.equal(entry.selectable, false, `TWMS/${version} should not be selectable before generation`)
		assert.equal(entry.recommended, true, `TWMS/${version} should be recommended in public baseline`)
	}
})

test('parses 7z technical listing into structured entries with size, crc, block, and packed size', () => {
	const listing = `
Path = v158\\String.wz
Size = 500
Packed Size = 200
Block = 1
CRC = A1B2C3D4

Path = ./v158/Map.wz
Size = 1000
Packed Size = 600
Block = 0
CRC = 12345678

Path = v158/NoSize.wz
Block = 2

Path = v158/NoBlock.wz
CRC = FFFFFFFF
`
	const entries = parseSevenZipTechnicalListing(listing)
	assert.equal(entries.length, 4)
	assert.deepEqual(entries[0], {
		path: 'v158/String.wz',
		size: 500,
		crc: 'A1B2C3D4',
		block: 1,
		packedSize: 200,
	})
	assert.deepEqual(entries[1], {
		path: 'v158/Map.wz',
		size: 1000,
		crc: '12345678',
		block: 0,
		packedSize: 600,
	})
	assert.deepEqual(entries[2], {
		path: 'v158/NoSize.wz',
		size: null,
		crc: null,
		block: 2,
		packedSize: null,
	})
	assert.deepEqual(entries[3], {
		path: 'v158/NoBlock.wz',
		size: null,
		crc: 'FFFFFFFF',
		block: null,
		packedSize: null,
	})

	assert.deepEqual(parseSevenZipTechnicalListing(''), [])
	assert.deepEqual(parseSevenZipTechnicalListing('   \n\n  '), [])

	// Skips archive container metadata header block
	const listingWithArchiveHeader = `
Path = /tmp/sample.7z
Type = 7z
Physical Size = 139
Headers Size = 130
Method = LZMA2:12
Solid = -
Blocks = 1

Path = v158/String.wz
Size = 500
Packed Size = 200
Block = 0
CRC = A1B2C3D4
`
	const filteredEntries = parseSevenZipTechnicalListing(listingWithArchiveHeader)
	assert.equal(filteredEntries.length, 1)
	assert.deepEqual(filteredEntries[0], {
		path: 'v158/String.wz',
		size: 500,
		crc: 'A1B2C3D4',
		block: 0,
		packedSize: 200,
	})
})

test('normalizes member paths and strictly rejects path traversal, absolute paths, UNC, drive letters, NUL, and empty segments', () => {
	assert.equal(normalizeMemberPath('v158/String.wz'), 'v158/String.wz')
	assert.equal(normalizeMemberPath('v158\\String.wz'), 'v158/String.wz')
	assert.equal(normalizeMemberPath('./v158/String.wz'), 'v158/String.wz')
	assert.equal(normalizeMemberPath('.\\v158\\String.wz'), 'v158/String.wz')
	assert.equal(normalizeMemberPath('sub/dir/Map.wz'), 'sub/dir/Map.wz')

	assert.throws(() => normalizeMemberPath(''), /Member path cannot be empty/)
	assert.throws(() => normalizeMemberPath('   '), /Member path cannot be empty/)
	assert.throws(() => normalizeMemberPath('./'), /Member path cannot be empty/)
	assert.throws(() => normalizeMemberPath('../String.wz'), /illegal path traversal/)
	assert.throws(() => normalizeMemberPath('v158/../../etc/passwd'), /illegal path traversal/)
	assert.throws(() => normalizeMemberPath('foo/../bar.wz'), /illegal path traversal/)
	assert.throws(() => normalizeMemberPath('..\\String.wz'), /illegal path traversal/)

	// Absolute POSIX and single-rooted paths
	assert.throws(() => normalizeMemberPath('/v158/String.wz'), /cannot be an absolute path/)
	assert.throws(() => normalizeMemberPath('\\v158\\String.wz'), /cannot be an absolute path/)
	assert.throws(() => normalizeMemberPath(String.raw`\v158\String.wz`), /cannot be an absolute path/)

	// Windows drive paths
	assert.throws(() => normalizeMemberPath('C:/v158/String.wz'), /cannot be a Windows drive path/)
	assert.throws(() => normalizeMemberPath('d:\\v158\\String.wz'), /cannot be a Windows drive path/)
	assert.throws(() => normalizeMemberPath(String.raw`C:\v158\String.wz`), /cannot be a Windows drive path/)

	// UNC paths
	assert.throws(() => normalizeMemberPath('//server/share/String.wz'), /cannot be a UNC path/)
	assert.throws(() => normalizeMemberPath('\\\\server\\share\\String.wz'), /cannot be a UNC path/)
	assert.throws(() => normalizeMemberPath(String.raw`\\server\share\String.wz`), /cannot be a UNC path/)

	// NUL byte: actual U+0000 character in source is rejected
	assert.throws(() => normalizeMemberPath('foo\0bar.wz'), /illegal NUL character/)
	assert.throws(() => normalizeMemberPath('v158/\0/String.wz'), /illegal NUL character/)

	// Literal backslash+zero is not NUL and normalizes separators as normal filename
	assert.equal(normalizeMemberPath('foo\\0bar.wz'), 'foo/0bar.wz')

	// Empty segments
	assert.throws(() => normalizeMemberPath('v158//String.wz'), /empty segments/)
	assert.throws(() => normalizeMemberPath('v158/String.wz/'), /empty segments/)
})

test('parseSevenZipTechnicalListing enforces safe integer limits for Size, Block, and Packed Size', () => {
	const maxSafe = String(Number.MAX_SAFE_INTEGER)
	const beyondSafe = String(BigInt(Number.MAX_SAFE_INTEGER) + 1n)

	const validSafeListing = `
Path = v158/Safe.wz
Size = ${maxSafe}
Packed Size = 1000
Block = 0
`
	const [entry] = parseSevenZipTechnicalListing(validSafeListing)
	assert.equal(entry?.size, Number.MAX_SAFE_INTEGER)
	assert.equal(entry?.packedSize, 1000)
	assert.equal(entry?.block, 0)

	const oversizeListing = `
Path = v158/Oversize.wz
Size = ${beyondSafe}
`
	assert.throws(
		() => parseSevenZipTechnicalListing(oversizeListing),
		/7z listing Size exceeds JavaScript safe integer range/,
	)

	const oversizeBlockListing = `
Path = v158/OversizeBlock.wz
Block = ${beyondSafe}
`
	assert.throws(
		() => parseSevenZipTechnicalListing(oversizeBlockListing),
		/7z listing Block exceeds JavaScript safe integer range/,
	)

	const oversizePackedSizeListing = `
Path = v158/OversizePacked.wz
Packed Size = ${beyondSafe}
`
	assert.throws(
		() => parseSevenZipTechnicalListing(oversizePackedSizeListing),
		/7z listing Packed Size exceeds JavaScript safe integer range/,
	)
})

test('maps 7z technical-listing block sizes to exact member byte ranges and tracks shared members', () => {
	const listing = `
Path = v158/Map.wz
Size = 1000
Packed Size = 600
Block = 0
CRC = AABBCCDD

Path = v158/String.wz
Size = 500
Packed Size = 200
Block = 1
CRC = 11223344

Path = v158/TamingMob.wz
Size = 50
Block = 1
CRC = 55667788

Path = v158/UI.wz
Size = 900
Packed Size = 700
Block = 2
`
	const entries = parseSevenZipTechnicalListing(listing)
	const block0 = locateSevenZipMemberBlock(entries, 'v158/Map.wz')
	assert.equal(block0.offset, 32)
	assert.equal(block0.size, 600)
	assert.equal(block0.block, 0)
	assert.deepEqual(block0.sharedMembers, ['v158/Map.wz'])
	assert.equal(block0.member.crc, 'AABBCCDD')

	const block1 = locateSevenZipMemberBlock(entries, 'v158/String.wz')
	assert.equal(block1.offset, 632)
	assert.equal(block1.size, 200)
	assert.equal(block1.block, 1)
	assert.deepEqual(block1.sharedMembers, ['v158/String.wz', 'v158/TamingMob.wz'])
	assert.equal(block1.member.crc, '11223344')

	// Path with alternative separators finds member
	const backslashLookup = locateSevenZipMemberBlock(entries, 'v158\\String.wz')
	assert.equal(backslashLookup.offset, 632)

	assert.throws(() => locateSevenZipMemberBlock(entries, 'v158/Nope.wz'), /does not contain member/)
})

test('rejects invalid or unexpected shared-block assumptions and block boundaries', () => {
	// Conflicting packed sizes on the same shared block
	const conflictingListing = `
Path = v158/String.wz
Packed Size = 200
Block = 1

Path = v158/TamingMob.wz
Packed Size = 300
Block = 1
`
	const conflictingEntries = parseSevenZipTechnicalListing(conflictingListing)
	assert.throws(
		() => locateSevenZipMemberBlock(conflictingEntries, 'v158/String.wz'),
		/conflicting packed sizes for block 1: 200 vs 300/,
	)

	// Missing preceding block in sequence (block 0 missing before block 1)
	const missingPrecedingListing = `
Path = v158/String.wz
Packed Size = 200
Block = 1
`
	const missingPrecedingEntries = parseSevenZipTechnicalListing(missingPrecedingListing)
	assert.throws(
		() => locateSevenZipMemberBlock(missingPrecedingEntries, 'v158/String.wz'),
		/missing packed size for preceding block 0 before block 1/,
	)

	// Block has no packed size
	const noPackedSizeListing = `
Path = v158/Map.wz
Block = 0
Packed Size = 100

Path = v158/String.wz
Block = 1
`
	const noPackedSizeEntries = parseSevenZipTechnicalListing(noPackedSizeListing)
	assert.throws(
		() => locateSevenZipMemberBlock(noPackedSizeEntries, 'v158/String.wz'),
		/does not provide packed size for block 1/,
	)

	// Member has no block attribute (e.g. empty directory or uncompressed single file)
	const noBlockListing = `
Path = v158/String.wz
Size = 500
`
	const noBlockEntries = parseSevenZipTechnicalListing(noBlockListing)
	assert.throws(
		() => locateSevenZipMemberBlock(noBlockEntries, 'v158/String.wz'),
		/does not identify a packed block/,
	)

	// Block range exceeds archive boundary
	const boundaryListing = `
Path = v158/String.wz
Block = 0
Packed Size = 500
`
	const boundaryEntries = parseSevenZipTechnicalListing(boundaryListing)
	assert.throws(
		() => locateSevenZipMemberBlock(boundaryEntries, 'v158/String.wz', { archiveSize: 500 }),
		/exceeds archive size 500/,
	)
})

test('validates Archive.org metadata against pinned size and SHA-1', () => {
	const source = archivedStringWzSource('TWMS', 124)!
	validateArchiveOrgMetadata([{ name: 'v124.7z', size: String(source.archiveSize), sha1: source.archiveSha1.toUpperCase() }], source)
	validateArchiveOrgMetadata([{ name: 'v124.7z', size: String(source.archiveSize), sha1: source.archiveSha1.toLowerCase() }], source)
	assert.throws(() => validateArchiveOrgMetadata([], source), /metadata is missing v124.7z/)
	assert.throws(() => validateArchiveOrgMetadata([{ name: 'v124.7z', size: '1', sha1: source.archiveSha1 }], source), /size mismatch/)
	assert.throws(() => validateArchiveOrgMetadata([{ name: 'v124.7z', size: String(source.archiveSize), sha1: '0'.repeat(40) }], source), /SHA-1 mismatch/)
})

test('parses the known Archive.org 7z start and encoded-header ranges without downloading payload blocks', () => {
	const start = Buffer.from('377abcaf271c0004ae45976687afaa140100000027000000000000001a1692a6', 'hex')
	const header = parseSevenZipStartHeader(start)
	assert.deepEqual(header, {
		nextHeaderOffset: 4_641_697_671,
		nextHeaderSize: 39,
		nextHeaderAbsoluteOffset: 4_641_697_703,
	})
	const next = Buffer.from('1706f15ea2aa1401098d2900070b01000123030101055d006000000cc0da400a', 'hex')
	assert.deepEqual(parseEncodedHeaderPackedRange(next), { offset: 4_641_694_334, size: 3_369 })
	assert.throws(() => parseSevenZipStartHeader(new Uint8Array(31)), /exactly 32 bytes/)
	assert.throws(() => parseEncodedHeaderPackedRange(Uint8Array.of(1, 2, 3, 4, 5, 6)), /Unsupported 7z next-header shape/)
})

test('decodes 7z variable unsigned integers and rejects truncated values', () => {
	assert.deepEqual(readSevenZipUint(Uint8Array.of(0x7F), 0), { value: 127, nextOffset: 1 })
	assert.deepEqual(readSevenZipUint(Uint8Array.of(0x81, 0x34), 0), { value: 308, nextOffset: 2 })
	assert.throws(() => readSevenZipUint(Uint8Array.of(0xFF), 0), /Truncated 7z uint/)
})

test('parseArchivedLibwzPatchVersion converts integer versions locally and explicitly rejects non-integers', () => {
	assert.equal(parseArchivedLibwzPatchVersion(158), 158)
	assert.equal(parseArchivedLibwzPatchVersion('158'), 158)
	assert.equal(parseArchivedLibwzPatchVersion('124'), 124)
	assert.equal(parseArchivedLibwzPatchVersion(' 171 '), 171)

	assert.throws(() => parseArchivedLibwzPatchVersion('40B'), /requires positive integer patch version, got: 40B/)
	assert.throws(() => parseArchivedLibwzPatchVersion('93T'), /requires positive integer patch version, got: 93T/)
	assert.throws(() => parseArchivedLibwzPatchVersion('1.2.3'), /requires positive integer patch version, got: 1.2.3/)
	assert.throws(() => parseArchivedLibwzPatchVersion('latest'), /requires positive integer patch version, got: latest/)
	assert.throws(() => parseArchivedLibwzPatchVersion(''), /requires positive integer patch version/)
	assert.throws(() => parseArchivedLibwzPatchVersion('0'), /requires positive integer patch version/)
	assert.throws(() => parseArchivedLibwzPatchVersion(0), /requires positive integer patch version/)
	assert.throws(() => parseArchivedLibwzPatchVersion(-5), /requires positive integer patch version/)
	assert.throws(() => parseArchivedLibwzPatchVersion(1.5), /requires positive integer patch version/)
	assert.throws(() => parseArchivedLibwzPatchVersion(Number.NaN), /requires positive integer patch version/)
})

test('reads authoritative WorldMap names from a synthetic String.wz with explicit patch version', async () => {
	await initWz({ forceWasm: true })
	const root = await mkdtemp(path.join(tmpdir(), 'world-map-libwz-fixture-'))
	const filePath = path.join(root, 'String.wz')
	const file = WzFile.create(158, MapleVersion.EMS)
	try {
		const image = file.getWzDirectory()!.createImage('WorldMap.img')
		for (const [key, value] of [['0', '楓之谷'], ['010', '維多利亞島'], ['153', '克梅勒茲']] as const) {
			const entry = WzProperty.createSub(key)
			entry.addProperty(WzProperty.createString('name', value))
			image.addProperty(entry)
		}
		file.saveToDisk(filePath)
	}
	finally {
		file.close()
	}
	try {
		assert.deepEqual(await parseArchivedWorldMapNames(filePath, '158', 'EMS'), {
			WorldMap: '楓之谷',
			WorldMap010: '維多利亞島',
			WorldMap153: '克梅勒茲',
		})
		assert.deepEqual(await parseArchivedWorldMapNames(filePath, 158, 'EMS'), {
			WorldMap: '楓之谷',
			WorldMap010: '維多利亞島',
			WorldMap153: '克梅勒茲',
		})
		await assert.rejects(
			parseArchivedWorldMapNames(filePath, '40B', 'EMS'),
			/requires positive integer patch version, got: 40B/,
		)
	}
	finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('materializes 7z member offline with exact provenance and verifies member hashes', async () => {
	const tempDir = await mkdtemp(path.join(tmpdir(), 'world-map-7z-materialize-'))
	try {
		const memberDir = path.join(tempDir, 'v158')
		await mkdir(memberDir, { recursive: true })
		const memberContent = Buffer.from('synthetic-wz-content-for-testing-materializer')
		const memberPath = path.join(memberDir, 'Custom.wz')
		await writeFile(memberPath, memberContent)

		const archivePath = path.join(tempDir, 'test.7z')
		await execFileAsync('7zz', ['a', '-mx=5', archivePath, 'v158/Custom.wz'], { cwd: tempDir })

		const archiveBytes = await readFile(archivePath)
		const archiveSize = archiveBytes.byteLength
		const archiveSha1 = sha1(archiveBytes)
		const expectedMemberSha256 = sha256(memberContent)

		// In-memory offline range fetcher
		const mockFetchRange = async (_url: string, start: number, endInclusive: number) => {
			const slice = archiveBytes.subarray(start, endInclusive + 1)
			return { bytes: new Uint8Array(slice), totalSize: archiveSize }
		}

		const outputDir = path.join(tempDir, 'out')
		const result = await materializeArchivedSevenZipMember({
			logicalRegion: 'TWMS',
			version: '158',
			providerRegion: 'TWMS',
			providerVersion: '158',
			archiveItem: 'test-archive-item',
			archiveFile: 'test.7z',
			archiveSize,
			archiveSha1,
			memberName: 'Custom.wz',
			memberPath: 'v158/Custom.wz',
			expectedSha256: expectedMemberSha256,
		}, {
			fetchRange: mockFetchRange,
			verifyArchiveMetadata: false,
			outputDirectory: outputDir,
		})

		assert.equal(Buffer.from(result.bytes).equals(memberContent), true)
		assert.equal(await readFile(result.extractedPath, 'utf8'), 'synthetic-wz-content-for-testing-materializer')

		// Verify exact provenance fields
		const { provenance } = result
		assert.equal(provenance.provider, 'archived-wz')
		assert.equal(provenance.logicalRegion, 'TWMS')
		assert.equal(provenance.version, '158')
		assert.equal(provenance.providerRegion, 'TWMS')
		assert.equal(provenance.providerVersion, '158')
		assert.equal(provenance.archiveItem, 'test-archive-item')
		assert.equal(provenance.archiveFile, 'test.7z')
		assert.equal(provenance.archiveUrl, 'https://archive.org/download/test-archive-item/test.7z')
		assert.equal(provenance.archiveSize, archiveSize)
		assert.equal(provenance.archiveSha1, archiveSha1)
		assert.equal(provenance.memberName, 'Custom.wz')
		assert.equal(provenance.memberPath, 'v158/Custom.wz')
		assert.equal(provenance.memberSize, memberContent.byteLength)
		assert.ok(provenance.memberCrc != null && provenance.memberCrc.length > 0)
		assert.equal(provenance.memberSha256, expectedMemberSha256)
		assert.equal(provenance.wzFile, 'Custom.wz')
		assert.equal(provenance.wzSha256, expectedMemberSha256)
		assert.ok(Number.isSafeInteger(provenance.packedBlock.offset) && provenance.packedBlock.offset >= 32)
		assert.ok(Number.isSafeInteger(provenance.packedBlock.size) && provenance.packedBlock.size > 0)

		const memberCrc = provenance.memberCrc!
		const packedBlockNumber = provenance.packedBlock.block!
		const packedBlockSize = provenance.packedBlock.size

		// Proves that expectedSize, case-insensitive expectedCrc, and expectedPackedBlock pass when matching
		const verifiedResult = await materializeArchivedSevenZipMember({
			logicalRegion: 'TWMS',
			version: '158',
			archiveItem: 'test-archive-item',
			archiveFile: 'test.7z',
			archiveSize,
			archiveSha1,
			memberName: 'Custom.wz',
			memberPath: 'v158/Custom.wz',
			expectedSha256: expectedMemberSha256,
			expectedSize: memberContent.byteLength,
			expectedCrc: memberCrc.toLowerCase(), // case-insensitive
			expectedPackedBlock: {
				blockNumber: packedBlockNumber,
				packedSize: packedBlockSize,
				sharedMembers: ['v158/Custom.wz'],
			},
		}, {
			fetchRange: mockFetchRange,
			verifyArchiveMetadata: false,
		})
		assert.equal(verifiedResult.provenance.memberCrc, memberCrc.toUpperCase())

		// Proves non-TWMS archiveItem and overrides construct correct URLs in provenance
		const nonTwmsResult = await materializeArchivedSevenZipMember({
			logicalRegion: 'GMS',
			version: '92',
			archiveItem: 'custom-gms-archive',
			archiveFile: 'test.7z',
			archiveSize,
			archiveSha1,
			memberName: 'Custom.wz',
			memberPath: 'v158/Custom.wz',
		}, {
			fetchRange: mockFetchRange,
			verifyArchiveMetadata: false,
		})
		assert.equal(nonTwmsResult.provenance.archiveUrl, 'https://archive.org/download/custom-gms-archive/test.7z')

		const customBaseUrlResult = await materializeArchivedSevenZipMember({
			logicalRegion: 'TWMS',
			version: '158',
			archiveItem: 'test-archive-item',
			archiveFile: 'test.7z',
			archiveSize,
			archiveSha1,
			memberName: 'Custom.wz',
			memberPath: 'v158/Custom.wz',
		}, {
			fetchRange: mockFetchRange,
			verifyArchiveMetadata: false,
			archiveBaseUrl: 'https://mirror.example.org/download',
		})
		assert.equal(customBaseUrlResult.provenance.archiveUrl, 'https://mirror.example.org/download/test.7z')

		const customUrlResult = await materializeArchivedSevenZipMember({
			logicalRegion: 'TWMS',
			version: '158',
			archiveItem: 'test-archive-item',
			archiveFile: 'test.7z',
			archiveSize,
			archiveSha1,
			memberName: 'Custom.wz',
			memberPath: 'v158/Custom.wz',
		}, {
			fetchRange: mockFetchRange,
			verifyArchiveMetadata: false,
			archiveUrl: 'https://cdn.example.org/direct-archive.7z',
		})
		assert.equal(customUrlResult.provenance.archiveUrl, 'https://cdn.example.org/direct-archive.7z')

		// Test expectedSize mismatch rejection
		await assert.rejects(
			materializeArchivedSevenZipMember({
				logicalRegion: 'TWMS',
				version: '158',
				archiveItem: 'test-archive-item',
				archiveFile: 'test.7z',
				archiveSize,
				archiveSha1,
				memberName: 'Custom.wz',
				memberPath: 'v158/Custom.wz',
				expectedSize: memberContent.byteLength + 1,
			}, {
				fetchRange: mockFetchRange,
				verifyArchiveMetadata: false,
			}),
			/Custom\.wz size mismatch for TWMS\/158/,
		)

		// Test expectedCrc mismatch rejection
		await assert.rejects(
			materializeArchivedSevenZipMember({
				logicalRegion: 'TWMS',
				version: '158',
				archiveItem: 'test-archive-item',
				archiveFile: 'test.7z',
				archiveSize,
				archiveSha1,
				memberName: 'Custom.wz',
				memberPath: 'v158/Custom.wz',
				expectedCrc: 'FFFFFFFF',
			}, {
				fetchRange: mockFetchRange,
				verifyArchiveMetadata: false,
			}),
			/Custom\.wz CRC mismatch for TWMS\/158/,
		)

		// Test expectedPackedBlock mismatch rejections (block number, size, shared members)
		await assert.rejects(
			materializeArchivedSevenZipMember({
				logicalRegion: 'TWMS',
				version: '158',
				archiveItem: 'test-archive-item',
				archiveFile: 'test.7z',
				archiveSize,
				archiveSha1,
				memberName: 'Custom.wz',
				memberPath: 'v158/Custom.wz',
				expectedPackedBlock: {
					blockNumber: packedBlockNumber + 1,
					packedSize: packedBlockSize,
				},
			}, {
				fetchRange: mockFetchRange,
				verifyArchiveMetadata: false,
			}),
			/Custom\.wz packed block mismatch for TWMS\/158: expected block/,
		)

		await assert.rejects(
			materializeArchivedSevenZipMember({
				logicalRegion: 'TWMS',
				version: '158',
				archiveItem: 'test-archive-item',
				archiveFile: 'test.7z',
				archiveSize,
				archiveSha1,
				memberName: 'Custom.wz',
				memberPath: 'v158/Custom.wz',
				expectedPackedBlock: {
					blockNumber: packedBlockNumber,
					packedSize: packedBlockSize + 99,
				},
			}, {
				fetchRange: mockFetchRange,
				verifyArchiveMetadata: false,
			}),
			/Custom\.wz packed block size mismatch for TWMS\/158: expected packed size/,
		)

		await assert.rejects(
			materializeArchivedSevenZipMember({
				logicalRegion: 'TWMS',
				version: '158',
				archiveItem: 'test-archive-item',
				archiveFile: 'test.7z',
				archiveSize,
				archiveSha1,
				memberName: 'Custom.wz',
				memberPath: 'v158/Custom.wz',
				expectedPackedBlock: {
					blockNumber: packedBlockNumber,
					packedSize: packedBlockSize,
					sharedMembers: ['v158/Other.wz'],
				},
			}, {
				fetchRange: mockFetchRange,
				verifyArchiveMetadata: false,
			}),
			/Custom\.wz shared members mismatch for TWMS\/158/,
		)

		// Test SHA-256 mismatch rejection
		await assert.rejects(
			materializeArchivedSevenZipMember({
				logicalRegion: 'TWMS',
				version: '158',
				archiveItem: 'test-archive-item',
				archiveFile: 'test.7z',
				archiveSize,
				archiveSha1,
				memberName: 'Custom.wz',
				memberPath: 'v158/Custom.wz',
				expectedSha256: '0'.repeat(64),
			}, {
				fetchRange: mockFetchRange,
				verifyArchiveMetadata: false,
			}),
			/SHA-256 mismatch for TWMS\/158/,
		)

		// Test archive size mismatch rejection on start header
		await assert.rejects(
			materializeArchivedSevenZipMember({
				logicalRegion: 'TWMS',
				version: '158',
				archiveItem: 'test-archive-item',
				archiveFile: 'test.7z',
				archiveSize: archiveSize + 100,
				archiveSha1,
				memberName: 'Custom.wz',
				memberPath: 'v158/Custom.wz',
			}, {
				fetchRange: mockFetchRange,
				verifyArchiveMetadata: false,
			}),
			/Archive size mismatch while fetching start header/,
		)

		// Test archive size mismatch rejection on next header
		await assert.rejects(
			materializeArchivedSevenZipMember({
				logicalRegion: 'TWMS',
				version: '158',
				archiveItem: 'test-archive-item',
				archiveFile: 'test.7z',
				archiveSize,
				archiveSha1,
				memberName: 'Custom.wz',
				memberPath: 'v158/Custom.wz',
			}, {
				fetchRange: async (_url: string, start: number, endInclusive: number) => {
					const slice = archiveBytes.subarray(start, endInclusive + 1)
					return { bytes: new Uint8Array(slice), totalSize: start === 0 ? archiveSize : archiveSize + 100 }
				},
				verifyArchiveMetadata: false,
			}),
			/Archive size mismatch while fetching next header/,
		)

		// Test archive size mismatch rejection on payload block
		await assert.rejects(
			materializeArchivedSevenZipMember({
				logicalRegion: 'TWMS',
				version: '158',
				archiveItem: 'test-archive-item',
				archiveFile: 'test.7z',
				archiveSize,
				archiveSha1,
				memberName: 'Custom.wz',
				memberPath: 'v158/Custom.wz',
			}, {
				fetchRange: async (_url: string, start: number, endInclusive: number) => {
					const slice = archiveBytes.subarray(start, endInclusive + 1)
					return {
						bytes: new Uint8Array(slice),
						totalSize: start === provenance.packedBlock.offset ? archiveSize + 100 : archiveSize,
					}
				},
				verifyArchiveMetadata: false,
			}),
			/Archive size mismatch while fetching payload block/,
		)

		// Test localized input validation rejections
		await assert.rejects(
			materializeArchivedSevenZipMember({
				logicalRegion: 'TWMS',
				version: '158',
				archiveItem: 'test-archive-item',
				archiveFile: 'test.7z',
				archiveSize,
				archiveSha1,
				memberName: 'WrongName.wz',
				memberPath: 'v158/Custom.wz',
			}, { fetchRange: mockFetchRange, verifyArchiveMetadata: false }),
			/Target memberName "WrongName\.wz" does not match basename of memberPath "v158\/Custom\.wz"/,
		)

		await assert.rejects(
			materializeArchivedSevenZipMember({
				logicalRegion: 'TWMS',
				version: '158',
				archiveItem: 'test-archive-item',
				archiveFile: 'test.7z',
				archiveSize,
				archiveSha1,
				memberName: '../Custom.wz',
				memberPath: 'v158/Custom.wz',
			}, { fetchRange: mockFetchRange, verifyArchiveMetadata: false }),
			/Invalid target member name/,
		)

		await assert.rejects(
			materializeArchivedSevenZipMember({
				logicalRegion: 'TWMS',
				version: '158',
				archiveItem: 'test/item',
				archiveFile: 'test.7z',
				archiveSize,
				archiveSha1,
				memberName: 'Custom.wz',
				memberPath: 'v158/Custom.wz',
			}, { fetchRange: mockFetchRange, verifyArchiveMetadata: false }),
			/Invalid target archive item/,
		)

		await assert.rejects(
			materializeArchivedSevenZipMember({
				logicalRegion: 'TWMS',
				version: '158',
				archiveItem: 'test-archive-item',
				archiveFile: 'path/to/test.7z',
				archiveSize,
				archiveSha1,
				memberName: 'Custom.wz',
				memberPath: 'v158/Custom.wz',
			}, { fetchRange: mockFetchRange, verifyArchiveMetadata: false }),
			/Invalid target archive file/,
		)

		await assert.rejects(
			materializeArchivedSevenZipMember({
				logicalRegion: 'TWMS',
				version: '158',
				archiveItem: 'test-archive-item',
				archiveFile: 'test.7z',
				archiveSize: 10,
				archiveSha1,
				memberName: 'Custom.wz',
				memberPath: 'v158/Custom.wz',
			}, { fetchRange: mockFetchRange, verifyArchiveMetadata: false }),
			/Invalid target archive size/,
		)

		await assert.rejects(
			materializeArchivedSevenZipMember({
				logicalRegion: 'TWMS',
				version: '158',
				archiveItem: 'test-archive-item',
				archiveFile: 'test.7z',
				archiveSize,
				archiveSha1: 'invalid-sha1-hash',
				memberName: 'Custom.wz',
				memberPath: 'v158/Custom.wz',
			}, { fetchRange: mockFetchRange, verifyArchiveMetadata: false }),
			/Invalid target archive SHA-1/,
		)

		// Test technical listing missing Size or CRC when expected value is provided
		const mockScript = path.join(tempDir, 'mock-7zz.sh')
		await writeFile(mockScript, `#!/bin/sh
if [ "$1" = "l" ]; then
  echo "Path = v158/Custom.wz"
  echo "Block = 0"
  echo "Packed Size = 100"
else
  exec 7zz "$@"
fi
`, { mode: 0o755 })

		await assert.rejects(
			materializeArchivedSevenZipMember({
				logicalRegion: 'TWMS',
				version: '158',
				archiveItem: 'test-archive-item',
				archiveFile: 'test.7z',
				archiveSize,
				archiveSha1,
				memberName: 'Custom.wz',
				memberPath: 'v158/Custom.wz',
				expectedSize: memberContent.byteLength,
			}, {
				fetchRange: mockFetchRange,
				verifyArchiveMetadata: false,
				sevenZip: mockScript,
			}),
			/Custom\.wz technical listing is missing size for TWMS\/158/,
		)

		await assert.rejects(
			materializeArchivedSevenZipMember({
				logicalRegion: 'TWMS',
				version: '158',
				archiveItem: 'test-archive-item',
				archiveFile: 'test.7z',
				archiveSize,
				archiveSha1,
				memberName: 'Custom.wz',
				memberPath: 'v158/Custom.wz',
				expectedCrc: '12345678',
			}, {
				fetchRange: mockFetchRange,
				verifyArchiveMetadata: false,
				sevenZip: mockScript,
			}),
			/Custom\.wz technical listing is missing CRC for TWMS\/158/,
		)
	}
	finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('inspectArchivedSevenZipMemberPlan produces plan without fetching payload block and enforces safety budget', async () => {
	const tempDir = await mkdtemp(path.join(tmpdir(), 'world-map-7z-inspect-'))
	try {
		const memberDir = path.join(tempDir, 'v158')
		await mkdir(memberDir, { recursive: true })
		const memberContent = Buffer.from('synthetic-content-for-planning-and-budget-safety-tests')
		const memberPath = path.join(memberDir, 'Custom.wz')
		await writeFile(memberPath, memberContent)

		const archivePath = path.join(tempDir, 'test.7z')
		await execFileAsync('7zz', ['a', '-mx=5', archivePath, 'v158/Custom.wz'], { cwd: tempDir })

		const archiveBytes = await readFile(archivePath)
		const archiveSize = archiveBytes.byteLength
		const archiveSha1 = sha1(archiveBytes)

		const requestedRanges: Array<{ start: number, end: number }> = []
		const trackingFetchRange = async (_url: string, start: number, endInclusive: number) => {
			requestedRanges.push({ start, end: endInclusive })
			const slice = archiveBytes.subarray(start, endInclusive + 1)
			return { bytes: new Uint8Array(slice), totalSize: archiveSize }
		}

		const target = {
			logicalRegion: 'TWMS' as const,
			version: '158',
			archiveItem: 'test-archive-item',
			archiveFile: 'test.7z',
			archiveSize,
			archiveSha1,
			memberName: 'Custom.wz',
			memberPath: 'v158/Custom.wz',
		}

		// 1. Plan-only inspection
		const plan = await inspectArchivedSevenZipMemberPlan(target, {
			fetchRange: trackingFetchRange,
			verifyArchiveMetadata: false,
		})

		assert.equal(plan.memberName, 'Custom.wz')
		assert.equal(plan.memberPath, 'v158/Custom.wz')
		assert.equal(plan.memberSize, memberContent.byteLength)
		assert.ok(plan.memberCrc != null && plan.memberCrc.length > 0)
		assert.equal(plan.packedBlock.block, 0)
		assert.ok(plan.packedBlock.size > 0)
		assert.deepEqual(plan.packedBlock.sharedMembers, ['v158/Custom.wz'])
		assert.equal(plan.archiveUrl, 'https://archive.org/download/test-archive-item/test.7z')

		// Verify plan-only NEVER requested the payload block range
		const payloadStart = plan.packedBlock.offset
		const payloadEnd = plan.packedBlock.offset + plan.packedBlock.size - 1
		const requestedPayload = requestedRanges.some(r => r.start <= payloadEnd && r.end >= payloadStart)
		assert.equal(requestedPayload, false, 'plan-only must not fetch payload block range')

		// 2. Archive total size validation during plan-only
		await assert.rejects(
			inspectArchivedSevenZipMemberPlan({
				...target,
				archiveSize: archiveSize + 500,
			}, {
				fetchRange: trackingFetchRange,
				verifyArchiveMetadata: false,
			}),
			/Archive size mismatch while fetching start header/,
		)

		await assert.rejects(
			inspectArchivedSevenZipMemberPlan(target, {
				fetchRange: async (_url, start, endInclusive) => {
					const slice = archiveBytes.subarray(start, endInclusive + 1)
					return { bytes: new Uint8Array(slice), totalSize: start === 0 ? archiveSize : archiveSize + 50 }
				},
				verifyArchiveMetadata: false,
			}),
			/Archive size mismatch while fetching next header/,
		)

		// 3. Header/listing validation during plan-only
		await assert.rejects(
			inspectArchivedSevenZipMemberPlan(target, {
				fetchRange: async (_url, start, endInclusive) => {
					const bytes = new Uint8Array(endInclusive - start + 1)
					return { bytes, totalSize: archiveSize }
				},
				verifyArchiveMetadata: false,
			}),
			/Invalid 7z signature/,
		)

		await assert.rejects(
			inspectArchivedSevenZipMemberPlan({
				...target,
				memberName: 'Missing.wz',
				memberPath: 'v158/Missing.wz',
			}, {
				fetchRange: trackingFetchRange,
				verifyArchiveMetadata: false,
			}),
			/does not contain member v158\/Missing\.wz/,
		)

		// 4. Safety budget enforcement in inspectArchivedSevenZipMemberPlan
		await assert.rejects(
			inspectArchivedSevenZipMemberPlan(target, {
				fetchRange: trackingFetchRange,
				verifyArchiveMetadata: false,
				maxPackedBlockBytes: plan.packedBlock.size - 1,
			}),
			new RegExp(`Custom\\.wz packed block size ${plan.packedBlock.size} exceeds safety budget of ${plan.packedBlock.size - 1} bytes`),
		)

		const budgetPassedPlan = await inspectArchivedSevenZipMemberPlan(target, {
			fetchRange: trackingFetchRange,
			verifyArchiveMetadata: false,
			maxPackedBlockBytes: plan.packedBlock.size,
		})
		assert.equal(budgetPassedPlan.packedBlock.size, plan.packedBlock.size)

		// 5. Safety budget enforcement in materializeArchivedSevenZipMember (rejects oversized before download)
		requestedRanges.length = 0
		await assert.rejects(
			materializeArchivedSevenZipMember(target, {
				fetchRange: trackingFetchRange,
				verifyArchiveMetadata: false,
				maxPackedBlockBytes: plan.packedBlock.size - 1,
			}),
			new RegExp(`Custom\\.wz packed block size ${plan.packedBlock.size} exceeds safety budget of ${plan.packedBlock.size - 1} bytes`),
		)
		const payloadRequestedOnRejection = requestedRanges.some(r => r.start <= payloadEnd && r.end >= payloadStart)
		assert.equal(payloadRequestedOnRejection, false, 'materialize must reject before requesting payload block when exceeding budget')

		// 6. Materialize succeeds when budget is satisfied
		const materialized = await materializeArchivedSevenZipMember(target, {
			fetchRange: trackingFetchRange,
			verifyArchiveMetadata: false,
			maxPackedBlockBytes: plan.packedBlock.size,
		})
		assert.equal(Buffer.from(materialized.bytes).equals(memberContent), true)
	}
	finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('findCachedArchivedWzMember finds member in direct or subdirectory cache layout', async () => {
	const tempDir = await mkdtemp(path.join(tmpdir(), 'find-cached-archived-wz-'))
	try {
		const source = archivedMapWzSource('TWMS', 158)!
		assert.equal(await findCachedArchivedWzMember(tempDir, source), null)

		// Direct layout: .cache/world-map/archived-wz/TWMS/158/Map.wz
		const directDir = path.join(tempDir, '.cache', 'world-map', 'archived-wz', 'TWMS', '158')
		await mkdir(directDir, { recursive: true })
		const directFile = path.join(directDir, 'Map.wz')
		await writeFile(directFile, 'dummy-map-wz')

		assert.equal(await findCachedArchivedWzMember(tempDir, source), directFile)

		// Subdirectory layout: .cache/world-map/archived-wz/TWMS/158/Map.wz/Map.wz
		await rm(directFile)
		const subDir = path.join(directDir, 'Map.wz')
		await mkdir(subDir, { recursive: true })
		const subFile = path.join(subDir, 'Map.wz')
		await writeFile(subFile, 'dummy-map-wz-sub')

		assert.equal(await findCachedArchivedWzMember(tempDir, source), subFile)
	}
	finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('parses archived String.wz and Map.wz fixtures into topology, geometry, links, and map details', async () => {
	await initWz({ forceWasm: true })
	const tempDir = await mkdtemp(path.join(tmpdir(), 'archived-wz-parse-fixture-'))
	try {
		// Trigger WASM mount
		const mountTrigger = path.join(tempDir, 'mount.wz')
		const mountFile = WzFile.create(158, MapleVersion.EMS)
		mountFile.saveToDisk(mountTrigger)
		mountFile.close()
		await rm(mountTrigger, { force: true })

		const tilePngPath = path.join(tempDir, 'tile.png')
		const tileSharp = sharp({
			create: { width: 4, height: 4, channels: 4, background: { r: 120, g: 140, b: 160, alpha: 1 } },
		})
		const pngBuf = await tileSharp.png().toBuffer()
		await writeFile(tilePngPath, pngBuf)

		const stringWzFile = path.join(tempDir, 'String.wz')
		const strFile = WzFile.create(158, MapleVersion.EMS)
		try {
			const strRoot = strFile.getWzDirectory()!
			const wmImg = strRoot.createImage('WorldMap.img')
			const wm0 = WzProperty.createSub('0')
			wm0.addProperty(WzProperty.createString('name', '楓之谷'))
			wmImg.addProperty(wm0)
			const wm010 = WzProperty.createSub('010')
			wm010.addProperty(WzProperty.createString('name', '維多利亞島'))
			wmImg.addProperty(wm010)

			const mapImg = strRoot.createImage('Map.img')
			const mapCat = WzProperty.createSub('victoria')
			const mapEntry = WzProperty.createSub('100000000')
			mapEntry.addProperty(WzProperty.createString('mapName', '弓箭手村'))
			mapEntry.addProperty(WzProperty.createString('streetName', '維多利亞島'))
			mapCat.addProperty(mapEntry)
			mapImg.addProperty(mapCat)

			strFile.saveToDisk(stringWzFile)
		}
		finally {
			strFile.close()
		}

		const mapWzFile = path.join(tempDir, 'Map.wz')
		const mapFile = WzFile.create(158, MapleVersion.EMS)
		try {
			const mapRoot = mapFile.getWzDirectory()!
			const wmDir = mapRoot.createDirectory('WorldMap')

			// WorldMap.img (root)
			const wmImg = wmDir.createImage('WorldMap.img')
			const baseImg = WzProperty.createSub('BaseImg')
			const canvas0 = WzProperty.createCanvasFromPng('0', `/mnt${path.resolve(tilePngPath)}`)
			baseImg.addProperty(canvas0)
			wmImg.addProperty(baseImg)

			const mapList = WzProperty.createSub('MapList')
			const spot0 = WzProperty.createSub('0')
			spot0.addProperty(WzProperty.createVector('spot', 15, 25))
			spot0.addProperty(WzProperty.createInt('type', 1))
			const mapNo = WzProperty.createSub('mapNo')
			mapNo.addProperty(WzProperty.createInt('0', 100000000))
			spot0.addProperty(mapNo)
			mapList.addProperty(spot0)
			wmImg.addProperty(mapList)

			const mapLink = WzProperty.createSub('MapLink')
			const link0 = WzProperty.createSub('0')
			link0.addProperty(WzProperty.createString('toolTip', '維多利亞島'))
			const linkSub = WzProperty.createSub('link')
			linkSub.addProperty(WzProperty.createString('linkMap', 'WorldMap010'))
			const linkImg = WzProperty.createCanvasFromPng('linkImg', `/mnt${path.resolve(tilePngPath)}`)
			linkSub.addProperty(linkImg)
			link0.addProperty(linkSub)
			mapLink.addProperty(link0)
			wmImg.addProperty(mapLink)

			// WorldMap010.img (child)
			const wm010Img = wmDir.createImage('WorldMap010.img')
			const baseImg010 = WzProperty.createSub('BaseImg')
			const canvas010 = WzProperty.createCanvasFromPng('0', `/mnt${path.resolve(tilePngPath)}`)
			baseImg010.addProperty(canvas010)
			wm010Img.addProperty(baseImg010)
			const info010 = WzProperty.createSub('info')
			info010.addProperty(WzProperty.createString('parentMap', 'WorldMap'))
			wm010Img.addProperty(info010)

			// Map details
			const mapDir = mapRoot.createDirectory('Map')
			const map1Dir = mapDir.createDirectory('Map1')
			const m100Img = map1Dir.createImage('100000000.img')
			const mInfo = WzProperty.createSub('info')
			mInfo.addProperty(WzProperty.createString('bgm', 'Bgm00/FloralLife'))
			mInfo.addProperty(WzProperty.createString('mapMark', 'Henesys'))
			m100Img.addProperty(mInfo)

			mapFile.saveToDisk(mapWzFile)
		}
		finally {
			mapFile.close()
		}

		// 1. parseArchivedMapStrings
		const mapStrings = await parseArchivedMapStrings(stringWzFile, '158', 'EMS')
		assert.deepEqual(mapStrings['100000000'], {
			mapName: '弓箭手村',
			streetName: '維多利亞島',
		})

		// 2. parseArchivedMapWz
		const parsed = await parseArchivedMapWz(mapWzFile, '158', {
			mapStrings,
			worldMapNames: { WorldMap: '楓之谷', WorldMap010: '維多利亞島' },
		})
		assert.deepEqual(parsed.roots, ['WorldMap'])
		assert.equal(parsed.nodes.length, 2)
		const rootNode = parsed.nodes.find(n => n.id === 'WorldMap')!
		assert.equal(rootNode.parentWorld, null)
		assert.equal(rootNode.worldMapName, '楓之谷')
		assert.equal(rootNode.baseImages.length, 1)
		assert.equal(rootNode.links.length, 1)
		assert.equal(rootNode.links[0]?.linksTo, 'WorldMap010')
		assert.equal(rootNode.links[0]?.toolTip, '維多利亞島')
		assert.ok(rootNode.links[0]?.linkImage != null)
		assert.equal(rootNode.maps.length, 1)
		assert.deepEqual(rootNode.maps[0]?.spot, { x: 15, y: 25 })
		assert.equal(rootNode.maps[0]?.type, 1)
		assert.deepEqual(rootNode.maps[0]?.mapNumbers, ['100000000'])

		const childNode = parsed.nodes.find(n => n.id === 'WorldMap010')!
		assert.equal(childNode.parentWorld, 'WorldMap')
		assert.equal(childNode.worldMapName, '維多利亞島')

		assert.equal(parsed.maps.length, 1)
		assert.deepEqual(parsed.maps[0], {
			id: '100000000',
			name: '弓箭手村',
			streetName: '維多利亞島',
			backgroundMusic: 'Bgm00/FloralLife',
			mapMark: 'Henesys',
		})

		// 3. acquireArchivedWzWorldMapGraph
		const acquired = await acquireArchivedWzWorldMapGraph(
			{ stringWzFile, mapWzFile },
			'TWMS',
			'158',
			{
				mode: 'preview',
				requests: [{ rootId: 'WorldMap', maxDepth: 2 }],
			},
			'EMS',
		)
		assert.equal(acquired.provider, 'archived-wz')
		assert.equal(acquired.region, 'TWMS')
		assert.equal(acquired.version, '158')
		assert.deepEqual(acquired.roots, ['WorldMap'])
		assert.equal(acquired.nodes.length, 2)
		assert.equal(acquired.maps.length, 1)
		assert.deepEqual(acquired.worldMapNames, {
			WorldMap: '楓之谷',
			WorldMap010: '維多利亞島',
		})
	}
	finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('full archived Map.wz parsing rejects missing or wrongly typed MapList spot fields', async () => {
	await initWz({ forceWasm: true })
	const tempDir = await mkdtemp(path.join(tmpdir(), 'archived-wz-maplist-validation-'))
	try {
		const tilePngPath = path.join(tempDir, 'tile.png')
		const tilePng = sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png()
		await writeFile(tilePngPath, await tilePng.toBuffer())

		const writeFixture = async (filePath: string, malformed: 'spot' | 'type') => {
			const mapFile = WzFile.create(158, MapleVersion.EMS)
			try {
				const mapRoot = mapFile.getWzDirectory()!
				const worldMap = mapRoot.createDirectory('WorldMap')
				const screen = worldMap.createImage('WorldMap.img')
				const baseImg = WzProperty.createSub('BaseImg')
				baseImg.addProperty(WzProperty.createCanvasFromPng('0', `/mnt${path.resolve(tilePngPath)}`))
				screen.addProperty(baseImg)
				const mapList = WzProperty.createSub('MapList')
				const spot = WzProperty.createSub('0')
				if (malformed !== 'spot')
					spot.addProperty(WzProperty.createVector('spot', 0, 0))
				spot.addProperty(malformed === 'type' ? WzProperty.createString('type', 'wrong') : WzProperty.createInt('type', 1))
				mapList.addProperty(spot)
				screen.addProperty(mapList)
				mapFile.saveToDisk(filePath)
			}
			finally {
				mapFile.close()
			}
		}

		const missingSpotFile = path.join(tempDir, 'missing-spot-Map.wz')
		await writeFixture(missingSpotFile, 'spot')
		await assert.rejects(parseArchivedMapWz(missingSpotFile, '158', { mode: 'full' }), /malformed MapList spot/)

		const wrongTypeFile = path.join(tempDir, 'wrong-type-Map.wz')
		await writeFixture(wrongTypeFile, 'type')
		await assert.rejects(parseArchivedMapWz(wrongTypeFile, '158', { mode: 'full' }), /malformed MapList type/)
	}
	finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('resolveWorldMapGenerationSnapshot resolves archived-wz snapshots and fails missing cache with exact sync command', async () => {
	const tempDir = await mkdtemp(path.join(tmpdir(), 'resolve-archived-wz-'))
	try {
		const dummyClient = new MapleStoryIoClient({ delayMs: 0, timeoutMs: 0, fetcher: (async () => []) as never })

		// 1. Unconfigured historical snapshot throws archived-WZ required error
		await assert.rejects(
			resolveWorldMapGenerationSnapshot(dummyClient, { region: 'TWMS', version: '999' }, undefined, { workspace: tempDir }),
			/Snapshot TWMS\/999 is not available through the HTTP acquisition adapters or configured archived-WZ sources; an archived-WZ provider is required/,
		)

		// 2. Configured snapshot with missing String.wz cache throws actionable sync command
		await assert.rejects(
			resolveWorldMapGenerationSnapshot(dummyClient, { region: 'TWMS', version: '158' }, undefined, { workspace: tempDir }),
			/Archived WZ generation for TWMS\/158 requires cached String\.wz\. Missing cached String\.wz at .*\/TWMS\/158\/String\.wz\. Run 'pnpm run world-map:sync -- --snapshot=TWMS\/158 --member=String\.wz' to materialize it\./,
		)

		// 3. String.wz cached, but Map.wz missing throws actionable sync command for Map.wz
		const stringDir = path.join(tempDir, '.cache', 'world-map', 'archived-wz', 'TWMS', '158')
		await mkdir(stringDir, { recursive: true })
		await writeFile(path.join(stringDir, 'String.wz'), 'mock-string-wz')

		await assert.rejects(
			resolveWorldMapGenerationSnapshot(dummyClient, { region: 'TWMS', version: '158' }, undefined, { workspace: tempDir }),
			/Archived WZ generation for TWMS\/158 requires cached Map\.wz\. Missing cached Map\.wz at .*\/TWMS\/158\/Map\.wz\. Run 'pnpm run world-map:sync -- --snapshot=TWMS\/158 --member=Map\.wz' to materialize it\./,
		)

		// 4. Map.wz also cached -> resolves successfully
		await writeFile(path.join(stringDir, 'Map.wz'), 'mock-map-wz')
		const resolved = await resolveWorldMapGenerationSnapshot(dummyClient, { region: 'TWMS', version: '158' }, undefined, { workspace: tempDir })
		assert.deepEqual(resolved, {
			id: 'TWMS/158',
			region: 'TWMS',
			version: '158',
			provider: 'archived-wz',
			providerRegion: 'TWMS',
		})

		// 5. Explicit archivedWzPaths bypasses cache search and resolves directly
		const resolvedExplicit = await resolveWorldMapGenerationSnapshot(
			dummyClient,
			{ region: 'TWMS', version: '158' },
			undefined,
			{
				workspace: '/nonexistent',
				archivedWzPaths: {
					stringWzFile: '/path/to/custom/String.wz',
					mapWzFile: '/path/to/custom/Map.wz',
				},
			},
		)
		assert.deepEqual(resolvedExplicit, {
			id: 'TWMS/158',
			region: 'TWMS',
			version: '158',
			provider: 'archived-wz',
			providerRegion: 'TWMS',
		})
	}
	finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('syncArchivedMapWz verifies and loads cached Map.wz manifest', async () => {
	const tempDir = await mkdtemp(path.join(tmpdir(), 'sync-map-wz-'))
	try {
		// Unconfigured snapshot throws error
		await assert.rejects(
			syncArchivedMapWz('TWMS', '999', { workspace: tempDir }),
			/No archived Map\.wz source is configured for TWMS\/999/,
		)

		// When cache is present with matching SHA-256 and manifest, returns manifest without re-materializing
		const cacheDir = path.join(tempDir, '.cache', 'world-map', 'archived-wz', 'TWMS', '999')
		await mkdir(cacheDir, { recursive: true })
		const dummyMapWz = Buffer.from('mock-map-wz-bytes-for-twms-test')
		const dummySha256 = sha256(dummyMapWz)
		const mapWz = path.join(cacheDir, 'Map.wz')
		await writeFile(mapWz, dummyMapWz)

		const customSource = {
			...archivedMapWzSource('TWMS', '158')!,
			version: '999',
			memberSha256: dummySha256,
		}

		const manifest = path.join(cacheDir, 'manifest-map.json')
		const manifestContent = {
			schemaVersion: 1 as const,
			provenance: {
				provider: 'archived-wz' as const,
				logicalRegion: 'TWMS' as const,
				version: '999',
				providerRegion: 'TWMS',
				providerVersion: '999',
				archiveItem: 'twms-maplestory',
				archiveFile: 'v999.7z',
				archiveUrl: 'https://archive.org/download/twms-maplestory/v999.7z',
				archiveSize: 1000,
				archiveSha1: '0'.repeat(40),
				memberName: 'Map.wz',
				memberPath: 'v999/Map.wz',
				memberSize: dummyMapWz.byteLength,
				memberCrc: '51A1AB13',
				memberSha256: dummySha256,
				packedBlock: { offset: 100, size: 200, block: 7 },
			},
		}
		await writeFile(manifest, JSON.stringify(manifestContent, null, 2))

		const synced = await syncArchivedMapWz('TWMS', '999', { workspace: tempDir, source: customSource })
		assert.deepEqual(synced, manifestContent)
	}
	finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('reads legacy single-manifest archived-WZ caches with configured Map.wz identity', async () => {
	const tempDir = await mkdtemp(path.join(tmpdir(), 'legacy-archived-wz-cache-'))
	try {
		const source = archivedStringWzSource('TWMS', '158')!
		const mapSource = archivedMapWzSource('TWMS', '158')!
		const cacheDir = archivedStringWzCacheDirectory(tempDir, source)
		await mkdir(cacheDir, { recursive: true })
		await writeFile(path.join(cacheDir, 'manifest.json'), JSON.stringify({
			schemaVersion: 1,
			provenance: {
				provider: 'archived-wz',
				logicalRegion: 'TWMS',
				version: 158,
				archiveItem: source.archiveItem,
				archiveFile: source.archiveFile,
				archiveSha1: source.archiveSha1,
				wzFile: 'String.wz',
				wzSha256: source.memberSha256,
			},
		}, null, 2))

		const published = await readCachedArchivedWzProvenance(tempDir, source, mapSource)
		assert.deepEqual(published, {
			providerRegion: 'TWMS',
			providerVersion: '158',
			archiveItem: 'twms-maplestory',
			archiveFile: 'v158.7z',
			archiveSha1: source.archiveSha1,
			members: {
				stringWz: { name: 'String.wz', sha256: source.memberSha256 },
				mapWz: { name: 'Map.wz', sha256: mapSource.memberSha256 },
			},
		})
	}
	finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('full archived-WZ generation rejects caller-self-attested fixture provenance', async () => {
	await initWz({ forceWasm: true })
	const tempDir = await mkdtemp(path.join(tmpdir(), 'archived-wz-generation-'))
	try {
		// Trigger WASM mount
		const mountTrigger = path.join(tempDir, 'mount.wz')
		const mountFile = WzFile.create(158, MapleVersion.EMS)
		mountFile.saveToDisk(mountTrigger)
		mountFile.close()
		await rm(mountTrigger, { force: true })

		const tilePngPath = path.join(tempDir, 'tile.png')
		const tileSharp = sharp({
			create: { width: 4, height: 4, channels: 4, background: { r: 80, g: 120, b: 160, alpha: 1 } },
		})
		const pngBuf = await tileSharp.png().toBuffer()
		await writeFile(tilePngPath, pngBuf)

		const stringWzFile = path.join(tempDir, 'String.wz')
		const strFile = WzFile.create(158, MapleVersion.EMS)
		try {
			const strRoot = strFile.getWzDirectory()!
			const wmImg = strRoot.createImage('WorldMap.img')
			const wm0 = WzProperty.createSub('0')
			wm0.addProperty(WzProperty.createString('name', '楓之谷'))
			wmImg.addProperty(wm0)
			const wm010 = WzProperty.createSub('010')
			wm010.addProperty(WzProperty.createString('name', '維多利亞島'))
			wmImg.addProperty(wm010)

			const mapImg = strRoot.createImage('Map.img')
			const mapCat = WzProperty.createSub('victoria')
			const mapEntry = WzProperty.createSub('100000000')
			mapEntry.addProperty(WzProperty.createString('mapName', '弓箭手村'))
			mapEntry.addProperty(WzProperty.createString('streetName', '維多利亞島'))
			mapCat.addProperty(mapEntry)
			mapImg.addProperty(mapCat)

			strFile.saveToDisk(stringWzFile)
		}
		finally {
			strFile.close()
		}

		const mapWzFile = path.join(tempDir, 'Map.wz')
		const mapFile = WzFile.create(158, MapleVersion.EMS)
		try {
			const mapRoot = mapFile.getWzDirectory()!
			const wmDir = mapRoot.createDirectory('WorldMap')

			const wmImg = wmDir.createImage('WorldMap.img')
			const baseImg = WzProperty.createSub('BaseImg')
			const canvas0 = WzProperty.createCanvasFromPng('0', `/mnt${path.resolve(tilePngPath)}`)
			baseImg.addProperty(canvas0)
			wmImg.addProperty(baseImg)

			const mapList = WzProperty.createSub('MapList')
			const spot0 = WzProperty.createSub('0')
			spot0.addProperty(WzProperty.createVector('spot', 20, 30))
			spot0.addProperty(WzProperty.createInt('type', 1))
			const mapNo = WzProperty.createSub('mapNo')
			mapNo.addProperty(WzProperty.createInt('0', 100000000))
			spot0.addProperty(mapNo)
			mapList.addProperty(spot0)
			wmImg.addProperty(mapList)

			const mapLink = WzProperty.createSub('MapLink')
			const link0 = WzProperty.createSub('0')
			link0.addProperty(WzProperty.createString('toolTip', '維多利亞島'))
			const linkSub = WzProperty.createSub('link')
			linkSub.addProperty(WzProperty.createString('linkMap', 'WorldMap010'))
			const linkCanvas = WzProperty.createCanvasFromPng('linkImg', `/mnt${path.resolve(tilePngPath)}`)
			linkSub.addProperty(linkCanvas)
			link0.addProperty(linkSub)
			mapLink.addProperty(link0)
			wmImg.addProperty(mapLink)

			const wm010Img = wmDir.createImage('WorldMap010.img')
			const baseImg010 = WzProperty.createSub('BaseImg')
			const canvas010 = WzProperty.createCanvasFromPng('0', `/mnt${path.resolve(tilePngPath)}`)
			baseImg010.addProperty(canvas010)
			wm010Img.addProperty(baseImg010)
			const info010 = WzProperty.createSub('info')
			info010.addProperty(WzProperty.createString('parentMap', 'WorldMap'))
			wm010Img.addProperty(info010)

			const mapDir = mapRoot.createDirectory('Map')
			const map1Dir = mapDir.createDirectory('Map1')
			const m100Img = map1Dir.createImage('100000000.img')
			const mInfo = WzProperty.createSub('info')
			mInfo.addProperty(WzProperty.createString('bgm', 'Bgm00/FloralLife'))
			mInfo.addProperty(WzProperty.createString('mapMark', 'Henesys'))
			m100Img.addProperty(mInfo)

			mapFile.saveToDisk(mapWzFile)
		}
		finally {
			mapFile.close()
		}

		const catalogFile = path.join(tempDir, 'catalog.json')
		await writeFile(catalogFile, JSON.stringify([
			{
				name: 'FloralLife',
				filename: 'Bgm00/FloralLife',
				structureUrl: 'Bgm00/FloralLife.img',
				sourceType: 'wz',
				youtube: 'none',
				description: 'Henesys Theme',
			},
		]))

		const outputDir = path.join(tempDir, 'output')
		const publishedProvenance = {
			providerRegion: 'TWMS',
			providerVersion: '158',
			archiveItem: 'synthetic-archived-wz-fixture',
			archiveFile: 'synthetic-v158.7z',
			archiveSha1: '0'.repeat(40),
			members: {
				stringWz: { name: 'String.wz' as const, sha256: sha256(await readFile(stringWzFile)) },
				mapWz: { name: 'Map.wz' as const, sha256: sha256(await readFile(mapWzFile)) },
			},
		}
		await assert.rejects(
			runWorldMapGeneration({
				mode: 'full',
				snapshot: { region: 'TWMS', version: '158' },
				catalogSource: catalogFile,
				outputDir,
				workspace: tempDir,
				archivedWzPaths: {
					stringWzFile,
					mapWzFile,
					provenance: publishedProvenance,
				},
			}),
			/configured exact registry identity or hashes/,
		)
	}
	finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('acquireArchivedWzWorldMapGraph handles String.wz missing WorldMap.img with clear warning and link tooltip fallback', async () => {
	await initWz({ forceWasm: true })
	const tempDir = await mkdtemp(path.join(tmpdir(), 'archived-wz-missing-wm-img-'))
	try {
		// Trigger WASM mount
		const mountTrigger = path.join(tempDir, 'mount.wz')
		const mountFile = WzFile.create(124, MapleVersion.EMS)
		mountFile.saveToDisk(mountTrigger)
		mountFile.close()
		await rm(mountTrigger, { force: true })

		const tileSharp = sharp({
			create: { width: 4, height: 4, channels: 4, background: { r: 50, g: 50, b: 50, alpha: 1 } },
		})
		const tilePngPath = path.join(tempDir, 'tile.png')
		await writeFile(tilePngPath, await tileSharp.png().toBuffer())

		// String.wz without WorldMap.img (historical TWMS 124 shape)
		const stringWzFile = path.join(tempDir, 'String.wz')
		const strFile = WzFile.create(124, MapleVersion.EMS)
		try {
			const strRoot = strFile.getWzDirectory()!
			const mapImg = strRoot.createImage('Map.img')
			const mapCat = WzProperty.createSub('henesys')
			const mapEntry = WzProperty.createSub('100000000')
			mapEntry.addProperty(WzProperty.createString('mapName', '弓箭手村'))
			mapCat.addProperty(mapEntry)
			mapImg.addProperty(mapCat)
			strFile.saveToDisk(stringWzFile)
		}
		finally {
			strFile.close()
		}

		// Map.wz with WorldMap.img having a link with tooltip to WorldMap010
		const mapWzFile = path.join(tempDir, 'Map.wz')
		const mapFile = WzFile.create(124, MapleVersion.EMS)
		try {
			const mapRoot = mapFile.getWzDirectory()!
			const wmDir = mapRoot.createDirectory('WorldMap')

			const wmImg = wmDir.createImage('WorldMap.img')
			const baseImg = WzProperty.createSub('BaseImg')
			baseImg.addProperty(WzProperty.createCanvasFromPng('0', `/mnt${path.resolve(tilePngPath)}`))
			wmImg.addProperty(baseImg)

			const mapLink = WzProperty.createSub('MapLink')
			const link0 = WzProperty.createSub('0')
			link0.addProperty(WzProperty.createString('toolTip', '維多利亞島'))
			const linkSub = WzProperty.createSub('link')
			linkSub.addProperty(WzProperty.createString('linkMap', 'WorldMap010'))
			link0.addProperty(linkSub)
			mapLink.addProperty(link0)
			wmImg.addProperty(mapLink)

			const wm010Img = wmDir.createImage('WorldMap010.img')
			const baseImg010 = WzProperty.createSub('BaseImg')
			baseImg010.addProperty(WzProperty.createCanvasFromPng('0', `/mnt${path.resolve(tilePngPath)}`))
			wm010Img.addProperty(baseImg010)
			const info010 = WzProperty.createSub('info')
			info010.addProperty(WzProperty.createString('parentMap', 'WorldMap'))
			wm010Img.addProperty(info010)

			mapFile.saveToDisk(mapWzFile)
		}
		finally {
			mapFile.close()
		}

		const names = await parseArchivedWorldMapNames(stringWzFile, '124', 'EMS')
		assert.deepEqual(names, {})

		const graph = await acquireArchivedWzWorldMapGraph(
			{
				stringWzFile,
				mapWzFile,
				provenance: {
					providerRegion: 'TWMS',
					providerVersion: '124',
					archiveItem: 'exact-twms-124-archive',
					archiveFile: 'v124.7z',
					archiveSha1: '1'.repeat(40),
					members: {
						stringWz: { name: 'String.wz', sha256: '2'.repeat(64) },
						mapWz: { name: 'Map.wz', sha256: '3'.repeat(64) },
					},
				},
			},
			'TWMS',
			'124',
			{
				mode: 'preview',
				requests: [{ rootId: 'WorldMap', maxDepth: 2 }],
			},
			'EMS',
		)

		assert.ok(graph.warnings?.some(w => w.includes('String.wz contains no WorldMap.img')))
		assert.equal(graph.apiBase, 'https://archive.org/download/exact-twms-124-archive')
		assert.deepEqual(graph.worldMapNames, {})
		assert.equal(graph.nodes.find(n => n.id === 'WorldMap010')?.worldMapName, 'WorldMap010')
	}
	finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})
