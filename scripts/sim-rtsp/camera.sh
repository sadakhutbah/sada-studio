#!/usr/bin/env bash
# Simulated IP camera: 1280x720 25 fps test pattern with a visible wall clock (HH:MM:SS) and a running timer, and every
# 2 s a white flash of 120 ms together with a 1 kHz beep (same generator time base, so picture and sound are aligned
# at the source). Published over RTSP/TCP to the local mediamtx (mediamtx.yml).
#   scripts/sim-rtsp/camera.sh [rtsp-publish-url]
set -euo pipefail
URL="${1:-rtsp://127.0.0.1:8554/cam}"
FONT="${SADA_SIM_FONT:-/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf}"

# The flash and the beep fall on the multiples of 2 s of the *wall clock* (stream time + start epoch), so that other
# simulated sources keyed to the wall clock (scripts/test-audio-feeder.mjs, a beep played on the PC) line up with them.
START="$(date +%s.%N)"

VIDEO="testsrc2=size=1280x720:rate=25,\
drawbox=x=0:y=0:w=iw:h=ih:color=white@1:t=fill:enable='lt(mod(t+${START},2),0.12)',\
drawtext=fontfile=${FONT}:text='%{localtime\\:%H\\\\\\:%M\\\\\\:%S}':x=(w-text_w)/2:y=h*0.08:fontsize=96:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=14,\
drawtext=fontfile=${FONT}:text='t=%{pts\\:hms\\:3}':x=(w-text_w)/2:y=h*0.80:fontsize=56:fontcolor=yellow:box=1:boxcolor=black@0.7:boxborderw=10"
AUDIO="aevalsrc=if(lt(mod(t+${START}\,2)\,0.12)\,0.6*sin(2*PI*1000*t)\,0):s=48000:c=mono"

exec ffmpeg -hide_banner -loglevel warning -re \
  -f lavfi -i "$VIDEO" -f lavfi -i "$AUDIO" \
  -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -g 25 -b:v 2500k \
  -c:a aac -b:a 96k -ar 48000 \
  -f rtsp -rtsp_transport tcp "$URL"
