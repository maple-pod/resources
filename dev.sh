#!/bin/bash

IMAGE_NAME="maple-pod-resources-env"

sudo docker run -it --rm \
  -v "$PWD":/workspace \
  -w /workspace \
  $IMAGE_NAME \
  bash