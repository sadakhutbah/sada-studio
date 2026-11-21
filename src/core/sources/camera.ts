import { FatalError } from "../errors";
import { t } from "../messages";
import type { MediaSourceStrategy, SourceOptions } from "./types";

const key = (o: SourceOptions) => JSON.stringify(o);

/** Camera + microphone via getUserMedia. `devices` is injectable (tests, other environments). */
export class CameraSource implements MediaSourceStrategy {
  readonly id = "camera";
  private stream: MediaStream | null = null;
  private streamKey = "";
  private readonly endedListeners = new Set<() => void>();

  constructor(private readonly devices: Pick<MediaDevices, "getUserMedia"> = navigator.mediaDevices) {}

  async acquire(options: SourceOptions): Promise<MediaStream> {
    const k = key(options);
    if (this.stream && k === this.streamKey && this.stream.getTracks().every((t) => t.readyState === "live")) {
      return this.stream;
    }
    this.release();
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
    this.stream = stream;
    this.streamKey = k;
    return stream;
  }

  release(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
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
