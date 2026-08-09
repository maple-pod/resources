#!/bin/bash
# 建立開發環境映像。
# yt-dlp 預設抓 latest；要釘特定版本時：YTDLP_VERSION=2026.01.15 ./build-env.sh
sudo docker build \
  --build-arg USER_ID=$(id -u) \
  --build-arg USERNAME=$(whoami) \
  ${YTDLP_VERSION:+--build-arg YTDLP_VERSION=$YTDLP_VERSION} \
  -t maple-pod-resources-env .
