import type { MediaSourceStrategy, SourceOptions } from "./types";

/**
 * Plays the capture of the main process (ffmpeg → fragmented MP4) and exposes it as a MediaStream. The DOM and IPC
 * parts (MediaSource, `<video>`, `window.studio.capture`) are in the renderer; this class only owns the lifecycle.
 */
export interface CapturePlayer {
  /** Starts the capture and resolves with the stream once picture and sound are flowing. Rejects (FatalError) otherwise. */
  open(): Promise<MediaStream>;
  /** Stops the capture and the player. */
  close(): void;
  /** The capture stopped delivering for good (not a transient reconnection, which the main process handles). */
  onEnded(cb: () => void): () => void;
}

const key = (o: SourceOptions) => JSON.stringify([o.sourceKind, o.ipCamera]);

/** "IP camera + local microphone" as a source of the broadcast session: same contract as `CameraSource`. */
export class IpCameraSource implements MediaSourceStrategy {
  readonly id = "ip-camera";
  private stream: MediaStream | null = null;
  private streamKey = "";
  private opening: { key: string; promise: Promise<MediaStream> } | null = null;
  private readonly endedListeners = new Set<() => void>();
  private offEnded: (() => void) | null = null;

  constructor(private readonly createPlayer: () => CapturePlayer) {}

  private player: CapturePlayer | null = null;

  async acquire(options: SourceOptions): Promise<MediaStream> {
    const k = key(options);
    if (this.stream && k === this.streamKey && this.stream.getTracks().every((t) => t.readyState === "live")) return this.stream;
    // The same opening in progress (preview and keeper asking together) is shared, not restarted.
    if (this.opening?.key === k) return this.opening.promise;
    this.release();
    const player = this.createPlayer();
    this.player = player;
    this.offEnded = player.onEnded(() => this.endedListeners.forEach((cb) => cb()));
    const promise = player.open().then(
      (s) => {
        if (this.player !== player) {
          // Released while opening: the late stream is useless.
          s.getTracks().forEach((t) => t.stop());
          throw new Error("released");
        }
        this.stream = s;
        this.streamKey = k;
        this.opening = null;
        return s;
      },
      (e) => {
        if (this.player === player) this.release();
        throw e;
      },
    );
    this.opening = { key: k, promise };
    return promise;
  }

  release(): void {
    this.offEnded?.();
    this.offEnded = null;
    this.player?.close();
    this.player = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.streamKey = "";
    this.opening = null;
  }

  onEnded(cb: () => void): () => void {
    this.endedListeners.add(cb);
    return () => this.endedListeners.delete(cb);
  }
}
