#!/usr/bin/env bash
# Simulated site for manual tests of the "IP camera + local audio" source:
#   mediamtx (RTSP/TCP on 127.0.0.1:18554) + a camera flashing every 2 s on rtsp://127.0.0.1:18554/cam
#   + a sound-card stand-in beeping every 2 s on tcp://127.0.0.1:18999 (audio backend "pcm").
#   scripts/e2e-env.sh start | stop          (mediamtx: $SADA_MEDIAMTX or PATH)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
state="${TMPDIR:-/tmp}/sada-e2e-env"
mkdir -p "$state"
case "${1:-}" in
  start)
    "${SADA_MEDIAMTX:-mediamtx}" "$here/tests/e2e/mediamtx.yml" >"$state/mediamtx.log" 2>&1 & echo $! >"$state/mediamtx.pid"
    sleep 1.5
    "$here/scripts/test-camera.sh" >"$state/camera.log" 2>&1 & echo $! >"$state/camera.pid"
    node "$here/scripts/test-audio-feeder.mjs" 18999 2000 >"$state/feeder.log" 2>&1 & echo $! >"$state/feeder.pid"
    sleep 2
    echo "up: rtsp://127.0.0.1:18554/cam  audio tcp://127.0.0.1:18999"
    ;;
  stop)
    for f in camera feeder mediamtx; do
      [ -f "$state/$f.pid" ] && kill "$(cat "$state/$f.pid")" 2>/dev/null || true
      rm -f "$state/$f.pid"
    done
    ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
