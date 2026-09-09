import type { GameWorldMap, LocalizedGameDataSnapshot } from '../../world-map/source'

const VICTORIA_LINKS = [
	['Nautilus', 'WorldMap011'],
	['Sleepywood', 'WorldMap012'],
	['Ellinel Fairy Academy', 'WorldMap017'],
	['Gold Beach', 'WorldMap018'],
	['Mushroom Castle', 'WorldMap019'],
	['Kerning Tower', 'WorldMap0101'],
	['Secret Forest of Elodin', 'WorldMap0102'],
	['Partem', 'WorldMap0103'],
] as const

function worldMap(id: string, links: readonly (readonly [string, string])[]): GameWorldMap {
	return {
		id,
		worldMapName: id,
		parentWorld: id === 'WorldMap230' ? 'CGWorldMap' : 'WorldMap',
		baseImages: [],
		links: links.map(([toolTip, linksTo]) => ({ toolTip, linksTo, linkImage: null })),
		maps: [],
		mapNumbers: [],
	}
}

function snapshot(
	locale: string,
	region: string,
	version: number,
	mapNames: Record<string, string | null>,
	victoriaLinks: readonly (readonly [string, string])[],
	cerniumLinks: readonly (readonly [string, string])[],
): LocalizedGameDataSnapshot {
	return {
		provider: 'maplestory-io',
		region,
		version,
		apiBase: 'https://maplestory.io/api',
		locale,
		worldMaps: [worldMap('WorldMap010', victoriaLinks), worldMap('WorldMap230', cerniumLinks)],
		maps: Object.entries(mapNames).map(([id, name]) => ({
			id,
			name,
			streetName: null,
			mapMark: null,
			backgroundMusic: null,
		})),
	}
}

export const LOCALIZATION_FIXTURES: readonly LocalizedGameDataSnapshot[] = [
	snapshot('ko-KR', 'KMS', 389, {
		100000000: '헤네시스',
		120000000: '노틸러스 선착장',
		104020100: '빅토리아 나무승강장',
		410000500: '세르니움 광장',
	}, [
		['노틸러스', 'WorldMap011'],
		['슬리피우드', 'WorldMap012'],
		['요정학원 엘리넬', 'WorldMap017'],
		['골드비치', 'WorldMap018'],
		['버섯의 성', 'WorldMap019'],
		['커닝타워', 'WorldMap0101'],
		['비밀의숲 엘로딘', 'WorldMap0102'],
		['파르템', 'WorldMap0103'],
	], [['불타는 세르니움', 'WorldMap240']]),
	snapshot('ja-JP', 'JMS', 444, {
		100000000: 'ヘネシス',
		120000000: 'ノーチラス',
		104020100: 'ビクトリア木の乗降場',
		410000500: 'セルニウム広場',
	}, [
		['ノーチラス', 'WorldMap011'],
		['スリーピーウッド', 'WorldMap012'],
		['妖精学園エリネル', 'WorldMap017'],
		['ゴールドビーチ', 'WorldMap018'],
		['キノコの城', 'WorldMap019'],
		['カニングタワー', 'WorldMap0101'],
		['秘密の森エルディン', 'WorldMap0102'],
		['パルテン', 'WorldMap0103'],
	], [['燃え上がるセルニウム', 'WorldMap240']]),
	snapshot('zh-CN', 'CMS', 202, {
		100000000: '射手村',
		120000000: '诺特勒斯码头',
		104020100: '金银岛大树升降场',
		410000500: '塞尔提乌广场',
	}, [
		['诺特勒斯', 'WorldMap011'],
		['林中之城', 'WorldMap012'],
		['妖精学院艾利涅', 'WorldMap017'],
		['金海滩', 'WorldMap018'],
		['蘑菇城', 'WorldMap019'],
		['废都塔', 'WorldMap0101'],
		['秘密森林艾洛丁', 'WorldMap0102'],
		['帕勒坦', 'WorldMap0103'],
	], [['燃烧的塞尔提乌', 'WorldMap240']]),
	snapshot('zh-TW', 'TWMS', 256, {
		100000000: '弓箭手村',
		120000000: '鯨魚號碼頭',
		104020100: '維多利亞樹木站台',
		410000500: '賽爾尼溫廣場',
	}, [
		['鯨魚號', 'WorldMap011'],
		['奇幻村', 'WorldMap012'],
		['妖精學園愛里涅', 'WorldMap017'],
		['黃金海岸', 'WorldMap018'],
		['菇菇城堡', 'WorldMap019'],
		['星光之塔', 'WorldMap0101'],
		['秘密森林埃羅汀', 'WorldMap0102'],
		['帕爾坦', 'WorldMap0103'],
	], [['失火的賽爾尼溫', 'WorldMap240']]),
	snapshot('en-SG', 'SEA', 220, {
		100000000: 'Henesys',
		120000000: 'Nautilus Harbor',
		104020100: 'Victoria Tree Platform',
		410000500: 'Cernium Square',
	}, VICTORIA_LINKS, [['Fallen Cernium', 'WorldMap240']]),
]
