import process, { env } from 'node:process'

/**
 * 建置與發佈流程依賴容器內才有的 yt-dlp / ffprobe / git 設定，
 * 在主機上執行只會得到難以診斷的失敗，所以直接擋下來。
 *
 * MAPLE_POD_CONTAINER 由 Dockerfile 設定；真的需要繞過時可自行覆寫。
 */
export function assertRunningInContainer(taskName: string): void {
	if (env.MAPLE_POD_CONTAINER === '1')
		return

	console.error(`[ERROR] "${taskName}" 必須在專案的容器環境內執行，不要直接在主機上跑。`)
	console.error('        改用: ./dev.sh pnpm <command>')
	console.error('        （確定要在主機執行時，可設 MAPLE_POD_CONTAINER=1 繞過）')
	process.exit(1)
}
