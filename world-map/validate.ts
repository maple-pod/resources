import type { GameDataSource, LocalizedName, WorldMapAsset, WorldMapGraph, WorldMapIndex, WorldMapNode } from './schema'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import sharp from 'sharp'
import { parseGameBgmPath } from './music'
import { WORLD_MAP_SCHEMA_VERSION } from './schema'

export interface ValidationOptions {
	assetRoot: string
	bgmIds: ReadonlySet<string>
	requireGraph?: boolean
}

function fail(message: string): never {
	throw new Error(`World-map contract validation failed: ${message}`)
}

function assertFinite(value: number, field: string): void {
	if (!Number.isFinite(value))
		fail(`${field} must be finite`)
}

function validateSource(source: { pageTitle: string, revisionId: number, revisionTimestamp: string }, field: string): void {
	if (!source.pageTitle || !Number.isInteger(source.revisionId) || source.revisionId <= 0 || !Number.isFinite(Date.parse(source.revisionTimestamp)))
		fail(`${field} has invalid Wiki revision provenance`)
}

function validateGameDataSource(source: GameDataSource, field: string, allowUnavailable = false): void {
	const validVersion = source.version === null
		? allowUnavailable
		: Number.isSafeInteger(source.version) && source.version > 0
	if (source.provider !== 'maplestory-io' || !source.region || !validVersion || !/^https?:\/\//.test(source.apiBase))
		fail(`${field} has invalid MapleStory.IO provenance`)
}

async function validateImage(file: string, expectedSha1: string, assetRoot: string): Promise<void> {
	if (!file || isAbsolute(file) || file.includes('..'))
		fail(`image.file is not a safe relative path: ${file}`)
	const assetPath = resolve(assetRoot, file)
	const relativePath = relative(resolve(assetRoot), assetPath)
	if (relativePath.startsWith('..') || isAbsolute(relativePath))
		fail(`image.file escapes the asset root: ${file}`)
	let bytes: Uint8Array
	try {
		bytes = await readFile(assetPath)
	}
	catch {
		fail(`local image is missing: ${file}`)
	}
	const actualSha1 = createHash('sha1')
		.update(bytes)
		.digest('hex')
	if (actualSha1 !== expectedSha1)
		fail(`local image SHA-1 mismatch for ${file}: expected ${expectedSha1}, got ${actualSha1}`)
}

async function validateGraphAsset(asset: WorldMapAsset, assetRoot: string, field: string): Promise<void> {
	if (!Number.isInteger(asset.width) || asset.width <= 0 || !Number.isInteger(asset.height) || asset.height <= 0)
		fail(`${field} has invalid dimensions`)
	if (!Number.isInteger(asset.origin.x) || !Number.isInteger(asset.origin.y))
		fail(`${field} has invalid WZ origin`)
	if (!/^[a-f0-9]{40}$/i.test(asset.sha1))
		fail(`${field} has invalid SHA-1`)
	await validateImage(asset.file, asset.sha1, assetRoot)
	try {
		const metadata = await sharp(resolve(assetRoot, asset.file)).metadata()
		if (metadata.width !== asset.width || metadata.height !== asset.height)
			fail(`${field} dimensions do not match the local PNG`)
	}
	catch (error) {
		if (error instanceof Error && error.message.startsWith('World-map contract validation failed:'))
			throw error
		fail(`${field} is not a readable PNG`)
	}
}

function validateLocalizedNames(names: Record<string, LocalizedName>, field: string, join: 'mapId' | 'worldMapId'): void {
	for (const [locale, localized] of Object.entries(names)) {
		if (!locale || (localized.name != null && localized.name.trim() === ''))
			fail(`${field}.${locale} has an invalid localized name`)
		if (localized.status !== 'available' && localized.status !== 'unavailable')
			fail(`${field}.${locale} has an invalid localization status`)
		validateGameDataSource(localized.source, `${field}.${locale}.source`, localized.status === 'unavailable')
		if (localized.status === 'unavailable' && (localized.name !== null || localized.join !== null))
			fail(`${field}.${locale} has inconsistent unavailable localization`)
		if (localized.status === 'available') {
			if ((localized.name === null) !== (localized.join === null))
				fail(`${field}.${locale} has a localized name/join mismatch`)
			if (localized.join !== null && localized.join !== join)
				fail(`${field}.${locale} has the wrong localized-name join`)
		}
	}
}

function validateGraphBgm(node: WorldMapNode, map: WorldMapNode['spots'][number]['maps'][number], bgmIds: ReadonlySet<string>): void {
	if (map.gameBgm != null) {
		const parsed = parseGameBgmPath(map.gameBgm.path)
		const hasParts = map.gameBgm.structure != null && map.gameBgm.filename != null
		if (hasParts !== (parsed != null))
			fail(`${node.worldMapId}/${map.mapId} has inconsistent gameBgm path parts`)
		if (parsed != null && (parsed.structure !== map.gameBgm.structure || parsed.filename !== map.gameBgm.filename))
			fail(`${node.worldMapId}/${map.mapId} gameBgm path parts do not match path`)
		if (map.gameBgm.trackId != null && !bgmIds.has(map.gameBgm.trackId))
			fail(`${node.worldMapId}/${map.mapId} references unknown gameBgm track`)
	}
	if (map.selection.trackId != null && !bgmIds.has(map.selection.trackId))
		fail(`${node.worldMapId}/${map.mapId} selection references unknown track`)
	if (map.selection.source === null && map.selection.trackId !== null)
		fail(`${node.worldMapId}/${map.mapId} has a selection track without a source`)
	if (map.selection.source === 'gms-map-bgm' && map.selection.trackId !== map.gameBgm?.trackId)
		fail(`${node.worldMapId}/${map.mapId} selection is not the exact gameBgm catalog match`)
}

async function validateGraph(graph: WorldMapGraph, options: ValidationOptions): Promise<void> {
	const nodeById = new Map<string, WorldMapNode>()
	for (const node of graph.nodes) {
		if (!/^[a-z][a-z0-9]*$/i.test(node.worldMapId) || nodeById.has(node.worldMapId))
			fail(`invalid or duplicate native worldMapId: ${node.worldMapId}`)
		nodeById.set(node.worldMapId, node)
		validateGameDataSource(node.provenance, `${node.worldMapId}.provenance`)
		if (node.provenance.region !== 'GMS')
			fail(`${node.worldMapId}.provenance must use canonical GMS data`)
		if (node.baseImages.length === 0)
			fail(`${node.worldMapId} must have at least one base image`)
		for (const [index, asset] of node.baseImages.entries())
			await validateGraphAsset(asset, options.assetRoot, `${node.worldMapId}.baseImages[${index}]`)
		const base = node.baseImages[0]!
		const linkIds = new Set<string>()
		for (const link of node.links) {
			if (!linkIds.add(link.id))
				fail(`${node.worldMapId} has duplicate link id ${link.id}`)
			if (!/^[a-z][a-z0-9]*$/i.test(link.targetWorldMapId))
				fail(`${node.worldMapId}/${link.id} has a non-native target ID`)
			if (!Number.isInteger(link.screenOrigin.x) || !Number.isInteger(link.screenOrigin.y))
				fail(`${node.worldMapId}/${link.id} has invalid screen origin`)
			if (link.hitRect != null) {
				for (const value of Object.values(link.hitRect))
					assertFinite(value, `${node.worldMapId}/${link.id}.hitRect`)
				if (link.hitRect.width <= 0 || link.hitRect.height <= 0)
					fail(`${node.worldMapId}/${link.id} has a non-positive hit rectangle`)
			}
			if (link.linkImage != null)
				await validateGraphAsset(link.linkImage, options.assetRoot, `${node.worldMapId}/${link.id}.linkImage`)
			validateLocalizedNames(link.localizedNames, `${node.worldMapId}/${link.id}.localizedNames`, 'worldMapId')
		}
		const spotIds = new Set<string>()
		for (const spot of node.spots) {
			if (!spotIds.add(spot.id))
				fail(`${node.worldMapId} has duplicate spot id ${spot.id}`)
			if (spot.mapNumbers.some(mapId => !/^\d+$/.test(mapId)))
				fail(`${node.worldMapId}/${spot.id} has a non-numeric mapNumber`)
			if (!Number.isFinite(spot.point.x) || !Number.isFinite(spot.point.y) || !Number.isFinite(spot.point.normalizedX) || !Number.isFinite(spot.point.normalizedY))
				fail(`${node.worldMapId}/${spot.id} has invalid point geometry`)
			for (const map of spot.maps) {
				if (!spot.mapNumbers.includes(map.mapId))
					fail(`${node.worldMapId}/${spot.id}/${map.mapId} is not present in native mapNumbers`)
				validateLocalizedNames(map.localizedNames, `${node.worldMapId}/${spot.id}/${map.mapId}.localizedNames`, 'mapId')
				validateGraphBgm(node, map, options.bgmIds)
			}
		}
		if (base.width <= 0 || base.height <= 0)
			fail(`${node.worldMapId} has invalid base image dimensions`)
	}
	const roots = new Set(graph.roots)
	if (roots.size !== graph.roots.length)
		fail('graph roots contain duplicates')
	for (const root of graph.roots) {
		if (!nodeById.has(root) || nodeById.get(root)!.parentWorldMapId !== null)
			fail(`graph root ${root} is not a native parent-null node`)
	}
	for (const node of graph.nodes) {
		if (node.parentWorldMapId === null && !roots.has(node.worldMapId))
			fail(`parent-null node ${node.worldMapId} is missing from graph roots`)
		if (node.parentWorldMapId !== null && !/^[a-z][a-z0-9]*$/i.test(node.parentWorldMapId))
			fail(`${node.worldMapId} has a non-native parent ID`)
	}
}

export async function validateWorldMapIndex(index: WorldMapIndex, options: ValidationOptions): Promise<void> {
	if (index.schemaVersion !== WORLD_MAP_SCHEMA_VERSION)
		fail(`unsupported schemaVersion: ${String(index.schemaVersion)}`)
	if (!Number.isFinite(Date.parse(index.generatedAt)))
		fail('generatedAt must be an ISO date')
	if (options.requireGraph && index.graph == null)
		fail('canonical v6 graph is required')
	if (index.graph != null)
		await validateGraph(index.graph, options)
	const worldIds = new Set<string>()
	for (const world of index.worlds) {
		if (!world.id || worldIds.has(world.id))
			fail(`duplicate or empty world id: ${world.id}`)
		worldIds.add(world.id)
		if (!Number.isInteger(world.image.width) || world.image.width <= 0 || !Number.isInteger(world.image.height) || world.image.height <= 0)
			fail(`invalid image dimensions for world ${world.id}`)
		if (!/^[a-f0-9]{40}$/i.test(world.image.sha1))
			fail(`invalid image SHA-1 for world ${world.id}`)
		validateSource(world.source, `${world.id}.source`)
		if (world.gameData == null)
			fail(`${world.id}.gameData is required for canonical GMS output`)
		validateGameDataSource(world.gameData, `${world.id}.gameData`)
		if (world.gameData.region !== 'GMS')
			fail(`${world.id}.gameData must use canonical GMS data, got ${world.gameData.region}`)
		await validateImage(world.image.file, world.image.sha1, options.assetRoot)

		const landmarkIds = new Set<string>()
		for (const landmark of world.landmarks) {
			if (!landmark.id || landmarkIds.has(landmark.id))
				fail(`duplicate or empty landmark id in ${world.id}: ${landmark.id}`)
			landmarkIds.add(landmark.id)
			for (const [field, value] of Object.entries(landmark.position)) {
				assertFinite(value, `${world.id}/${landmark.id}.position.${field}`)
				if (value < 0 || value > 1)
					fail(`${world.id}/${landmark.id}.position.${field} is outside [0, 1]`)
			}
			if (landmark.position.left + landmark.position.width > 1 || landmark.position.top + landmark.position.height > 1)
				fail(`${world.id}/${landmark.id}.position is outside image bounds`)
			if (landmark.position.width <= 0 || landmark.position.height <= 0)
				fail(`${world.id}/${landmark.id}.position must have positive dimensions`)
			if (!['map', 'world-map', 'unresolved', 'manual-fallback'].includes(landmark.identity))
				fail(`${world.id}/${landmark.id} has an invalid identity status`)
			if (landmark.target.mapId != null && !/^\d+$/.test(landmark.target.mapId))
				fail(`${world.id}/${landmark.id} has a non-numeric mapId`)
			if (landmark.target.name != null && landmark.target.name.trim() === '')
				fail(`${world.id}/${landmark.id} has an empty canonical name`)
			if (landmark.target.worldMapId != null && !/^WorldMap[0-9A-Za-z]+$/.test(landmark.target.worldMapId))
				fail(`${world.id}/${landmark.id} has an invalid game-native worldMapId`)
			if (landmark.target.mapMark != null && landmark.target.mapMark.trim() === '')
				fail(`${world.id}/${landmark.id} has an empty mapMark`)
			if (landmark.identity === 'map' && landmark.target.mapId == null)
				fail(`${world.id}/${landmark.id} has map identity without mapId`)
			if (landmark.identity === 'world-map' && (landmark.target.mapId != null || landmark.target.worldMapId == null))
				fail(`${world.id}/${landmark.id} has invalid world-map identity fields`)
			if (landmark.identity === 'unresolved' && (landmark.target.mapId != null || landmark.target.worldMapId != null))
				fail(`${world.id}/${landmark.id} marks a resolved target as unresolved`)
			if (landmark.identity === 'unresolved' && !landmark.id.startsWith('region:unresolved:'))
				fail(`${world.id}/${landmark.id} has an unresolved identity without the explicit unresolved namespace`)
			if (landmark.identity === 'manual-fallback')
				fail(`${world.id}/${landmark.id} uses a manual identity fallback; this must be reviewed explicitly`)
			for (const [locale, localized] of Object.entries(landmark.target.localizedNames)) {
				if (!locale || (localized.name != null && localized.name.trim() === ''))
					fail(`${world.id}/${landmark.id} has an invalid localized name for ${locale}`)
				if (localized.status !== 'available' && localized.status !== 'unavailable')
					fail(`${world.id}/${landmark.id} has an invalid localization status for ${locale}`)
				validateGameDataSource(localized.source, `${world.id}/${landmark.id}.localizedNames.${locale}.source`, localized.status === 'unavailable')
				if (localized.join !== null && localized.join !== 'mapId' && localized.join !== 'worldMapId')
					fail(`${world.id}/${landmark.id} has an invalid localized-name join for ${locale}`)
				if (localized.status === 'unavailable' && (localized.name !== null || localized.join !== null))
					fail(`${world.id}/${landmark.id} has inconsistent unavailable localization for ${locale}`)
				if (localized.status === 'available') {
					if ((localized.join === null) !== (localized.name === null))
						fail(`${world.id}/${landmark.id} has a localized name/join mismatch for ${locale}`)
					if (localized.join === 'mapId' && landmark.target.mapId === null)
						fail(`${world.id}/${landmark.id} joins localized ${locale} by mapId without a canonical mapId`)
					if (localized.join === 'worldMapId' && landmark.target.mapId !== null)
						fail(`${world.id}/${landmark.id} joins localized ${locale} by worldMapId despite having a canonical mapId`)
					if (localized.join === 'worldMapId' && landmark.target.worldMapId === null)
						fail(`${world.id}/${landmark.id} joins localized ${locale} by worldMapId without a canonical worldMapId`)
				}
			}
			if (landmark.source != null)
				validateSource(landmark.source, `${world.id}/${landmark.id}.source`)
			for (const trackId of landmark.tracks) {
				if (!options.bgmIds.has(trackId))
					fail(`${world.id}/${landmark.id} references unknown track: ${trackId}`)
			}
			if (landmark.bgm.unmappedKeys.some(key => !landmark.bgm.sourceKeys.includes(key)))
				fail(`${world.id}/${landmark.id} contains an unmapped key not present in sourceKeys`)
			if (!['not-compared', 'agree', 'disagree', 'gms-unmapped', 'wiki-fallback'].includes(landmark.bgm.reconciliation.status))
				fail(`${world.id}/${landmark.id} has an invalid BGM reconciliation status`)
			for (const trackId of landmark.bgm.reconciliation.wikiTrackIds) {
				if (!landmark.tracks.includes(trackId) || !options.bgmIds.has(trackId))
					fail(`${world.id}/${landmark.id} has an invalid Wiki reconciliation track: ${trackId}`)
			}
			if (landmark.gameBgm != null) {
				if (!landmark.gameBgm.path)
					fail(`${world.id}/${landmark.id} has an empty gameBgm path`)
				const parsed = parseGameBgmPath(landmark.gameBgm.path)
				const hasParts = landmark.gameBgm.structure != null && landmark.gameBgm.filename != null
				if (hasParts !== (parsed != null))
					fail(`${world.id}/${landmark.id} has inconsistent gameBgm path parts`)
				if (parsed != null && (parsed.structure !== landmark.gameBgm.structure || parsed.filename !== landmark.gameBgm.filename))
					fail(`${world.id}/${landmark.id} gameBgm path parts do not match path`)
				if (landmark.gameBgm.trackId != null && !options.bgmIds.has(landmark.gameBgm.trackId))
					fail(`${world.id}/${landmark.id} references unknown gameBgm track: ${landmark.gameBgm.trackId}`)
				if (landmark.gameBgm.trackId != null && !hasParts)
					fail(`${world.id}/${landmark.id} has a gameBgm track without parsed path parts`)
			}
			const { trackId, source } = landmark.selection
			if (trackId != null && !options.bgmIds.has(trackId))
				fail(`${world.id}/${landmark.id} selection references unknown track: ${trackId}`)
			if (source === null && trackId !== null)
				fail(`${world.id}/${landmark.id} has a track selection without a source`)
			if (source !== null && trackId === null)
				fail(`${world.id}/${landmark.id} has a selection source without a track`)
			if (source === 'gms-map-bgm' && (landmark.target.mapId == null || landmark.gameBgm?.trackId !== trackId))
				fail(`${world.id}/${landmark.id} has an invalid GMS music selection provenance`)
			if (source === 'wiki' && (landmark.target.mapId != null || landmark.gameBgm != null || landmark.bgm.reconciliation.status !== 'wiki-fallback'))
				fail(`${world.id}/${landmark.id} has an invalid Wiki music selection fallback`)
			if (landmark.gameBgm != null && landmark.target.mapId == null)
				fail(`${world.id}/${landmark.id} has GMS map BGM evidence without a numeric map identity`)
			if (landmark.bgm.reconciliation.status === 'agree' && source !== 'gms-map-bgm')
				fail(`${world.id}/${landmark.id} marks Wiki/GMS BGM as agreeing without a GMS selection`)
			const gameTrackId = landmark.gameBgm?.trackId ?? null
			if (gameTrackId != null) {
				const expectedStatus = landmark.bgm.reconciliation.wikiTrackIds.some(wikiTrackId => wikiTrackId !== gameTrackId)
					? 'disagree'
					: landmark.bgm.reconciliation.wikiTrackIds.length === 1 && landmark.bgm.reconciliation.wikiTrackIds[0] === gameTrackId && landmark.bgm.unmappedKeys.length === 0
						? 'agree'
						: 'not-compared'
				if (landmark.bgm.reconciliation.status !== expectedStatus)
					fail(`${world.id}/${landmark.id} has an inconsistent Wiki/GMS BGM reconciliation status`)
			}
			if (landmark.bgm.reconciliation.status === 'disagree' && gameTrackId == null)
				fail(`${world.id}/${landmark.id} marks a Wiki/GMS disagreement without valid GMS BGM evidence`)
			if (landmark.bgm.reconciliation.status === 'gms-unmapped' && (landmark.gameBgm == null || gameTrackId != null || source !== null))
				fail(`${world.id}/${landmark.id} marks an unmapped GMS BGM with a resolved selection`)
			if (landmark.bgm.reconciliation.status === 'wiki-fallback' && source !== 'wiki')
				fail(`${world.id}/${landmark.id} marks a Wiki fallback without a Wiki selection`)
		}
	}
}
