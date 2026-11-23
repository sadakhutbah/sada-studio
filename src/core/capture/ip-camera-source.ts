import { normalizeDelay, type AudioBackend, type CalibrationFiles, type CaptureSourceStrategy, type IpCameraConfig } from "./types";
import { CaptureSourceRegistry } from "./registry";

export const IP_CAMERA_SOURCE_ID = "ip-camera-local-audio";

/** Socket I/O timeout on the RTSP link, in microseconds: a dead camera ends the process instead of hanging it. */
const RTSP_IO_TIMEOUT_US = 5_000_000;

/** Both inputs are stamped with the same wall clock so that their relative offset survives the two separate clocks. */
const WALLCLOCK = ["-use_wallclock_as_timestamps", "1"];

/** `core` is also compiled for the renderer (no Node types there): the platform is read defensively. */
const hostPlatform = (): string => (globalThis as { process?: { platform?: string } }).process?.platform ?? "";

export function defaultAudioBackend(platform: string = hostPlatform()): AudioBackend {
  return platform === "win32" ? "dshow" : platform === "darwin" ? "avfoundation" : "alsa";
}

/** Input arguments of the sound card, per backend. */
export function audioInputArgs(c: Pick<IpCameraConfig, "audioBackend" | "audioDevice">): string[] {
  switch (c.audioBackend) {
    case "dshow":
      return [...WALLCLOCK, "-f", "dshow", "-audio_buffer_size", "50", "-i", `audio=${c.audioDevice}`];
    case "avfoundation":
      return [...WALLCLOCK, "-f", "avfoundation", "-i", `:${c.audioDevice}`];
    case "alsa":
      return [...WALLCLOCK, "-f", "alsa", "-i", c.audioDevice];
    case "pcm":
      // Test source: `audioDevice` is a file or FIFO of raw 48 kHz mono s16le, fed in real time like a sound card.
      return [...WALLCLOCK, "-f", "s16le", "-ar", "48000", "-ac", "1", "-i", c.audioDevice];
  }
}

/** Input arguments of the camera: RTSP over TCP only (UDP drops packets on mosque Wi-Fi/LAN equipment). */
export function rtspInputArgs(rtspUrl: string): string[] {
  // nobuffer + low_delay: without them the RTSP demuxer's buffering made the (separately stamped) audio input
  // jitter by hundreds of ms in measurements, which breaks the A/V alignment this source exists for.
  return [...WALLCLOCK, "-fflags", "nobuffer", "-flags", "low_delay", "-rtsp_transport", "tcp", "-timeout", String(RTSP_IO_TIMEOUT_US), "-i", rtspUrl];
}

/**
 * Drift correction (async=1: pad/trim against the timestamps). Sound cards deliver audio in buffers that get the
 * wall-clock stamp of their reading, so the stamps jitter by some tens of ms: the hard-correction threshold is
 * raised from ffmpeg's 0.1 s to 0.25 s so that this jitter is not "corrected" into audible glitches.
 */
export const ASYNC_RESAMPLE = "aresample=async=1:min_hard_comp=0.25";

/** Audio filter chain: fixed delay (all channels), then drift correction against the shared clock. */
export function audioFilter(delayMs: number): string {
  const d = normalizeDelay(delayMs);
  const chain = d > 0 ? [`adelay=delays=${d}:all=1`] : [];
  // No first_pts: the audio keeps its place on the shared clock, it is not re-based to zero on its own.
  chain.push(ASYNC_RESAMPLE);
  return chain.join(",");
}

/**
 * With -copyts both inputs keep their wall-clock stamps (≈ 1.79e9 s), which is what preserves their relative offset.
 * Muxers cannot take such values: the SAME constant is subtracted from both streams (not each from its own start).
 */
export const clockBaseSeconds = (nowMs: number = Date.now()) => Math.floor(nowMs / 1000) - 5;

const COMMON = ["-hide_banner", "-nostdin", "-loglevel", "error"];

/** "IP camera video + sound card audio" in one ffmpeg process. */
export class IpCameraLocalAudioSource implements CaptureSourceStrategy {
  readonly id = IP_CAMERA_SOURCE_ID;

  buildCaptureArgs(c: IpCameraConfig, audioDelayMs: number, clockBaseS: number = clockBaseSeconds()): string[] {
    return [
      ...COMMON,
      // stdout is the media (fragmented MP4 for the application), so progress goes to stderr.
      "-progress", "pipe:2", "-stats_period", "2",
      "-copyts",
      ...rtspInputArgs(c.rtspUrl),
      ...audioInputArgs(c),
      // One filter chain per stream, not a shared filter_complex: with adelay in a shared graph the audio timeline
      // came out mangled in measurements (audio-only or separate chains are exact).
      "-map", "0:v:0", "-map", "1:a:0",
      "-vf", `setpts=PTS-${clockBaseS}/TB`,
      "-af", `${audioFilter(audioDelayMs)},asetpts=PTS-${clockBaseS}/TB`,
      "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p", "-g", "50",
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
      ...c.outputArgs,
    ];
  }

  buildCalibrationArgs(c: IpCameraConfig, seconds: number, f: CalibrationFiles): string[] {
    return [
      ...COMMON,
      "-copyts",
      ...limitInput(rtspInputArgs(c.rtspUrl), seconds),
      ...limitInput(audioInputArgs(c), seconds),
      // Mean absolute difference between consecutive frames = motion; one line per frame with its pts.
      "-map", "0:v:0",
      "-vf", `scale=64:36,format=gray,tblend=all_mode=difference,signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=${filterPath(f.videoMotion)}`,
      "-fps_mode", "passthrough", "-f", "null", "-",
      // RMS level of every 10 ms of audio, same clock.
      "-map", "1:a:0",
      "-af", `aresample=48000:async=1:min_hard_comp=0.25,asetnsamples=n=480:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=${filterPath(f.audioLevels)}`,
      "-f", "null", "-",
    ];
  }
}

/** Caps how long an input is read (input option, so it is relative to the input and works with -copyts). */
export function limitInput(args: string[], seconds: number): string[] {
  const i = args.lastIndexOf("-i");
  return [...args.slice(0, i), "-t", String(seconds), ...args.slice(i)];
}

/** Escapes a path for a filtergraph option value (Windows drive colon, backslashes). */
export function filterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:");
}

export function defaultCaptureSources(): CaptureSourceRegistry {
  return new CaptureSourceRegistry().register(IP_CAMERA_SOURCE_ID, () => new IpCameraLocalAudioSource());
}
