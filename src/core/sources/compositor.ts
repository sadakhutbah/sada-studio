import type { SceneCompositor } from "../extension-points";
import { computeBrowserSourceRect, DEFAULT_BROWSER_SOURCE } from "./browser-source";
import type { BrowserSourceConfig, BrowserSourceFrame, MediaSourceStrategy, SourceOptions, SourceSync } from "./types";

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_FPS = 30;

/**
 * Composites the active video stream with an optional local Browser Source
 * (fullscreen or corner/size overlay) onto a continuous canvas MediaStream.
 */
export class StudioSceneCompositor implements SceneCompositor {
  readonly sceneId = "studio-regie";
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private baseVideo: HTMLVideoElement | null = null;
  private outputStream: MediaStream | null = null;
  private audioTrackIds = new Set<string>();
  private rafId: number | null = null;
  private browserConfig: BrowserSourceConfig = { ...DEFAULT_BROWSER_SOURCE };
  private browserBitmap: ImageBitmap | null = null;
  private decoding = false;
  private pendingFrame: BrowserSourceFrame | null = null;
  private disposed = false;

  setBrowserConfig(config: BrowserSourceConfig): void {
    this.browserConfig = { ...config };
    if (!config.visible) {
      this.clearBrowserFrame();
    }
  }

  pushBrowserFrame(frame: BrowserSourceFrame): void {
    if (this.disposed || !this.browserConfig.visible) return;
    if (typeof createImageBitmap !== "function") return;
    if (this.decoding) {
      this.pendingFrame = frame;
      return;
    }
    void this.decodeFrame(frame);
  }

  clearBrowserFrame(): void {
    this.pendingFrame = null;
    if (this.browserBitmap) {
      this.browserBitmap.close();
      this.browserBitmap = null;
    }
  }

  compose(inputs: MediaStream[]): MediaStream {
    const primary = inputs[0];
    if (!primary) {
      throw new Error("No primary MediaStream provided to compositor");
    }
    if (typeof document === "undefined") {
      return primary;
    }

    this.ensureCanvas();
    this.attachPrimary(primary);
    this.startLoop();
    return this.outputStream!;
  }

  updateInput(primary: MediaStream): void {
    if (!this.outputStream || typeof document === "undefined") return;
    this.attachPrimary(primary);
  }

  dispose(): void {
    this.disposed = true;
    if (this.rafId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.clearBrowserFrame();
    if (this.baseVideo) {
      this.baseVideo.srcObject = null;
      this.baseVideo = null;
    }
    if (this.outputStream) {
      for (const track of this.outputStream.getVideoTracks()) {
        track.stop();
      }
      this.outputStream = null;
    }
    this.audioTrackIds.clear();
    this.canvas = null;
    this.ctx = null;
  }

  private ensureCanvas(): void {
    if (this.canvas && this.ctx && this.outputStream) return;
    this.disposed = false;
    const canvas = document.createElement("canvas");
    canvas.width = DEFAULT_WIDTH;
    canvas.height = DEFAULT_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;

    const captured = canvas.captureStream(DEFAULT_FPS);
    this.canvas = canvas;
    this.ctx = ctx;
    this.baseVideo = video;
    this.outputStream = new MediaStream(captured.getVideoTracks());
  }

  private attachPrimary(primary: MediaStream): void {
    if (!this.baseVideo || !this.outputStream) return;
    if (this.baseVideo.srcObject !== primary) {
      this.baseVideo.srcObject = primary;
      void this.baseVideo.play().catch(() => {
        /* autoplay policy ignored for muted offscreen video */
      });
    }

    const nextAudio = primary.getAudioTracks();
    const nextIds = new Set(nextAudio.map((t) => t.id));
    for (const existing of this.outputStream.getAudioTracks()) {
      if (!nextIds.has(existing.id)) {
        this.outputStream.removeTrack(existing);
        this.audioTrackIds.delete(existing.id);
      }
    }
    for (const track of nextAudio) {
      if (!this.audioTrackIds.has(track.id)) {
        this.outputStream.addTrack(track);
        this.audioTrackIds.add(track.id);
      }
    }
  }

  private async decodeFrame(frame: BrowserSourceFrame): Promise<void> {
    this.decoding = true;
    try {
      const bytes = new Uint8Array(frame.png.byteLength);
      bytes.set(frame.png);
      const blob = new Blob([bytes], { type: "image/png" });
      const bitmap = await createImageBitmap(blob);
      if (this.disposed || !this.browserConfig.visible) {
        bitmap.close();
        return;
      }
      if (this.browserBitmap) this.browserBitmap.close();
      this.browserBitmap = bitmap;
    } catch {
      // Ignore malformed/transient frame
    } finally {
      this.decoding = false;
      const queued = this.pendingFrame;
      this.pendingFrame = null;
      if (queued && !this.disposed && this.browserConfig.visible) {
        void this.decodeFrame(queued);
      }
    }
  }

  private startLoop(): void {
    if (this.rafId !== null || typeof requestAnimationFrame !== "function") return;
    const tick = () => {
      if (this.disposed) return;
      this.drawFrame();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private drawFrame(): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx) return;

    const v = this.baseVideo;
    if (v && v.videoWidth > 0 && v.videoHeight > 0) {
      if (canvas.width !== v.videoWidth || canvas.height !== v.videoHeight) {
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
      }
    }

    const cw = canvas.width;
    const ch = canvas.height;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, cw, ch);

    const fullBrowser = this.browserConfig.visible && this.browserConfig.mode === "fullscreen" && this.browserBitmap;
    if (!fullBrowser && v && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0) {
      ctx.drawImage(v, 0, 0, cw, ch);
    }

    if (this.browserConfig.visible && this.browserBitmap) {
      const aspect = this.browserBitmap.width / Math.max(1, this.browserBitmap.height);
      const rect = computeBrowserSourceRect(cw, ch, this.browserConfig, aspect);
      if (this.browserConfig.mode === "overlay") {
        ctx.save();
        ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
        ctx.shadowBlur = 14;
        ctx.drawImage(this.browserBitmap, rect.x, rect.y, rect.width, rect.height);
        ctx.restore();
      } else {
        ctx.drawImage(this.browserBitmap, rect.x, rect.y, rect.width, rect.height);
      }
    }
  }
}

/**
 * Wraps a MediaSourceStrategy (RoutingSource) with StudioSceneCompositor so that
 * preview and BroadcastSession share the same composited output stream and can
 * toggle Browser Source overlays or switch sources live without breaking the stream.
 */
export class CompositedSource implements MediaSourceStrategy {
  readonly id = "composited";
  private activeStream: MediaStream | null = null;

  constructor(
    private readonly inner: MediaSourceStrategy,
    readonly compositor: StudioSceneCompositor,
  ) {}

  async acquire(options: SourceOptions): Promise<MediaStream> {
    const raw = await this.inner.acquire(options);
    if (typeof document === "undefined") {
      this.activeStream = raw;
      return raw;
    }
    if (!this.activeStream) {
      this.activeStream = this.compositor.compose([raw]);
    } else {
      this.compositor.updateInput(raw);
    }
    return this.activeStream;
  }

  release(): void {
    this.inner.release();
    this.compositor.dispose();
    this.activeStream = null;
  }

  onEnded(cb: () => void): () => void {
    return this.inner.onEnded(cb);
  }

  get sync(): SourceSync | undefined {
    return this.inner.sync;
  }
}
