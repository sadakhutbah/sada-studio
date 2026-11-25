/** Flow control and pixel helpers for the web-source frames (main process -> UI), kept free of Electron so they can be tested. */

/** Frames above this size are scaled down by the main process before they cross the IPC. */
export const MAX_FRAME_WIDTH = 1280;
export const MAX_FRAME_HEIGHT = 720;
export const DEFAULT_FRAME_FPS = 15;
export const MAX_FRAME_FPS = 30;
/** A frame the UI never acknowledged (window reloaded, crash) stops blocking the next ones after this delay. */
export const FRAME_ACK_TIMEOUT_MS = 1000;

/**
 * Decides whether a painted frame is sent: at most `fps` per second, and never while the previous one is still
 * unacknowledged by the UI (a slow consumer loses frames instead of building a queue).
 */
export class FrameGate {
  private minIntervalMs: number;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private inFlightSince: number | null = null;

  constructor(
    fps = DEFAULT_FRAME_FPS,
    private readonly ackTimeoutMs = FRAME_ACK_TIMEOUT_MS,
  ) {
    this.minIntervalMs = FrameGate.interval(fps);
  }

  private static interval(fps: number): number {
    const f = Math.max(1, Math.min(MAX_FRAME_FPS, Math.round(fps) || DEFAULT_FRAME_FPS));
    return Math.round(1000 / f);
  }

  setFps(fps: number): void {
    this.minIntervalMs = FrameGate.interval(fps);
  }

  /** True when a frame may be sent now; the gate then counts it as in flight until `ack()`. */
  tryBegin(now: number): boolean {
    if (this.inFlightSince !== null && now - this.inFlightSince < this.ackTimeoutMs) return false;
    if (now - this.lastSentAt < this.minIntervalMs) return false;
    this.lastSentAt = now;
    this.inFlightSince = now;
    return true;
  }

  /** The UI consumed the last frame. */
  ack(): void {
    this.inFlightSince = null;
  }

  reset(): void {
    this.inFlightSince = null;
    this.lastSentAt = Number.NEGATIVE_INFINITY;
  }
}

/** Largest size with the same aspect ratio that fits in the bounds; never upscales. */
export function fitWithin(width: number, height: number, maxWidth = MAX_FRAME_WIDTH, maxHeight = MAX_FRAME_HEIGHT): { width: number; height: number } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const scale = Math.min(1, maxWidth / w, maxHeight / h);
  return scale >= 1 ? { width: w, height: h } : { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * Premultiplied BGRA (what `NativeImage.toBitmap()` returns) to the straight RGBA that `ImageData` expects.
 * `dst` can be passed to reuse one buffer from frame to frame.
 */
export function bgraPremulToRgba(src: Uint8Array, width: number, height: number, dst?: Uint8ClampedArray<ArrayBuffer>): Uint8ClampedArray<ArrayBuffer> {
  const n = width * height * 4;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || src.length < n) {
    throw new Error("Invalid frame");
  }
  const out = dst && dst.length === n ? dst : new Uint8ClampedArray(n);
  for (let i = 0; i < n; i += 4) {
    const b = src[i]!;
    const g = src[i + 1]!;
    const r = src[i + 2]!;
    const a = src[i + 3]!;
    if (a === 255) {
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
    } else if (a === 0) {
      out[i] = out[i + 1] = out[i + 2] = 0;
    } else {
      const k = 255 / a;
      out[i] = Math.min(255, Math.round(r * k));
      out[i + 1] = Math.min(255, Math.round(g * k));
      out[i + 2] = Math.min(255, Math.round(b * k));
    }
    out[i + 3] = a;
  }
  return out;
}
