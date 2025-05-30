FROM node:20-slim

ARG USER_ID=1000
ARG USERNAME=devuser

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# apt-get update && apt-get install -y \
#   ffmpeg \

# 安裝 ffmpeg 和常用工具
RUN useradd -m -u $USER_ID -g 100 $USERNAME \
  && apt-get update && apt-get install -y ffmpeg git \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack enable npm

USER $USERNAME

# 設定工作目錄（你可以選別的）
WORKDIR /workspace

# 預設開啟 bash，讓你進入後直接互動
CMD [ "bash" ]