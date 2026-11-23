#!/usr/bin/env bash
# Installs the simulated IP camera as two systemd *user* services (restart on failure, start with the WSL session,
# `loginctl enable-linger` keeps them alive). Nothing outside $HOME is touched.
#   scripts/sim-rtsp/install.sh            install + start
#   scripts/sim-rtsp/install.sh uninstall  stop + remove
# mediamtx: $MEDIAMTX, else `mediamtx` on the PATH, else ~/sim-rtsp/bin/mediamtx (release binary of bluenviron/mediamtx).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
unit_dir="$HOME/.config/systemd/user"

if [ "${1:-}" = "uninstall" ]; then
  systemctl --user disable --now sada-sim-camera.service sada-sim-mediamtx.service 2>/dev/null || true
  rm -f "$unit_dir/sada-sim-camera.service" "$unit_dir/sada-sim-mediamtx.service"
  systemctl --user daemon-reload
  exit 0
fi

mtx="${MEDIAMTX:-$(command -v mediamtx || true)}"
[ -z "$mtx" ] && [ -x "$HOME/sim-rtsp/bin/mediamtx" ] && mtx="$HOME/sim-rtsp/bin/mediamtx"
[ -n "$mtx" ] || { echo "mediamtx not found (set MEDIAMTX=/path/to/mediamtx)" >&2; exit 1; }
ffmpeg_bin="$(command -v ffmpeg)"

mkdir -p "$unit_dir"
cat >"$unit_dir/sada-sim-mediamtx.service" <<EOF
[Unit]
Description=Simulated IP camera: mediamtx (RTSP 127.0.0.1:8554)

[Service]
ExecStart=$mtx $here/mediamtx.yml
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
cat >"$unit_dir/sada-sim-camera.service" <<EOF
[Unit]
Description=Simulated IP camera: ffmpeg test pattern (clock, flash and beep every 2 s)
After=sada-sim-mediamtx.service
Requires=sada-sim-mediamtx.service

[Service]
Environment=PATH=$(dirname "$ffmpeg_bin"):/usr/local/bin:/usr/bin:/bin
ExecStartPre=/bin/sleep 2
ExecStart=$here/camera.sh
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now sada-sim-mediamtx.service sada-sim-camera.service
loginctl enable-linger "$USER" 2>/dev/null || true
echo "up: rtsp://studio:studio@127.0.0.1:8554/cam"
