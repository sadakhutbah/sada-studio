#!/usr/bin/env bash
# Reproducible minimal ffmpeg for Sada Studio: only what src/core/capture really runs (RTSP over TCP in, sound card in,
# libx264 + aac, fragmented MP4 on a pipe, plus the analysis filters of the calibration). About 6-8 MB instead of the
# 67-95 MB full static GPL builds. GPL (libx264); the application runs it as a separate process, it is not linked.
#
#   scripts/build-ffmpeg-min.sh <arm64|x64> <output-dir>
#
# On macOS it builds the shipped flavor (avfoundation + Secure Transport for rtsps, either arch: x64 is cross-compiled
# on Apple Silicon). On Linux it builds a test flavor (same codecs, filters and RTSP, no sound-card device) used to check
# the component list. Needs: curl, tar, make, a C compiler, nasm. Sources are pinned and verified by SHA-256.
# Output: <output-dir>/ffmpeg, <output-dir>/BUILD-INFO.txt (versions, checksums, configure line).
set -euo pipefail

ARCH="${1:?usage: build-ffmpeg-min.sh <arm64|x64> <output-dir>}"
OUT="$(mkdir -p "${2:?output dir}" && cd "$2" && pwd)"

FFMPEG_VERSION=9.1
FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz"
FFMPEG_SHA256=1a4d394ae63d190a526cd052eb4415c156b5c5e2df37efab41a7de0b8fde2433
X264_COMMIT=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
X264_URL="https://code.videolan.org/videolan/x264/-/archive/${X264_COMMIT}/x264-${X264_COMMIT}.tar.bz2"
X264_SHA256=6eeb82934e69fd51e043bd8c5b0d152839638d1ce7aa4eea65a3fedcf83ff224

case "$ARCH" in
  arm64) FF_ARCH=aarch64; DARWIN_ARCH=arm64; X264_HOST=aarch64-apple-darwin ;;
  x64) FF_ARCH=x86_64; DARWIN_ARCH=x86_64; X264_HOST=x86_64-apple-darwin ;;
  *) echo "unknown arch $ARCH" >&2; exit 2 ;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
JOBS="$( (sysctl -n hw.ncpu 2>/dev/null || nproc) )"

fetch() { # url sha256 file
  curl -fsSL --retry 3 -o "$3" "$1"
  echo "$2  $3" > "$3.sha256"
  if command -v sha256sum >/dev/null; then sha256sum -c "$3.sha256"; else shasum -a 256 -c "$3.sha256"; fi
}

cd "$WORK"
fetch "$FFMPEG_URL" "$FFMPEG_SHA256" ffmpeg.tar.xz
fetch "$X264_URL" "$X264_SHA256" x264.tar.bz2
mkdir ffmpeg x264
tar -xf ffmpeg.tar.xz -C ffmpeg --strip-components=1
tar -xf x264.tar.bz2 -C x264 --strip-components=1

PREFIX="$WORK/prefix"
EXTRA_CFLAGS=()
X264_ARGS=(--prefix="$PREFIX" --enable-static --disable-cli --disable-opencl --disable-avs --disable-swscale --disable-lavf --disable-ffms --disable-gpac --disable-lsmash --bit-depth=8 --chroma-format=420)
PLATFORM_ARGS=()
# FFMIN_NO_ASM=1: no nasm available (local test flavor only; much slower encoder, never for the shipped binary).
[ -z "${FFMIN_PKG_CONFIG:-}" ] || PLATFORM_ARGS+=(--pkg-config="$FFMIN_PKG_CONFIG")  # local test without pkg-config only
if [ -n "${FFMIN_NO_ASM:-}" ]; then X264_ARGS+=(--disable-asm); PLATFORM_ARGS+=(--disable-x86asm); fi
if [ "$(uname -s)" = Darwin ]; then
  export MACOSX_DEPLOYMENT_TARGET=11.0
  EXTRA_CFLAGS=(-arch "$DARWIN_ARCH" -mmacosx-version-min=11.0)
  if [ "$(uname -m)" != "$DARWIN_ARCH" ]; then
    X264_ARGS+=(--host="$X264_HOST" --cross-prefix= )
    PLATFORM_ARGS+=(--enable-cross-compile --arch="$FF_ARCH" --target-os=darwin)
  fi
  # avfoundation = sound card (the camera is the RTSP one); Secure Transport = rtsps://. No videotoolbox: the encoder is libx264.
  PLATFORM_ARGS+=(--enable-avfoundation --enable-indev=avfoundation --enable-securetransport --enable-protocol=tls)
else
  [ "$ARCH" = x64 ] || { echo "Linux test flavor: x64 only" >&2; exit 2; }
fi

echo "== x264"
# (no ASFLAGS: x264 drives nasm itself on x86_64; "-arch" is a compiler flag, not a nasm one)
(cd x264 && CFLAGS="${EXTRA_CFLAGS[*]:-}" LDFLAGS="${EXTRA_CFLAGS[*]:-}" ./configure "${X264_ARGS[@]}" > "$WORK/x264.log" 2>&1 && make -j"$JOBS" >> "$WORK/x264.log" 2>&1 && make install >> "$WORK/x264.log" 2>&1) || { tail -40 "$WORK/x264.log"; tail -30 x264/config.log 2>/dev/null; exit 1; }

COMPONENTS=(
  # Inputs: RTSP (+ SDP/RTP underneath), raw PCM test source. Camera/microphone decoders: whatever cameras send as video
  # (H.264/H.265/MJPEG) and the PCM flavors sound cards deliver.
  --enable-demuxer=rtsp,rtp,sdp,pcm_s16le,h264,hevc,aac,mjpeg
  --enable-protocol=rtp,tcp,udp,file,pipe,crypto
  --enable-decoder=h264,hevc,mjpeg,rawvideo,aac,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_alaw,pcm_mulaw
  --enable-parser=h264,hevc,aac,mjpeg
  # (pcm_s16le + wrapped_avframe: the default encoders of the `null` muxer used by the calibration.)
  # Output: libx264 + native AAC in fragmented MP4 on stdout; `null` muxer for the calibration.
  --enable-encoder=libx264,aac,wrapped_avframe,pcm_s16le
  --enable-muxer=mp4,null
  --enable-bsf=aac_adtstoasc,extract_extradata,h264_mp4toannexb,hevc_mp4toannexb
  # Filters really used (setpts/asetpts/adelay/aresample/scale/format are also inserted automatically).
  --enable-filter=null,anull,setpts,asetpts,adelay,aresample,asetnsamples,astats,ametadata,metadata,scale,format,aformat,tblend,signalstats
)

echo "== ffmpeg"
cd ffmpeg
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
CONFIGURE=(./configure
  --prefix="$PREFIX/ff" --pkg-config-flags=--static
  --disable-everything --disable-autodetect --disable-doc --disable-debug --disable-ffplay --disable-ffprobe
  --enable-gpl --enable-version3 --enable-libx264 --enable-pthreads --enable-small --enable-static --disable-shared
  --extra-cflags="-I$PREFIX/include ${EXTRA_CFLAGS[*]:-}" --extra-ldflags="-L$PREFIX/lib ${EXTRA_CFLAGS[*]:-}"
  "${COMPONENTS[@]}" "${PLATFORM_ARGS[@]}")
"${CONFIGURE[@]}" > "$WORK/configure.log" 2>&1 || { tail -5 "$WORK/configure.log"; tail -40 ffbuild/config.log; exit 1; }
make -j"$JOBS" ffmpeg >/dev/null
strip ffmpeg 2>/dev/null || strip -x ffmpeg
cp ffmpeg "$OUT/ffmpeg"
chmod 755 "$OUT/ffmpeg"
{
  echo "ffmpeg ${FFMPEG_VERSION} ${FFMPEG_URL}"; echo "sha256 ${FFMPEG_SHA256}"
  echo "x264 ${X264_COMMIT} ${X264_URL}"; echo "sha256 ${X264_SHA256}"
  echo "arch ${ARCH}"; echo "configure: $(grep -m1 -- '^configuration:' <("$OUT/ffmpeg" -version) | cut -c16-)"
  echo "FFmpeg and x264 are GPL: https://ffmpeg.org/ https://www.videolan.org/developers/x264.html (sources pinned above)"
} > "$OUT/BUILD-INFO.txt"
(cd "$OUT" && if command -v sha256sum >/dev/null; then sha256sum ffmpeg; else shasum -a 256 ffmpeg; fi) | tee "$OUT/ffmpeg.sha256"
ls -l "$OUT/ffmpeg"
