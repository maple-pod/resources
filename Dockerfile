FROM node:24-slim

# 1. 必須先宣告 ARG，否則下方指令抓不到變數
ARG USER_ID
ARG USERNAME
# yt-dlp 版本：預設抓 latest。YouTube 端變動頻繁，抓取開始失敗時重建映像即可；
# 若某個版本出問題，可用 --build-arg YTDLP_VERSION=2026.01.15 釘回已知可用的版本。
ARG YTDLP_VERSION=latest

# 基本環境變數設定
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# 供腳本判斷「自己是否跑在這個環境裡」——需要 yt-dlp / ffprobe 的指令會據此擋下主機執行
ENV MAPLE_POD_CONTAINER=1

# 2. 建立使用者與安裝基礎工具
# 將變數用 ${} 包起來是更穩健的寫法
# yt-dlp 需要 JS runtime 才能正常解析 YouTube；本映像直接沿用內建的 node，
# 由 build-resources.ts 以 jsRuntimes: 'node' 指定，因此不必另外安裝 deno。
# 抓的是自帶 Python runtime 的獨立執行檔（yt-dlp_linux*），而不是需要系統 python3
# 的 zipapp 版本 —— 否則 python3 會變成一條沒寫出來的隱性相依。
RUN if [ -z "$USER_ID" ] || [ -z "$USERNAME" ]; then echo "Error: USER_ID or USERNAME not set"; exit 1; fi && \
    useradd -m -u ${USER_ID} -g 100 ${USERNAME} && \
    apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg git curl ca-certificates && \
    case "$(dpkg --print-architecture)" in \
        amd64) YTDLP_ASSET="yt-dlp_linux" ;; \
        arm64) YTDLP_ASSET="yt-dlp_linux_aarch64" ;; \
        *) echo "Error: unsupported architecture $(dpkg --print-architecture)"; exit 1 ;; \
    esac && \
    if [ "${YTDLP_VERSION}" = "latest" ]; then \
        YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}"; \
    else \
        YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${YTDLP_ASSET}"; \
    fi && \
    curl -fsSL "${YTDLP_URL}" -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    rm -rf /var/lib/apt/lists/* && \
    corepack enable && \
    corepack enable npm

# 3. 建置期驗證：缺任何一個工具都應該現在就失敗，而不是跑到一半才炸
RUN yt-dlp --version && ffprobe -version > /dev/null && node --version

# 4. 指定執行身份
USER ${USERNAME}

# 設定工作目錄
WORKDIR /workspace

# 預設開啟 bash
CMD [ "bash" ]
