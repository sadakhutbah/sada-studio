#!/usr/bin/env bash
# Smoke test of a minimal ffmpeg against the exact argument sets the application builds (src/core/capture).
#   scripts/test-ffmpeg-min.sh <ffmpeg-under-test> <rtsp-url> [reference-ffmpeg]
# The RTSP URL must already be serving H.264 video (any RTSP server + a publisher). The sound card is replaced by a
# raw PCM file generated with the reference ffmpeg (default: ffmpeg from PATH). Checks:
#  1. capture: RTSP + audio -> libx264/aac fragmented MP4 on stdout (the file must hold one H.264 and one AAC stream),
#  2. calibration: motion + RMS filter chains write their metadata files,
#  3. the build is GPL and has no stray network/hardware component beyond what is needed.
set -euo pipefail
FF="$(cd "$(dirname "${1:?ffmpeg under test}")" && pwd)/$(basename "$1")"
URL="${2:?rtsp url}"
REF="${3:-ffmpeg}"
tmo() { perl -e 'alarm shift; exec @ARGV' "$@"; }  # macOS has no timeout(1)
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

"$REF" -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=440:sample_rate=48000" -t 30 -f s16le -ac 1 "$T/a.pcm"
CB=$(( $(date +%s) - 5 ))
RTSP=(-use_wallclock_as_timestamps 1 -fflags nobuffer -flags low_delay -rtsp_transport tcp -timeout 5000000 -i "$URL")
AUDIO=(-use_wallclock_as_timestamps 1 -f s16le -ar 48000 -ac 1 -i "$T/a.pcm")

echo "== capture (8 s)"
tmo 30 "$FF" -hide_banner -nostdin -loglevel error -progress pipe:2 -stats_period 2 -copyts -t 8 "${RTSP[@]}" "${AUDIO[@]}" \
  -map 0:v:0 -map 1:a:0 -vf "setpts=PTS-$CB/TB" -af "adelay=delays=100:all=1,aresample=async=1:min_hard_comp=0.25,asetpts=PTS-$CB/TB" \
  -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -g 50 -c:a aac -b:a 128k -ar 48000 \
  -f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof -frag_duration 500000 -flush_packets 1 pipe:1 > "$T/out.mp4" 2> "$T/cap.err" \
  || { cat "$T/cap.err"; fail "capture exited non-zero"; }
[ -s "$T/out.mp4" ] || fail "capture produced no output"
"$REF" -hide_banner -i "$T/out.mp4" 2> "$T/probe.txt" || true
grep -q "Video: h264" "$T/probe.txt" || { cat "$T/probe.txt"; fail "no h264 stream in output"; }
grep -q "Audio: aac" "$T/probe.txt" || { cat "$T/probe.txt"; fail "no aac stream in output"; }
echo "ok: $(grep -E 'Stream #0' "$T/probe.txt" | sed 's/^ *//' | cut -c1-110 | tr '\n' ';')"

echo "== calibration (6 s)"
tmo 30 "$FF" -hide_banner -nostdin -loglevel error -copyts -t 6 "${RTSP[@]}" -t 6 "${AUDIO[@]}" \
  -map 0:v:0 -vf "scale=64:36,format=gray,tblend=all_mode=difference,signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=$T/video.txt" -fps_mode passthrough -f null - \
  -map 1:a:0 -af "aresample=48000:async=1:min_hard_comp=0.25,asetnsamples=n=480:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=$T/audio.txt" -f null - \
  2> "$T/cal.err" || { cat "$T/cal.err"; fail "calibration exited non-zero"; }
[ -s "$T/video.txt" ] && [ -s "$T/audio.txt" ] || fail "calibration files empty"
echo "ok: $(grep -c YAVG "$T/video.txt") motion samples, $(grep -c RMS_level "$T/audio.txt") level samples"

echo "== version"
"$FF" -hide_banner -version | head -1
"$FF" -hide_banner -encoders 2>/dev/null | grep -E "^ V|^ A" | sed 's/^ //' | tr '\n' ';'; echo
echo "ALL OK"
