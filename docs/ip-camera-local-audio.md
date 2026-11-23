# Source "Caméra IP + micro local" (prototype)

Code: `src/core/capture/` (pure logic, tested), `src/main/ffmpeg-io.ts` (node process / temp files).

- `CaptureSourceStrategy` / `CaptureSourceRegistry`: one class per source kind (`IpCameraLocalAudioSource`, id `ip-camera-local-audio`).
- `buildCaptureArgs`: one ffmpeg, two inputs (RTSP over TCP + sound card), `-use_wallclock_as_timestamps 1` on both,
  `-copyts` and the same clock base subtracted from both streams, audio `adelay` (50 ms step, stored per device) then
  `aresample=async=1`.
- `CaptureMachine` + `CaptureController`: idle/starting/running/reconnecting/stopping, backoff, frame-counter watchdog,
  the saved delay is re-read at every restart, `healthCheck()` returns a `capture` check for the heartbeat
  (the server's existing operator e-mail path) and `onAlert` fires after a prolonged outage (default 2 min).
- `calibrateClap`: records motion (frame difference) and audio level on the shared clock, finds the clap in both
  and returns the delay to store. A negative gap (sound after picture) cannot be fixed by `adelay`: delay 0 + flag.

Integration tests with a simulated site (mediamtx + ffmpeg test camera + sound-card stand-in):

    SADA_E2E=1 SADA_MEDIAMTX=/path/to/mediamtx npx vitest run tests/e2e
    scripts/e2e-env.sh start|stop     # same site, for manual experiments
