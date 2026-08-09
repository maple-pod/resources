#!/bin/bash
# 這個專案的所有指令都在容器內執行，不要直接在主機上跑。
#
#   ./dev.sh                  進入容器的互動 shell
#   ./dev.sh pnpm install     在容器內執行單一指令後結束
#   ./dev.sh pnpm build
#
# 可用環境變數（呼叫時指定的值優先於 .env）：
#   DOCKER            docker 呼叫方式，預設 "sudo docker"（不需要 sudo 時設成 "docker"）
#   GLOBAL_GIT_PATH   要掛進容器的 .gitconfig，預設 $HOME/.gitconfig
set -euo pipefail

cd "$(dirname "$0")"

IMAGE_NAME="maple-pod-resources-env"

# 先留住呼叫端給的值，.env 只當預設值用
cli_docker="${DOCKER:-}"
cli_git_path="${GLOBAL_GIT_PATH:-}"

if [ -f .env ]; then
	set -a
	# shellcheck disable=SC1091
	source .env
	set +a
fi

DOCKER="${cli_docker:-${DOCKER:-sudo docker}}"
GLOBAL_GIT_PATH="${cli_git_path:-${GLOBAL_GIT_PATH:-$HOME/.gitconfig}}"

if ! $DOCKER image inspect "$IMAGE_NAME" > /dev/null 2>&1; then
	echo "[dev.sh] 找不到映像 $IMAGE_NAME，請先執行 ./build-env.sh" >&2
	exit 1
fi

run_args=(--rm -w /workspace -v "$PWD:/workspace")

# 掛進來的檔案 owner 不一定對得上容器內的 uid，git 會因此拒絕操作 output/。
# 容器裡只有這個專案，關掉所有權檢查是安全的。
run_args+=(
	-e GIT_CONFIG_COUNT=1
	-e GIT_CONFIG_KEY_0=safe.directory
	-e GIT_CONFIG_VALUE_0='*'
)

# git 身份只有 deploy 需要，缺了就警告而不是直接失敗。
# 掛到 /etc/gitconfig 而不是某個家目錄，這樣就不必猜容器內的使用者名稱。
if [ -f "$GLOBAL_GIT_PATH" ]; then
	run_args+=(-v "$GLOBAL_GIT_PATH:/etc/gitconfig:ro")
else
	echo "[dev.sh] 警告：找不到 $GLOBAL_GIT_PATH，容器內將沒有 git 身份，deploy 會失敗" >&2
fi

# 只有在真的接著終端機時才配置 TTY，這樣從腳本或排程呼叫也不會壞
if [ -t 0 ] && [ -t 1 ]; then
	run_args+=(-it)
fi

if [ "$#" -eq 0 ]; then
	set -- bash
fi

exec $DOCKER run "${run_args[@]}" \
	-e GH_TOKEN="${GH_TOKEN:-}" \
	"$IMAGE_NAME" \
	"$@"
