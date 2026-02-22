FROM node:20-slim

# 1. 必須先宣告 ARG，否則下方指令抓不到變數
ARG USER_ID
ARG USERNAME

# 基本環境變數設定
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# 2. 建立使用者與安裝基礎工具
# 將變數用 ${} 包起來是更穩健的寫法
RUN if [ -z "$USER_ID" ] || [ -z "$USERNAME" ]; then echo "Error: USER_ID or USERNAME not set"; exit 1; fi && \
    useradd -m -u ${USER_ID} -g 100 ${USERNAME} && \
    apt-get update && \
    apt-get install -y ffmpeg git curl && \
    curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    rm -rf /var/lib/apt/lists/* && \
    corepack enable && \
    corepack enable npm

# 3. 指定執行身份
USER ${USERNAME}

# 設定工作目錄
WORKDIR /workspace

# 預設開啟 bash
CMD [ "bash" ]
