#!/bin/bash

IMAGE_NAME="maple-pod-resources-env"

# Load .env file if it exists
if [ -f .env ]; then
  source .env
fi

sudo docker run -it --rm \
  -e GH_TOKEN="$GH_TOKEN" \
  -v "$PWD":/workspace \
  -v "$GLOBAL_GIT_PATH:/home/$CONTAINER_USER/.gitconfig" \
  -w /workspace \
  $IMAGE_NAME \
  bash