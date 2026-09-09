import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import process from 'node:process'
import { promisify } from 'node:util'
import path from 'pathe'
import { assertRunningInContainer } from './assert-container'

const execFileAsync = promisify(execFile)

interface AudioResource {
	file: string
	codec: string
	container: string
}

interface BgmItem {
	filename: string
	metadata?: {
		year?: string
	}
	audio: AudioResource | null
	duration: number
}

interface ResourceData {
	bgms: BgmItem[]
	builtAt: number
}

interface LoudnormJson {
	input_i: string
	input_tp: string
	input_lra: string
	input_thresh: string
}

interface LoudnessMeasurement {
	filename: string
	file: string
	codec: string
	container: string
	duration: number
	year: string | null
	integratedLufs: number
	truePeakDbtp: number
	loudnessRangeLu: number
	thresholdLufs: number
}

interface CandidateResult {
	targetLufs: number
	truePeakCeilingDbtp: number
	peakLimitedTracks: number
	peakLimitedPercent: number
	medianAppliedGainDb: number
	p10AppliedGainDb: number
	p90AppliedGainDb: number
	medianAchievedLufs: number
}

const workspaceDir = path.resolve('.')
const inputPath = path.join(workspaceDir, 'output', 'data.json')
const bgmDir = path.join(workspaceDir, 'output', 'bgm')
const jsonOutputPath = path.join(workspaceDir, 'output', 'loudness-analysis.json')
const markdownOutputPath = path.join(workspaceDir, 'output', 'loudness-analysis.md')
const targetLoudnesses = [-14, -16, -18]
const truePeakCeilingDbtp = Number.parseFloat(process.env.LOUDNESS_TRUE_PEAK_CEILING ?? '-1')
const defaultConcurrency = Math.max(1, Math.min(6, Math.floor(os.cpus().length / 2)))
const concurrency = Number.parseInt(process.env.LOUDNESS_CONCURRENCY ?? String(defaultConcurrency), 10)

function round(value: number, digits = 2): number {
	const factor = 10 ** digits
	return Math.round(value * factor) / factor
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0)
		throw new Error('Cannot calculate percentile of an empty array')
	if (sorted.length === 1)
		return sorted.at(0)!
	const index = (sorted.length - 1) * p
	const lower = Math.floor(index)
	const upper = Math.ceil(index)
	if (lower === upper)
		return sorted.at(lower)!
	const weight = index - lower
	return sorted.at(lower)! * (1 - weight) + sorted.at(upper)! * weight
}

function stats(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b)
	return {
		min: round(sorted.at(0)!),
		p10: round(percentile(sorted, 0.1)),
		median: round(percentile(sorted, 0.5)),
		p90: round(percentile(sorted, 0.9)),
		max: round(sorted.at(-1)!),
		mean: round(values.reduce((sum, value) => sum + value, 0) / values.length),
	}
}

function parseFinite(value: string, field: string, filename: string): number {
	const parsed = Number.parseFloat(value)
	if (!Number.isFinite(parsed))
		throw new Error(`${filename}: ${field} is not finite (${value})`)
	return parsed
}

async function measure(item: BgmItem): Promise<LoudnessMeasurement> {
	if (!item.audio)
		throw new Error(`${item.filename}: missing audio metadata`)

	const filePath = path.join(bgmDir, item.audio.file)
	const { stderr } = await execFileAsync('ffmpeg', [
		'-hide_banner',
		'-nostats',
		'-i',
		filePath,
		'-af',
		'loudnorm=I=-16:TP=-1:LRA=11:print_format=json',
		'-f',
		'null',
		'-',
	], { maxBuffer: 1024 * 1024 })

	const match = stderr.match(/\{\s*"input_i"[\s\S]*?\}/)
	if (!match)
		throw new Error(`${item.filename}: loudnorm JSON not found`)
	const parsed = JSON.parse(match[0]) as LoudnormJson

	return {
		filename: item.filename,
		file: item.audio.file,
		codec: item.audio.codec,
		container: item.audio.container,
		duration: item.duration,
		year: item.metadata?.year ?? null,
		integratedLufs: parseFinite(parsed.input_i, 'input_i', item.filename),
		truePeakDbtp: parseFinite(parsed.input_tp, 'input_tp', item.filename),
		loudnessRangeLu: parseFinite(parsed.input_lra, 'input_lra', item.filename),
		thresholdLufs: parseFinite(parsed.input_thresh, 'input_thresh', item.filename),
	}
}

function evaluateCandidate(measurements: LoudnessMeasurement[], targetLufs: number): CandidateResult {
	const appliedGains: number[] = []
	const achievedLoudnesses: number[] = []
	let peakLimitedTracks = 0

	for (const measurement of measurements) {
		const desiredGain = targetLufs - measurement.integratedLufs
		const peakSafeGain = truePeakCeilingDbtp - measurement.truePeakDbtp
		const appliedGain = Math.min(desiredGain, peakSafeGain)
		if (peakSafeGain < desiredGain - 1e-9)
			peakLimitedTracks += 1
		appliedGains.push(appliedGain)
		achievedLoudnesses.push(measurement.integratedLufs + appliedGain)
	}

	const gains = [...appliedGains].sort((a, b) => a - b)
	const achieved = [...achievedLoudnesses].sort((a, b) => a - b)
	return {
		targetLufs,
		truePeakCeilingDbtp,
		peakLimitedTracks,
		peakLimitedPercent: round(peakLimitedTracks / measurements.length * 100),
		medianAppliedGainDb: round(percentile(gains, 0.5)),
		p10AppliedGainDb: round(percentile(gains, 0.1)),
		p90AppliedGainDb: round(percentile(gains, 0.9)),
		medianAchievedLufs: round(percentile(achieved, 0.5)),
	}
}

function formatTable(measurements: LoudnessMeasurement[], key: keyof Pick<LoudnessMeasurement, 'integratedLufs' | 'truePeakDbtp' | 'loudnessRangeLu'>, descending: boolean): string {
	const rows = [...measurements]
		.sort((a, b) => descending ? b[key] - a[key] : a[key] - b[key])
		.slice(0, 10)
	return rows.map(item => `| ${item.filename} | ${item.year ?? ''} | ${item.integratedLufs.toFixed(2)} | ${item.truePeakDbtp.toFixed(2)} | ${item.loudnessRangeLu.toFixed(2)} |`).join('\n')
}

async function main(): Promise<void> {
	assertRunningInContainer('loudness analysis')
	if (!Number.isInteger(concurrency) || concurrency < 1)
		throw new Error(`Invalid LOUDNESS_CONCURRENCY: ${process.env.LOUDNESS_CONCURRENCY}`)
	if (!Number.isFinite(truePeakCeilingDbtp))
		throw new Error(`Invalid LOUDNESS_TRUE_PEAK_CEILING: ${process.env.LOUDNESS_TRUE_PEAK_CEILING}`)

	const input = JSON.parse(await readFile(inputPath, 'utf8')) as ResourceData
	const items = input.bgms
	const measurements = Array.from({ length: items.length })
	const failures: Array<{ filename: string, error: string }> = []
	let nextIndex = 0
	let completed = 0
	const startedAt = Date.now()

	const { stdout: ffmpegVersionOutput } = await execFileAsync('ffmpeg', ['-version'])
	const ffmpegVersion = ffmpegVersionOutput.split('\n')[0]
	console.log(`[LOUDNESS] ${items.length} tracks, concurrency=${concurrency}, ceiling=${truePeakCeilingDbtp} dBTP`)

	async function worker(): Promise<void> {
		while (true) {
			const index = nextIndex++
			if (index >= items.length)
				return
			const item = items.at(index)!
			try {
				measurements[index] = await measure(item)
			}
			catch (error) {
				failures.push({ filename: item.filename, error: error instanceof Error ? error.message : String(error) })
			}
			completed += 1
			if (completed % 25 === 0 || completed === items.length) {
				const elapsedSeconds = (Date.now() - startedAt) / 1000
				const rate = completed / elapsedSeconds
				const etaSeconds = rate > 0 ? (items.length - completed) / rate : 0
				console.log(`[LOUDNESS] ${completed}/${items.length} (${(completed / items.length * 100).toFixed(1)}%) failures=${failures.length} rate=${rate.toFixed(2)}/s eta=${Math.ceil(etaSeconds)}s`)
			}
		}
	}

	await Promise.all(Array.from({ length: concurrency }, () => worker()))

	const successful = measurements.filter((measurement): measurement is LoudnessMeasurement => measurement != null)
	if (successful.length === 0)
		throw new Error('No tracks were measured successfully')

	const candidates = targetLoudnesses.map(target => evaluateCandidate(successful, target))
	const integratedStats = stats(successful.map(item => item.integratedLufs))
	const truePeakStats = stats(successful.map(item => item.truePeakDbtp))
	const lraStats = stats(successful.map(item => item.loudnessRangeLu))
	const codecCounts = Object.fromEntries([...new Set(successful.map(item => item.codec))].sort().map(codec => [codec, successful.filter(item => item.codec === codec).length]))
	const containerCounts = Object.fromEntries([...new Set(successful.map(item => item.container))].sort().map(container => [container, successful.filter(item => item.container === container).length]))

	const result = {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		resourceBuiltAt: input.builtAt,
		ffmpegVersion,
		concurrency,
		trackCount: items.length,
		successCount: successful.length,
		failureCount: failures.length,
		totalDurationSeconds: round(items.reduce((sum, item) => sum + item.duration, 0), 3),
		truePeakCeilingDbtp,
		codecCounts,
		containerCounts,
		distribution: {
			integratedLufs: integratedStats,
			truePeakDbtp: truePeakStats,
			loudnessRangeLu: lraStats,
		},
		candidates,
		failures,
		tracks: successful,
	}
	await writeFile(jsonOutputPath, `${JSON.stringify(result, null, 2)}\n`)

	const markdown = `# Maple Pod loudness analysis\n\nGenerated: ${result.generatedAt}\n\n- Tracks: ${result.successCount}/${result.trackCount} measured successfully\n- Failures: ${result.failureCount}\n- Total duration: ${(result.totalDurationSeconds / 3600).toFixed(2)} hours\n- FFmpeg: ${ffmpegVersion}\n- Analysis concurrency: ${concurrency}\n- Evaluation true-peak ceiling: ${truePeakCeilingDbtp} dBTP\n\n## Catalogue distribution\n\n| Metric | Min | P10 | Median | P90 | Max | Mean |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n| Integrated loudness (LUFS) | ${integratedStats.min} | ${integratedStats.p10} | ${integratedStats.median} | ${integratedStats.p90} | ${integratedStats.max} | ${integratedStats.mean} |\n| True peak (dBTP) | ${truePeakStats.min} | ${truePeakStats.p10} | ${truePeakStats.median} | ${truePeakStats.p90} | ${truePeakStats.max} | ${truePeakStats.mean} |\n| Loudness range (LU) | ${lraStats.min} | ${lraStats.p10} | ${lraStats.median} | ${lraStats.p90} | ${lraStats.max} | ${lraStats.mean} |\n\n## Static-gain normalization candidates\n\nGain is capped so predicted true peak does not exceed ${truePeakCeilingDbtp} dBTP.\n\n| Target | Peak-limited | Peak-limited % | Gain P10 | Gain median | Gain P90 | Achieved median |\n| ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${candidates.map(candidate => `| ${candidate.targetLufs} LUFS | ${candidate.peakLimitedTracks} | ${candidate.peakLimitedPercent}% | ${candidate.p10AppliedGainDb} dB | ${candidate.medianAppliedGainDb} dB | ${candidate.p90AppliedGainDb} dB | ${candidate.medianAchievedLufs} LUFS |`).join('\n')}\n\n## Quietest by integrated loudness\n\n| Track | Year | LUFS | dBTP | LRA |\n| --- | ---: | ---: | ---: | ---: |\n${formatTable(successful, 'integratedLufs', false)}\n\n## Loudest by integrated loudness\n\n| Track | Year | LUFS | dBTP | LRA |\n| --- | ---: | ---: | ---: | ---: |\n${formatTable(successful, 'integratedLufs', true)}\n\n## Highest true peaks\n\n| Track | Year | LUFS | dBTP | LRA |\n| --- | ---: | ---: | ---: | ---: |\n${formatTable(successful, 'truePeakDbtp', true)}\n\n## Widest loudness range\n\n| Track | Year | LUFS | dBTP | LRA |\n| --- | ---: | ---: | ---: | ---: |\n${formatTable(successful, 'loudnessRangeLu', true)}\n`
	await writeFile(markdownOutputPath, markdown)

	console.log(`[LOUDNESS] wrote ${jsonOutputPath}`)
	console.log(`[LOUDNESS] wrote ${markdownOutputPath}`)
	if (failures.length > 0)
		process.exitCode = 1
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
