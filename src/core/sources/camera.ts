import { FatalError } from "../errors";
import type { MediaSourceStrategy, SourceOptions } from "./types";

const key = (o: SourceOptions) => JSON.stringify(o);

/** Caméra + micro via getUserMedia. `devices` est injectable (tests, autre environnement). */
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
      throw new FatalError(describeMediaError(e));
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
  if (name === "NotAllowedError") return "Accès à la caméra ou au micro refusé par le système.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "Caméra ou micro introuvable.";
  if (name === "NotReadableError") return "Caméra ou micro déjà utilisé par une autre application.";
  return e instanceof Error ? e.message : "Capture impossible.";
}
