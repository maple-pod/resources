export const LIVE_RESOURCE_BASE_URL = 'https://maple-pod.deviltea.me/resources'

export interface LiveAudioReadinessOptions {
	baseUrl?: string
	fetchImpl?: typeof fetch
	attempts?: number
	retryDelayMs?: number
	requestTimeoutMs?: number
	totalTimeoutMs?: number
	concurrency?: number
	sleep?: (milliseconds: number) => Promise<void>
}

function toLiveResourceUrl(baseUrl: string, resourcePath: string): string {
	if (!resourcePath || resourcePath.startsWith('/') || resourcePath.split('/').some(segment => !segment || segment === '.' || segment === '..'))
		throw new Error(`Invalid relative resource path for readiness check: ${resourcePath}`)
	const encodedSegments = resourcePath.split('/').map(segment => encodeURIComponent(segment))
	const encodedPath = encodedSegments.join('/')
	return `${baseUrl.replace(/\/$/, '')}/${encodedPath}`
}

const defaultSleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds))

/** Wait for newly pushed audio paths to resolve from the public custom domain. */
export async function waitForLiveAudioAssets(
	resourcePaths: readonly string[],
	options: LiveAudioReadinessOptions = {},
): Promise<void> {
	if (resourcePaths.length === 0)
		return

	const attempts = options.attempts ?? 10
	const retryDelayMs = options.retryDelayMs ?? 2_000
	const requestTimeoutMs = options.requestTimeoutMs ?? 3_000
	const totalTimeoutMs = options.totalTimeoutMs ?? 60_000
	const concurrency = options.concurrency ?? 16
	if (!Number.isInteger(attempts) || attempts < 1)
		throw new Error('Live audio readiness attempts must be a positive integer')
	if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0)
		throw new Error('Live audio readiness retry delay must be non-negative')
	if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0)
		throw new Error('Live audio readiness request timeout must be positive')
	if (!Number.isFinite(totalTimeoutMs) || totalTimeoutMs <= 0)
		throw new Error('Live audio readiness total timeout must be positive')
	if (!Number.isInteger(concurrency) || concurrency < 1)
		throw new Error('Live audio readiness concurrency must be a positive integer')

	const baseUrl = options.baseUrl ?? LIVE_RESOURCE_BASE_URL
	const fetchImpl = options.fetchImpl ?? fetch
	const sleep = options.sleep ?? defaultSleep
	const urls = resourcePaths.map(resourcePath => toLiveResourceUrl(baseUrl, resourcePath))
	let pending = [...urls]
	const deadline = Date.now() + totalTimeoutMs
	let completedAttempts = 0

	for (let attempt = 1; attempt <= attempts; attempt++) {
		if (Date.now() >= deadline)
			break
		completedAttempts = attempt
		const visible = Array.from({ length: pending.length }, () => false)
		let nextIndex = 0
		const workerCount = Math.min(concurrency, pending.length)
		await Promise.all(Array.from({ length: workerCount }, async () => {
			while (true) {
				const index = nextIndex++
				if (index >= pending.length || Date.now() >= deadline)
					return
				const remainingMs = deadline - Date.now()
				try {
					const response = await fetchImpl(pending[index]!, {
						method: 'HEAD',
						cache: 'no-store',
						signal: AbortSignal.timeout(Math.min(requestTimeoutMs, remainingMs)),
					})
					visible[index] = response.ok
				}
				catch {
					visible[index] = false
				}
			}
		}))
		pending = pending.filter((_url, index) => !visible[index])
		if (pending.length === 0)
			return
		const remainingMs = deadline - Date.now()
		if (attempt < attempts && remainingMs > 0)
			await sleep(Math.min(retryDelayMs, remainingMs))
	}

	const hiddenPaths = pending.map((url) => {
		try {
			return decodeURIComponent(new URL(url).pathname.replace(/^\/resources\//, ''))
		}
		catch {
			return url
		}
	})
	throw new Error(`Live audio readiness check failed after ${completedAttempts} attempt(s) or ${totalTimeoutMs} ms; not publicly visible: ${hiddenPaths.join(', ')}`)
}
