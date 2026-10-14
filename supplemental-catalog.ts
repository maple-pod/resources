import { createHash } from 'node:crypto'

export interface TrackMetadata {
	albumArtist: string
	artist: string
	title: string
	year: string
}

export interface MapleSource {
	client: string
	date: string
	structure: string
	version: string
}

export type MapleStoryIoRegion = 'GMS' | 'TWMS' | 'KMS' | 'JMS'

export type SupplementalCatalogStatus
	= { membership: 'supplemental', status: 'pending-upstream', tracking: string }
		| { membership: 'supplemental', status: 'curated' }

export interface UpstreamTrack {
	description: string
	filename: string
	mark: string
	metadata: TrackMetadata
	source: MapleSource
	youtube: string
	[key: string]: unknown
}

export interface MapleStoryIoWzAudioSource {
	type: 'maplestory-io-wz-audio'
	region: MapleStoryIoRegion
	version: string
	path: string
	sha256: string
	codec: 'mp3'
	sampleRate: number
	duration: number
}

export interface SupplementalTrack {
	id: string
	filename: string
	description: string
	mark: string
	metadata: TrackMetadata
	metadataAuthority: {
		kind: 'supplemental-curation'
		evidence: string[]
	}
	catalog: SupplementalCatalogStatus
	lifecycle: {
		status: 'active' | 'disabled' | 'retired'
	}
	acquisition: MapleStoryIoWzAudioSource
	source: MapleSource
}

export interface SupplementalCatalog {
	schemaVersion: 1
	entries: SupplementalTrack[]
}

export interface Promotion {
	supplementalId: string
	upstream: {
		filename: string
		youtube: string
		source: Pick<MapleSource, 'client' | 'structure' | 'version'>
	}
	identityEquivalence: {
		verified: boolean
		evidence: string
	}
}

export interface PromotionMap {
	schemaVersion: 1
	promotions: Promotion[]
}

export interface MergedTrack extends UpstreamTrack {
	stableId?: string
	aliases?: string[]
	acquisition: { type: 'youtube', videoId: string } | MapleStoryIoWzAudioSource
	metadataAuthority?: {
		kind: 'supplemental-curation' | 'upstream'
		evidence: string[]
	}
	catalog?: SupplementalCatalogStatus
	audioProvenance?: {
		provider: 'maplestory.io'
		apiBase: 'https://maplestory.io/api/wz/audio'
		region: MapleStoryIoRegion
		version: string
		path: string
		sha256: string
	}
}

const supplementalIdPattern = /^supplemental:[a-z0-9]+(?:-[a-z0-9]+)*$/
const localFilenamePattern = /^[\w-]+$/
const numericVersionPattern = /^(?:0|[1-9]\d*)$/
const sha256Pattern = /^[\da-f]{64}$/i
const mapleStoryIoRegions = new Set<MapleStoryIoRegion>(['GMS', 'TWMS', 'KMS', 'JMS'])
const MIN_MP3_SAMPLE_RATE = 8_000
const MAX_MP3_SAMPLE_RATE = 48_000
const MAX_AUDIO_DURATION_SECONDS = 3_600

function record(value: unknown, path: string): Record<string, unknown> {
	if (value == null || typeof value !== 'object' || Array.isArray(value))
		throw new Error(`${path} must be an object`)
	return value as Record<string, unknown>
}

function string(value: unknown, path: string, allowEmpty = false): string {
	if (typeof value !== 'string' || (!allowEmpty && value.trim() === ''))
		throw new Error(`${path} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`)
	return value
}

function mapleStoryIoRegion(value: unknown, path: string): MapleStoryIoRegion {
	const region = string(value, path)
	if (!mapleStoryIoRegions.has(region as MapleStoryIoRegion))
		throw new Error(`${path} must be one of GMS, TWMS, KMS, or JMS`)
	return region as MapleStoryIoRegion
}

function numericVersion(value: unknown, path: string): string {
	const version = string(value, path)
	if (!numericVersionPattern.test(version))
		throw new Error(`${path} must be an exact numeric pinned version`)
	return version
}

function safeSoundPath(value: unknown, path: string, requireMp3: boolean): string[] {
	const soundPath = string(value, path)
	if (soundPath.length > 1_024 || !soundPath.startsWith('Sound/'))
		throw new Error(`${path} must be a relative MapleStory WZ path under Sound/`)
	const segments = soundPath.split('/')
	if (segments.length < 2 || segments.some(segment => segment === '' || segment === '.' || segment === '..'))
		throw new Error(`${path} contains an empty or traversal path segment`)
	for (const segment of segments) {
		if (segment.trim() !== segment || /[%?#\\:\p{Cc}\p{Cf}]/u.test(segment))
			throw new Error(`${path} contains an unsafe path segment`)
		try {
			encodeURIComponent(segment)
		}
		catch {
			throw new Error(`${path} contains an invalid encoded path segment`)
		}
	}
	if (requireMp3 && !segments.at(-1)!.endsWith('.mp3'))
		throw new Error(`${path} must identify an MP3 file`)
	return segments
}

function validateWzAudioSource(source: MapleStoryIoWzAudioSource, path: string): void {
	mapleStoryIoRegion(source.region, `${path}.region`)
	numericVersion(source.version, `${path}.version`)
	safeSoundPath(source.path, `${path}.path`, true)
	if (!sha256Pattern.test(source.sha256))
		throw new Error(`${path}.sha256 must be a 64-character hexadecimal SHA-256 pin`)
	if (source.codec !== 'mp3')
		throw new Error(`${path}.codec must be mp3`)
	if (!Number.isInteger(source.sampleRate) || source.sampleRate < MIN_MP3_SAMPLE_RATE || source.sampleRate > MAX_MP3_SAMPLE_RATE)
		throw new Error(`${path}.sampleRate must be an integer from ${MIN_MP3_SAMPLE_RATE} to ${MAX_MP3_SAMPLE_RATE}`)
	if (!Number.isFinite(source.duration) || source.duration <= 0 || source.duration > MAX_AUDIO_DURATION_SECONDS)
		throw new Error(`${path}.duration must be greater than 0 and at most ${MAX_AUDIO_DURATION_SECONDS} seconds`)
}

function httpsUrl(value: unknown, path: string): string {
	if (typeof value !== 'string' || value.trim() === '' || value.trim() !== value)
		throw new Error(`${path} must be an absolute HTTPS URL`)
	const urlValue = value
	let url: URL
	try {
		url = new URL(urlValue)
	}
	catch {
		throw new Error(`${path} must be an absolute HTTPS URL`)
	}
	if (url.protocol !== 'https:' || !url.hostname || url.username || url.password)
		throw new Error(`${path} must be an absolute HTTPS URL without credentials`)
	return urlValue
}

function parseCatalogStatus(value: unknown, path: string): SupplementalCatalogStatus {
	const catalog = record(value, path)
	if (catalog.membership !== 'supplemental')
		throw new Error(`${path}.membership must be supplemental`)
	if (catalog.status === 'pending-upstream') {
		return {
			membership: 'supplemental',
			status: 'pending-upstream',
			tracking: httpsUrl(catalog.tracking, `${path}.tracking`),
		}
	}
	if (catalog.status === 'curated') {
		if (catalog.tracking !== undefined)
			throw new Error(`${path}.tracking is only valid when status is pending-upstream`)
		return { membership: 'supplemental', status: 'curated' }
	}
	throw new Error(`${path}.status must be pending-upstream or curated`)
}

export function validateSupplementalCatalog(value: unknown): SupplementalCatalog {
	const root = record(value, 'catalog')
	if (root.schemaVersion !== 1)
		throw new Error('catalog.schemaVersion must be 1')
	if (!Array.isArray(root.entries))
		throw new Error('catalog.entries must be an array')

	const ids = new Set<string>()
	const filenames = new Set<string>()
	const entries = root.entries.map((rawEntry, index) => {
		const entryPath = `catalog.entries[${index}]`
		const entry = record(rawEntry, entryPath)
		const id = string(entry.id, `${entryPath}.id`)
		if (!supplementalIdPattern.test(id))
			throw new Error(`${entryPath}.id must use the supplemental:<stable-slug> namespace`)
		if (ids.has(id))
			throw new Error(`Duplicate supplemental id: ${id}`)
		ids.add(id)

		const filename = string(entry.filename, `${entryPath}.filename`)
		if (!localFilenamePattern.test(filename))
			throw new Error(`${entryPath}.filename must be a physical-file-safe stem without ':'`)
		if (filenames.has(filename))
			throw new Error(`Duplicate supplemental filename: ${filename}`)
		filenames.add(filename)

		const metadata = record(entry.metadata, `${entryPath}.metadata`)
		const authority = record(entry.metadataAuthority, `${entryPath}.metadataAuthority`)
		if (authority.kind !== 'supplemental-curation' || !Array.isArray(authority.evidence))
			throw new Error(`${entryPath}.metadataAuthority must include supplemental-curation evidence`)
		const evidence = authority.evidence.map((item, evidenceIndex) => string(item, `${entryPath}.metadataAuthority.evidence[${evidenceIndex}]`))
		if (evidence.length === 0)
			throw new Error(`${entryPath}.metadataAuthority.evidence must not be empty`)
		const catalog = parseCatalogStatus(entry.catalog, `${entryPath}.catalog`)
		const lifecycle = record(entry.lifecycle, `${entryPath}.lifecycle`)
		if (!['active', 'disabled', 'retired'].includes(String(lifecycle.status)))
			throw new Error(`${entryPath}.lifecycle.status must be active, disabled, or retired`)

		const acquisition = record(entry.acquisition, `${entryPath}.acquisition`)
		if (acquisition.type !== 'maplestory-io-wz-audio')
			throw new Error(`${entryPath}.acquisition.type is not supported`)
		const acquisitionRegion = mapleStoryIoRegion(acquisition.region, `${entryPath}.acquisition.region`)
		const acquisitionVersion = numericVersion(acquisition.version, `${entryPath}.acquisition.version`)
		const acquisitionPath = string(acquisition.path, `${entryPath}.acquisition.path`)
		const acquisitionHash = string(acquisition.sha256, `${entryPath}.acquisition.sha256`).toLowerCase()
		const codec = string(acquisition.codec, `${entryPath}.acquisition.codec`)
		const sampleRate = acquisition.sampleRate
		const duration = acquisition.duration
		const parsedAcquisition: MapleStoryIoWzAudioSource = {
			type: 'maplestory-io-wz-audio',
			region: acquisitionRegion,
			version: acquisitionVersion,
			path: acquisitionPath,
			sha256: acquisitionHash,
			codec: codec as 'mp3',
			sampleRate: sampleRate as number,
			duration: duration as number,
		}
		validateWzAudioSource(parsedAcquisition, `${entryPath}.acquisition`)

		const source = record(entry.source, `${entryPath}.source`)
		const sourceClient = mapleStoryIoRegion(source.client, `${entryPath}.source.client`)
		const sourceVersion = numericVersion(source.version, `${entryPath}.source.version`)
		const sourceStructure = string(source.structure, `${entryPath}.source.structure`)
		const sourcePathSegments = safeSoundPath(sourceStructure, `${entryPath}.source.structure`, false)
		const acquisitionPathSegments = safeSoundPath(parsedAcquisition.path, `${entryPath}.acquisition.path`, true)
		const parsedSource: MapleSource = {
			client: sourceClient,
			date: string(source.date, `${entryPath}.source.date`, true),
			structure: sourceStructure,
			version: sourceVersion,
		}
		if (parsedSource.client !== parsedAcquisition.region || parsedSource.version !== parsedAcquisition.version)
			throw new Error(`${entryPath}.source region/version must match the pinned acquisition`)
		if (sourcePathSegments.length !== acquisitionPathSegments.length - 1
			|| !sourcePathSegments.every((segment, segmentIndex) => segment === acquisitionPathSegments[segmentIndex])) {
			throw new Error(`${entryPath}.source.structure must be the parent of acquisition.path`)
		}
		const mark = string(entry.mark, `${entryPath}.mark`)
		if (!localFilenamePattern.test(mark))
			throw new Error(`${entryPath}.mark must be a file-safe mark stem`)

		return {
			id,
			filename,
			description: string(entry.description, `${entryPath}.description`, true),
			mark,
			metadata: {
				albumArtist: string(metadata.albumArtist, `${entryPath}.metadata.albumArtist`, true),
				artist: string(metadata.artist, `${entryPath}.metadata.artist`, true),
				title: string(metadata.title, `${entryPath}.metadata.title`),
				year: string(metadata.year, `${entryPath}.metadata.year`, true),
			},
			metadataAuthority: { kind: 'supplemental-curation' as const, evidence },
			catalog,
			lifecycle: { status: lifecycle.status as SupplementalTrack['lifecycle']['status'] },
			acquisition: parsedAcquisition,
			source: parsedSource,
		}
	})

	return { schemaVersion: 1, entries }
}

export function validatePromotionMap(value: unknown): PromotionMap {
	const root = record(value, 'promotionMap')
	if (root.schemaVersion !== 1)
		throw new Error('promotionMap.schemaVersion must be 1')
	if (!Array.isArray(root.promotions))
		throw new Error('promotionMap.promotions must be an array')
	const supplementalIds = new Set<string>()
	const upstreamFilenames = new Set<string>()
	const promotions = root.promotions.map((rawPromotion, index) => {
		const promotionPath = `promotionMap.promotions[${index}]`
		const promotion = record(rawPromotion, promotionPath)
		const supplementalId = string(promotion.supplementalId, `${promotionPath}.supplementalId`)
		if (!supplementalIdPattern.test(supplementalId))
			throw new Error(`${promotionPath}.supplementalId must use the supplemental namespace`)
		if (supplementalIds.has(supplementalId))
			throw new Error(`Duplicate promotion target: ${supplementalId}`)
		supplementalIds.add(supplementalId)

		const upstream = record(promotion.upstream, `${promotionPath}.upstream`)
		const filename = string(upstream.filename, `${promotionPath}.upstream.filename`)
		if (upstreamFilenames.has(filename))
			throw new Error(`Duplicate promotion upstream filename: ${filename}`)
		upstreamFilenames.add(filename)
		const source = record(upstream.source, `${promotionPath}.upstream.source`)
		const identityEquivalence = record(promotion.identityEquivalence, `${promotionPath}.identityEquivalence`)
		if (identityEquivalence.verified !== true)
			throw new Error(`${promotionPath}.identityEquivalence.verified must be true before promotion`)
		const equivalenceEvidence = string(identityEquivalence.evidence, `${promotionPath}.identityEquivalence.evidence`)

		return {
			supplementalId,
			upstream: {
				filename,
				youtube: string(upstream.youtube, `${promotionPath}.upstream.youtube`),
				source: {
					client: string(source.client, `${promotionPath}.upstream.source.client`),
					structure: string(source.structure, `${promotionPath}.upstream.source.structure`),
					version: string(source.version, `${promotionPath}.upstream.source.version`),
				},
			},
			identityEquivalence: {
				verified: identityEquivalence.verified,
				evidence: equivalenceEvidence,
			},
		}
	})
	return { schemaVersion: 1, promotions }
}

export function mergeSupplementalCatalog(
	upstream: readonly UpstreamTrack[],
	catalogInput: unknown,
	promotionMapInput: unknown,
): MergedTrack[] {
	const catalog = validateSupplementalCatalog(catalogInput)
	const promotionMap = validatePromotionMap(promotionMapInput)
	const upstreamByFilename = new Map<string, UpstreamTrack>()
	for (const item of upstream) {
		if (!item.filename)
			throw new Error('Upstream track filename must be non-empty')
		if (upstreamByFilename.has(item.filename))
			throw new Error(`Duplicate upstream filename: ${item.filename}`)
		upstreamByFilename.set(item.filename, item)
	}

	const catalogById = new Map(catalog.entries.map(entry => [entry.id, entry]))
	const promotionByUpstream = new Map<string, Promotion>()
	for (const promotion of promotionMap.promotions) {
		const supplemental = catalogById.get(promotion.supplementalId)
		if (!supplemental)
			throw new Error(`Promotion target does not exist: ${promotion.supplementalId}`)
		if (supplemental.lifecycle.status !== 'active')
			throw new Error(`Promotion target is not active: ${promotion.supplementalId}`)
		if (!promotion.identityEquivalence.verified || !promotion.identityEquivalence.evidence.trim())
			throw new Error(`Promotion ${promotion.supplementalId} requires verified identity-equivalence evidence`)
		const upstreamItem = upstreamByFilename.get(promotion.upstream.filename)
		if (!upstreamItem)
			throw new Error(`Promotion upstream track does not exist: ${promotion.upstream.filename}`)
		if (upstreamItem.youtube !== promotion.upstream.youtube
			|| upstreamItem.source.client !== promotion.upstream.source.client
			|| upstreamItem.source.structure !== promotion.upstream.source.structure
			|| upstreamItem.source.version !== promotion.upstream.source.version) {
			throw new Error(`Promotion identity mismatch for upstream track: ${promotion.upstream.filename}`)
		}
		promotionByUpstream.set(promotion.upstream.filename, promotion)
	}

	const allUpstreamFilenames = new Set(upstream.map(item => item.filename))
	for (const entry of catalog.entries) {
		if (allUpstreamFilenames.has(entry.filename))
			throw new Error(`Supplemental physical filename collides with upstream filename: ${entry.filename}`)
	}

	const result: MergedTrack[] = []
	const outputIds = new Set<string>()
	const outputFilenames = new Set<string>()
	const append = (track: MergedTrack): void => {
		const id = track.stableId ?? track.filename
		if (outputIds.has(id))
			throw new Error(`Merged track id collision: ${id}`)
		if (outputFilenames.has(track.filename))
			throw new Error(`Merged physical filename collision: ${track.filename}`)
		outputIds.add(id)
		outputFilenames.add(track.filename)
		result.push(track)
	}

	for (const item of upstream) {
		const promotion = promotionByUpstream.get(item.filename)
		if (!promotion) {
			append({ ...item, acquisition: { type: 'youtube', videoId: item.youtube } })
			continue
		}
		const supplemental = catalogById.get(promotion.supplementalId)!
		append({
			...item,
			filename: supplemental.filename,
			stableId: supplemental.id,
			aliases: [item.filename],
			acquisition: supplemental.acquisition,
			catalog: { membership: 'supplemental', status: 'curated' },
			metadataAuthority: {
				kind: 'upstream',
				evidence: [`upstream:${item.filename}`, ...supplemental.metadataAuthority.evidence],
			},
			audioProvenance: {
				provider: 'maplestory.io',
				apiBase: 'https://maplestory.io/api/wz/audio',
				region: supplemental.acquisition.region,
				version: supplemental.acquisition.version,
				path: supplemental.acquisition.path,
				sha256: supplemental.acquisition.sha256,
			},
		})
	}

	const promotedIds = new Set(promotionMap.promotions.map(promotion => promotion.supplementalId))
	for (const entry of catalog.entries) {
		if (entry.lifecycle.status !== 'active' || promotedIds.has(entry.id))
			continue
		append({
			description: entry.description,
			filename: entry.filename,
			mark: entry.mark,
			metadata: entry.metadata,
			source: entry.source,
			youtube: '',
			stableId: entry.id,
			acquisition: entry.acquisition,
			catalog: entry.catalog,
			metadataAuthority: entry.metadataAuthority,
			audioProvenance: {
				provider: 'maplestory.io',
				apiBase: 'https://maplestory.io/api/wz/audio',
				region: entry.acquisition.region,
				version: entry.acquisition.version,
				path: entry.acquisition.path,
				sha256: entry.acquisition.sha256,
			},
		})
	}

	const stableIdOwners = new Map(result.map(track => [track.stableId ?? track.filename, track]))
	const aliasOwners = new Map<string, MergedTrack>()
	for (const track of result) {
		if (track.aliases == null)
			continue
		if (!Array.isArray(track.aliases))
			throw new Error(`Merged track aliases must be an array: ${track.stableId ?? track.filename}`)
		for (const alias of track.aliases) {
			if (typeof alias !== 'string' || alias.trim() === '')
				throw new Error(`Merged track alias must be a non-empty string: ${track.stableId ?? track.filename}`)
			const stableIdOwner = stableIdOwners.get(alias)
			if (stableIdOwner && stableIdOwner !== track)
				throw new Error(`Merged track alias collides with another stable ID: ${alias}`)
			if (stableIdOwner === track)
				throw new Error(`Merged track alias duplicates its stable ID: ${alias}`)
			const aliasOwner = aliasOwners.get(alias)
			if (aliasOwner && aliasOwner !== track)
				throw new Error(`Duplicate merged track alias: ${alias}`)
			aliasOwners.set(alias, track)
		}
	}

	return result
}

export function getAudioSourceFingerprint(source: MergedTrack['acquisition']): string {
	const identity = source.type === 'youtube'
		? { type: source.type, videoId: source.videoId }
		: { type: source.type, region: source.region, version: source.version, path: source.path, sha256: source.sha256 }
	return createHash('sha256')
		.update(JSON.stringify(identity))
		.digest('hex')
}

export function validatePinnedWzAudioSource(source: MapleStoryIoWzAudioSource): void {
	validateWzAudioSource(source, 'acquisition')
}
