#!/usr/bin/env bash
# Simulated IP camera for manual / integration tests: a black picture that flashes white for 120 ms every 2 s,
# published over RTSP/TCP to a local mediamtx (config: tests/e2e/mediamtx.yml).
#   scripts/test-camera.sh [rtsp-url]
set -euo pipefail
URL="${1:-rtsp://127.0.0.1:18554/cam}"
date +%s.%N >&2
exec ffmpeg -hide_banner -loglevel error -re \
  -f lavfi -i "color=black:size=320x180:rate=25,drawbox=x=0:y=0:w=320:h=180:color=white:t=fill:enable='lt(mod(t,2),0.12)'" \
  -c:v libx264 -preset ultrafast -tune zerolatency -g 25 -f rtsp -rtsp_transport tcp "$URL"
