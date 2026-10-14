import type { Flags } from 'youtube-dl-exec'

// Only use this when the preferred direct audio stream is inaccessible.
const HLS_AUDIO_FORMAT = 'bestaudio[protocol=m3u8_native]/bestaudio[protocol=m3u8]'

export async function downloadAudioWithHlsFallback(
	url: string,
	flags: Flags,
	download: (url: string, flags: Flags) => Promise<unknown>,
	clearTemporaryFiles: () => Promise<void>,
	onFallback: () => void,
): Promise<void> {
	try {
		await download(url, flags)
	}
	catch (error) {
		if (!/HTTP Error 403\b/i.test(String(error)))
			throw error

		// Remove files left by the failed direct download before the HLS retry.
		await clearTemporaryFiles()
		onFallback()
		await download(url, { ...flags, format: HLS_AUDIO_FORMAT })
	}
}
