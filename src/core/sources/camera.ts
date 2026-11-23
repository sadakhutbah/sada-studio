import { FatalError } from "../errors";
import { t } from "../messages";
import type { CalibrationOutcome } from "../capture/calibrator";
import { AudioDelay } from "./audio-delay";
import type { MediaSourceStrategy, SourceOptions, SourceSync } from "./types";
import { BrowserSeriesRecorder, calibrateWebcam, type SeriesRecorder } from "./webcam-calibration";

/** The audio delay is applied live (never restarts the capture): it is not part of the identity of the stream. */
const key = (o: SourceOptions) => JSON.stringify({ ...o, audioDelayMs: undefined });

/** Camera + microphone via getUserMedia. `devices` is injectable (tests, other environments). */
export class CameraSource implements MediaSourceStrategy {
  readonly id = "camera";
  private stream: MediaStream | null = null;
  private raw: MediaStream | null = null;
  private delay: AudioDelay | null = null;
  private streamKey = "";
  private readonly endedListeners = new Set<() => void>();

  constructor(
    private readonly devices: Pick<MediaDevices, "getUserMedia"> = navigator.mediaDevices,
    /** Audio delay stage; `null` = no Web Audio (the stream is used as is, without synchronization). */
    private readonly createDelay: (raw: MediaStream, ms: number) => AudioDelay | null = (raw, ms) => {
      try {
        return new AudioDelay(raw, ms);
      } catch {
        return null;
      }
    },
    /** System permission (macOS), checked before getUserMedia: a refused or pending permission must not re-open the prompt. */
    private readonly access: () => Promise<{ camera: boolean; microphone: boolean }> = () =>
      typeof window !== "undefined" && window.studio?.media
        ? window.studio.media.access()
        : Promise.resolve({ camera: true, microphone: true }),
  ) {}

  /** Webcam strategy of the synchronization: live delay + clap calibration (the analysis is shared with the IP camera). */
  readonly sync: SourceSync = {
    setAudioDelay: (ms) => this.delay?.setDelayMs(ms),
    calibrate: (seconds = 10) => this.calibrate(seconds),
  };

  /** Clap calibration on the open stream (microphone measured before the delay). */
  async calibrate(seconds = 10, recorder?: SeriesRecorder): Promise<CalibrationOutcome> {
    const rec = recorder ?? (this.raw && this.delay?.analyser ? new BrowserSeriesRecorder(this.raw, this.delay.analyser, this.delay.inputLatencyS) : null);
    if (!rec) return { ok: false, reason: "ffmpeg", detail: t("media.notFound") };
    return calibrateWebcam(rec, seconds);
  }

  async acquire(options: SourceOptions): Promise<MediaStream> {
    const k = key(options);
    if (this.stream && this.raw && k === this.streamKey && this.raw.getTracks().every((t) => t.readyState === "live")) {
      if (options.audioDelayMs !== undefined) this.delay?.setDelayMs(options.audioDelayMs);
      return this.stream;
    }
    this.release();
    const granted = await this.access();
    if (!granted.camera || !granted.microphone) throw new FatalError(t("media.deniedSystem"), "capture");
    const v = options.video ?? { width: 1920, height: 1080, frameRate: 30 };
    let stream: MediaStream;
    try {
      stream = await this.devices.getUserMedia({
        video: {
          ...(options.videoDeviceId ? { deviceId: { exact: options.videoDeviceId } } : {}),
          width: { ideal: v.width },
          height: { ideal: v.height },
          frameRate: { ideal: v.frameRate },
        },
        audio: {
          ...(options.audioDeviceId ? { deviceId: { exact: options.audioDeviceId } } : {}),
          ...options.audio,
          channelCount: { ideal: 2 },
        },
      });
    } catch (e) {
      throw new FatalError(describeMediaError(e), "capture");
    }
    for (const t of stream.getTracks()) t.addEventListener("ended", () => this.endedListeners.forEach((cb) => cb()));
    this.raw = stream;
    this.delay = this.createDelay(stream, options.audioDelayMs ?? 0);
    this.stream = this.delay?.output ?? stream;
    this.streamKey = k;
    return this.stream;
  }

  release(): void {
    this.raw?.getTracks().forEach((t) => t.stop());
    this.stream?.getTracks().forEach((t) => t.stop());
    this.delay?.close();
    this.delay = null;
    this.raw = null;
    this.stream = null;
    this.streamKey = "";
  }

  onEnded(cb: () => void): () => void {
    this.endedListeners.add(cb);
    return () => this.endedListeners.delete(cb);
  }
}

export function describeMediaError(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  if (name === "NotAllowedError") return t("media.denied");
  if (name === "NotFoundError" || name === "OverconstrainedError") return t("media.notFound");
  if (name === "NotReadableError") return t("media.inUse");
  return e instanceof Error ? e.message : t("media.failed");
}
