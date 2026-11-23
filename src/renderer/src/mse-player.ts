import { FatalError } from "@core/errors";
import { t } from "@core/messages";
import { MSE_MIME } from "@core/capture/settings";
import type { CapturePlayer } from "@core/sources/ip-camera";
import type { CaptureMedia } from "@shared/ipc";

/** How far behind the live edge the player may drift before it jumps forward (seconds). */
const MAX_LAG_S = 1.2;
const KEEP_BEHIND_S = 6;
/** First picture and sound must arrive within this time of the start (RTSP connection + ffmpeg start). */
const OPEN_TIMEOUT_MS = 30_000;

/**
 * Plays the fragmented MP4 pushed by the main process through MediaSource, in a detached `<video>`, and exposes its
 * tracks with `captureStream()`: they feed the existing WHIP chain like a camera's. Sequence mode: after an ffmpeg
 * restart (reconnection, new delay) the new init segment continues the timeline, the tracks never end.
 */
export class MsePlayer implements CapturePlayer {
  private readonly video = document.createElement("video");
  private mediaSource: MediaSource | null = null;
  private buffer: SourceBuffer | null = null;
  private queue: Uint8Array[] = [];
  private offMedia: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private url = "";
  private closed = false;

  constructor() {
    this.video.muted = true;
    this.video.playsInline = true;
  }

  async open(): Promise<MediaStream> {
    if (!("MediaSource" in window) || !MediaSource.isTypeSupported(MSE_MIME)) throw new FatalError(t("capture.unsupported"), "capture");
    const ms = new MediaSource();
    this.mediaSource = ms;
    this.url = URL.createObjectURL(ms);
    this.video.src = this.url;
    await new Promise<void>((resolve) => ms.addEventListener("sourceopen", () => resolve(), { once: true }));
    const sb = ms.addSourceBuffer(MSE_MIME);
    sb.mode = "sequence";
    sb.addEventListener("updateend", () => this.pump());
    this.buffer = sb;
    this.offMedia = window.studio.capture.onMedia((m) => this.enqueue(m));

    const started = await window.studio.capture.acquire();
    if (!started.ok) throw new FatalError(started.message, "capture");
    void this.video.play().catch(() => undefined);
    this.timer = setInterval(() => this.keepLive(), 1000);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new FatalError(t("capture.timeout"), "capture")), OPEN_TIMEOUT_MS);
      const ready = () => {
        clearTimeout(timeout);
        resolve();
      };
      if (this.video.readyState >= 2) ready();
      else this.video.addEventListener("loadeddata", ready, { once: true });
    });
    if (this.closed) throw new Error("released");
    // Tracks exist once the first data is decoded; asked now they are complete (picture + sound).
    const video = this.video as HTMLVideoElement & { captureStream(): MediaStream };
    return video.captureStream();
  }

  onEnded(): () => void {
    // The tracks of a MediaSource player do not end on a reconnection; an outage is reported by the capture health check.
    return () => undefined;
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.offMedia?.();
    this.offMedia = null;
    void window.studio.capture.release();
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.queue = [];
    this.buffer = null;
    this.mediaSource = null;
  }

  private enqueue(m: CaptureMedia): void {
    if (this.closed) return;
    this.queue.push(m.data);
    this.pump();
  }

  private pump(): void {
    const sb = this.buffer;
    if (!sb || sb.updating || this.mediaSource?.readyState !== "open") return;
    const next = this.queue.shift();
    if (!next) return;
    try {
      sb.appendBuffer(next as Uint8Array<ArrayBuffer>);
    } catch (e) {
      // Quota: drop what is behind the playhead and try this unit again.
      if (e instanceof DOMException && e.name === "QuotaExceededError") {
        this.queue.unshift(next);
        this.trim(0);
      }
    }
  }

  private trim(keepS: number): void {
    const sb = this.buffer;
    if (!sb || sb.updating || sb.buffered.length === 0) return;
    const to = this.video.currentTime - keepS;
    if (to > sb.buffered.start(0) + 1) sb.remove(sb.buffered.start(0), to);
  }

  /** Live edge: when the playhead falls behind (restart gap, slow start), jump to the end of the buffer. */
  private keepLive(): void {
    const sb = this.buffer;
    if (!sb || sb.buffered.length === 0) return;
    const end = sb.buffered.end(sb.buffered.length - 1);
    if (end - this.video.currentTime > MAX_LAG_S) this.video.currentTime = end - 0.15;
    if (this.video.paused) void this.video.play().catch(() => undefined);
    this.trim(KEEP_BEHIND_S);
  }
}
