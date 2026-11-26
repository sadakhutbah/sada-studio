# Source "Caméra IP + micro local"

The picture comes from an IP camera (RTSP over TCP), the sound from a sound card of this PC (DirectShow on Windows),
both read by **one** ffmpeg so that they share a clock; the audio is delayed (50 ms steps) to line up with the picture.

## In the application

Settings (gear button) → **Source du direct** → *Caméra IP + micro local*:

- RTSP address of the camera (applied when leaving the field), sound card chosen in the list of DirectShow inputs
  (↻ re-reads it; the list comes from `ffmpeg -list_devices true -f dshow -i dummy`, over IPC).
- **Décalage du son**: −50 ms / +50 ms buttons. The value is saved at once for the selected sound card and applied by a
  single capture restart once the clicks stop.
- **Calibrer**: the capture pauses, the operator claps in front of the camera for ~10 s, the measured gap is shown and
  stored as the delay of that sound card. A negative gap (sound *after* the picture) cannot be fixed by a delay: 0 and a message.
- **État de la capture** (idle / starting / running / reconnecting n / alert) in the panel and under the preview.

The same source serves the preview, the **manual live** and the **schedule**: the choice lives in the main process and the
renderer's single source object routes on it (`RoutingSource`: PC camera or IP camera), so the keeper that follows the server
order needs no change. While a live runs, the settings are locked (as for the PC camera).

## Persistence (per device, `userData`)

- `capture-settings.json`: source choice, RTSP address, sound card (written atomically, mode 0600: the address can carry credentials).
- `audio-offsets.json`: delay per sound card (`backend:device`), re-read at every ffmpeg (re)start, so a reconnection keeps it.

## Output chain (decision)

ffmpeg writes **fragmented MP4 on stdout**; the main process forwards the boxes (`Mp4Splitter`) to the renderer, which plays
them with MediaSource in a hidden `<video>` and hands its `captureStream()` tracks to the **existing WHIP chain** (`BroadcastSession`
+ `WhipTransport`): ffmpeg is therefore never given the device secret or the WHIP endpoint, and the reconnection, bitrate/RTT
statistics, conflict handling and heartbeat reports of the existing chain apply unchanged (ffmpeg's own WHIP muxer would have
needed the device secret on a command line and a DTLS-enabled build, and would have bypassed all of that).
Cost: the video is decoded and re-encoded once more by WebRTC (CPU on the PC); after an ffmpeg restart the player continues the same
timeline (`sequence` mode), the tracks never end.

## Health and alerts

`CaptureController.healthCheck()` (id `capture`, red after 2 min without picture) is added to every heartbeat by
`KioskSupervisor.setCheckProvider`; `refreshChecks()` sends an outage or its recovery at once. Only when this source is selected.
The camera/microphone counts of the PC are replaced by the capture's own tracks in that mode. Passwords in the RTSP address are
redacted (`rtsp://user:***@…`) in the status line, errors and logs.

## ffmpeg

Resolved by `resolveFfmpeg`: `SADA_FFMPEG`, else `resources/ffmpeg/ffmpeg(.exe)` (shipped by the installer), else the `PATH`.
`npm run dist:win` runs `scripts/fetch-ffmpeg-win.mjs` (BtbN static GPL build, SHA-256 checked against the published list,
`build/ffmpeg/` is git-ignored, the CI Windows job does the same). ffmpeg runs as a separate process (GPL, not linked).

On macOS the app ships a **minimal** ffmpeg (about 5 MB per architecture instead of 67-95 MB): `scripts/build-ffmpeg-min.sh` builds ffmpeg + x264
from pinned, checksummed sources with only the components used here (RTSP/TCP, avfoundation, libx264, aac, fragmented MP4, the calibration
filters). The "ffmpeg (macOS minimal build)" workflow builds both architectures, runs `scripts/test-ffmpeg-min.sh` (the real capture and
calibration command lines against an RTSP stream) and publishes them; `scripts/fetch-ffmpeg-mac.mjs` downloads them by pinned SHA-256.
**Any new ffmpeg option or filter used in `src/core/capture` needs its component added to `COMPONENTS` in the build script** (and a new
published build + pin), otherwise the shipped binary fails at runtime with "Unknown encoder/filter/format". Windows still uses the BtbN build.

## Code

`src/core/capture/` (pure logic: strategy registry, `buildCaptureArgs`, state machine, controller with reconnection and alert,
calibration, `mp4-boxes`, `settings`), `src/main/capture-service.ts` (service), `capture-files.ts` (persistence),
`ffmpeg-io.ts` (processes), `src/core/sources/{ip-camera,routing}.ts` + `src/renderer/src/mse-player.ts` (source and player),
`src/renderer/src/screens/IpCameraSettings.tsx` (UI).

## Simulated site

Durable simulated camera (WSL / Linux), joinable from Windows on the same PC:

    scripts/sim-rtsp/install.sh          # systemd user services sada-sim-mediamtx + sada-sim-camera (restart on failure)
    scripts/sim-rtsp/install.sh uninstall

`rtsp://studio:studio@127.0.0.1:8554/cam` (RTSP/TCP, 1280×720 25 fps H.264 + AAC; reader `studio`/`studio`, loopback only).
The picture shows the wall clock (HH:MM:SS) and a running timer; every 2 s (on the wall clock) it flashes white for 120 ms
with a 1 kHz beep in the camera's own audio. mediamtx binary: `$MEDIAMTX`, `PATH` or `~/sim-rtsp/bin/mediamtx`.
Check from Windows: `ffprobe.exe -rtsp_transport tcp rtsp://studio:studio@127.0.0.1:8554/cam`.

Tests against a simulated site (mediamtx + ffmpeg test camera + sound-card stand-in, `pcm` backend):

    SADA_E2E=1 SADA_MEDIAMTX=/path/to/mediamtx npx vitest run tests/e2e
    scripts/e2e-env.sh start|stop     # same site, for manual experiments
    node scripts/test-audio-feeder.mjs 18999 2000 [offset-ms]    # beeping "sound card"

Dev-only knobs (ignored by an installed application): `SADA_STUDIO_AUDIO_BACKEND=pcm` (audio device = `tcp://127.0.0.1:18999`),
`SADA_STUDIO_WINDOW=1920x1200`, `SADA_STUDIO_DUMP=/tmp/x` (one fMP4 file per capture run, to measure the A/V alignment).

## Known limits

- Alignment was measured on the simulated site only (the sound card is a TCP stand-in): calibration found 406 ms where the
  offline analysis of the same output found 401 ms; applying the delay in the final fragmented stream left 0 to 3 ms with the
  machine idle. Under load (Electron in software rendering next to the simulated camera) the stamping of each input at read time
  moved the alignment by 200–500 ms. A real DirectShow card (driver-side stamps, `-audio_buffer_size 50`) must be checked by
  ear with the ±50 ms buttons.
- A delay above ~1 s with `aresample async` loses beeps in some runs; real needs are a few hundred ms.
- The WebRTC leg to Sada itself was not exercised against a real Sada server (the mock has no media); the captured tracks were
  sent through a loopback RTCPeerConnection (video frames decoded, audio packets received).

## Webcam mode (PC camera)

Same assistant and same "Advanced" section. The delay is applied in the renderer: a Web Audio `DelayNode` sits between the microphone and the track handed to WHIP (`core/sources/audio-delay.ts`), so a change is live (no capture restart). It is saved in the UI preferences per camera/microphone pair (`webcamDelays`). Calibration records the microphone level (before the delay) and the picture motion in the renderer (`webcam-calibration.ts`) and uses the same analysis as the IP camera (`calibrateSeries`). Without Web Audio the stream is used as is.
