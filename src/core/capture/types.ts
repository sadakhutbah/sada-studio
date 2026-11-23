/** Where the audio of an "IP camera + local microphone" source comes from. */
export type AudioBackend = "dshow" | "alsa" | "avfoundation" | "pcm";

/** User configuration of the source (persisted by the main process). */
export interface IpCameraConfig {
  /** Remote camera, e.g. rtsp://user:pass@192.168.1.20:554/stream1 (always pulled over TCP). */
  rtspUrl: string;
  /** Sound card input: DirectShow name on Windows. Free text for the other backends. */
  audioDevice: string;
  audioBackend: AudioBackend;
  /** Extra ffmpeg output arguments: where the encoded A/V goes (WHIP, RTMP, file…). */
  outputArgs: string[];
}

export const AUDIO_DELAY_STEP_MS = 50;
export const AUDIO_DELAY_MAX_MS = 5000;

/** Audio delay quantized to the console's step and bounded to what adelay may compensate. */
export function normalizeDelay(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  const q = Math.round(ms / AUDIO_DELAY_STEP_MS) * AUDIO_DELAY_STEP_MS;
  return Math.min(AUDIO_DELAY_MAX_MS, Math.max(0, q));
}

/** Files the calibration run writes; the strategy decides how ffmpeg fills them. */
export interface CalibrationFiles {
  audioLevels: string;
  videoMotion: string;
}

/**
 * Capture source strategy: one class per kind of source, chosen from `CaptureSourceRegistry`.
 * It only knows how to describe ffmpeg command lines; running the process is the controller's job.
 * (`core/sources` is the MediaStream side of the same idea, for sources the renderer can open itself.)
 */
export interface CaptureSourceStrategy {
  readonly id: string;
  /** Full ffmpeg arguments of the live capture (one process, two inputs). */
  buildCaptureArgs(config: IpCameraConfig, audioDelayMs: number, clockBaseS?: number): string[];
  /** ffmpeg arguments writing per-frame motion and per-10 ms audio levels for `seconds`, without any delay applied. */
  buildCalibrationArgs(config: IpCameraConfig, seconds: number, files: CalibrationFiles): string[];
}

export interface AudioOffsetStore {
  /** Delay saved for this audio device, `undefined` when never calibrated. */
  get(deviceKey: string): number | undefined;
  set(deviceKey: string, delayMs: number): void;
}
