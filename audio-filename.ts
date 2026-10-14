const SHA256_PATTERN = /^[\da-f]{64}$/i

/** Build a stable media path from the selected source identity and exact bytes. */
export function getContentAddressedAudioFilename(
	trackFilename: string,
	sourceFingerprint: string,
	contentSha256: string,
	container: string,
): string {
	if (!trackFilename || trackFilename === '.' || trackFilename === '..'
		|| trackFilename.includes('/') || trackFilename.includes('\\')) {
		throw new Error('Audio track filename must be a single path segment')
	}
	if (!SHA256_PATTERN.test(sourceFingerprint))
		throw new Error('Audio source fingerprint must be a 64-character hexadecimal SHA-256')
	if (!SHA256_PATTERN.test(contentSha256))
		throw new Error('Audio content hash must be a 64-character hexadecimal SHA-256')
	if (!/^[a-z\d]+$/i.test(container))
		throw new Error('Audio container must be a file extension without punctuation')

	const filename = `${trackFilename}.${sourceFingerprint.toLowerCase()}.${contentSha256.toLowerCase()}.${container}`
	if (filename.length > 255)
		throw new Error('Content-addressed audio filename exceeds the filesystem component limit')
	return filename
}
