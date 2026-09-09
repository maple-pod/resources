import type { LocalizedName, WorldMap } from './schema'
import type { GameMapDetail, LocalizationAttempt, LocalizedGameDataSnapshot } from './source'

function sourceOf(snapshot: LocalizedGameDataSnapshot) {
	return {
		provider: snapshot.provider,
		region: snapshot.region,
		version: snapshot.version,
		apiBase: snapshot.apiBase,
	} as const
}

function unavailableName(attempt: LocalizationAttempt): LocalizedName {
	return {
		name: null,
		source: attempt.source,
		status: 'unavailable',
		join: null,
	}
}

function uniqueMap(snapshot: LocalizedGameDataSnapshot, mapId: string): GameMapDetail | null {
	const matches = snapshot.maps.filter(map => map.id === mapId)
	return matches.length === 1 ? matches[0]! : null
}

function uniqueWorldMapLink(snapshot: LocalizedGameDataSnapshot, worldMapId: string): string | null {
	const matches = snapshot.worldMaps.flatMap(worldMap => worldMap.links.filter(link => link.linksTo === worldMapId))
	if (matches.length !== 1)
		return null
	return matches[0]!.toolTip
}

function assertUniqueAttempts(attempts: readonly LocalizationAttempt[]): void {
	const locales = new Set<string>()
	for (const attempt of attempts) {
		if (!attempt.locale || locales.has(attempt.locale))
			throw new Error(`Duplicate or empty localization locale: ${attempt.locale}`)
		locales.add(attempt.locale)
	}
}

/** Enriches an already canonical GMS world without allowing locale data to alter identity. */
export function localizeWorldMap(world: WorldMap, attempts: readonly LocalizationAttempt[] | readonly LocalizedGameDataSnapshot[]): WorldMap {
	const normalizedAttempts: LocalizationAttempt[] = attempts.map((attempt) => {
		if ('snapshot' in attempt)
			return attempt
		return { locale: attempt.locale, source: sourceOf(attempt), snapshot: attempt }
	})
	assertUniqueAttempts(normalizedAttempts)
	return {
		...world,
		landmarks: world.landmarks.map((landmark) => {
			const localizedNames: WorldMap['landmarks'][number]['target']['localizedNames'] = {}
			for (const attempt of normalizedAttempts) {
				if (attempt.snapshot == null) {
					localizedNames[attempt.locale] = unavailableName(attempt)
					continue
				}
				const snapshot = attempt.snapshot
				const map = landmark.target.mapId == null ? null : uniqueMap(snapshot, landmark.target.mapId)
				const mapJoin = landmark.target.mapId != null && map != null && map.name != null && map.name.trim() !== ''
				const linkedName = landmark.target.mapId == null && landmark.target.worldMapId != null
					? uniqueWorldMapLink(snapshot, landmark.target.worldMapId)
					: null
				const regionJoin = landmark.target.mapId == null && linkedName != null && linkedName.trim() !== ''
				localizedNames[attempt.locale] = {
					name: mapJoin ? map.name : regionJoin ? linkedName : null,
					source: sourceOf(snapshot),
					status: 'available',
					join: mapJoin ? 'mapId' : regionJoin ? 'worldMapId' : null,
				}
			}
			return {
				...landmark,
				target: {
					...landmark.target,
					localizedNames,
				},
			}
		}),
	}
}
