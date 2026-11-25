import type { SceneCompositor } from "../extension-points";
import { computeBrowserSourceRect, DEFAULT_BROWSER_SOURCE } from "./browser-source";
import { chooseOutput, nextCanvasSize, streamKey, type CompositorDemand, type OutputMode } from "./compositor-logic";
import { bgraPremulToRgba } from "./frame-gate";
import type { BrowserSourceConfig, BrowserSourceFrame, MediaSourceStrategy, SourceOptions, SourceSync } from "./types";

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_FPS = 30;

/** What `CompositedSource` needs from a compositor (an interface so it can be replaced in tests). */
export interface OutputCompositor {
  /** The composited stream (created on first use). */
  compose(inputs: MediaStream[]): MediaStream;
  /** Starts or pauses the drawing loop: nothing is drawn while the raw stream is what goes out. */
  setRunning(running: boolean): void;
  dispose(): void;
}

/**
 * Composites the active video stream with an optional local Browser Source
 * (fullscreen or corner/size overlay) onto a continuous canvas MediaStream.
 *
 * The drawing is driven by a timer, not by requestAnimationFrame: rAF stops when the window is hidden (the app lives in
 * the notification area during a live), which would freeze the broadcast. The window keeps `backgroundThrottling: false`.
 */
export class StudioSceneCompositor implements SceneCompositor, OutputCompositor {
  readonly sceneId = "studio-regie";
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private baseVideo: HTMLVideoElement | null = null;
  private outputStream: MediaStream | null = null;
  private audioTrackIds = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private browserConfig: BrowserSourceConfig = { ...DEFAULT_BROWSER_SOURCE };
  /** The latest web-source frame, kept as a canvas (one `putImageData` per frame, no decoding, no allocation). */
  private browserCanvas: HTMLCanvasElement | null = null;
  private browserPixels: Uint8ClampedArray<ArrayBuffer> | null = null;
  private hasBrowserFrame = false;
  private disposed = false;

  setBrowserConfig(config: BrowserSourceConfig): void {
    this.browserConfig = { ...config };
    if (!config.visible) this.clearBrowserFrame();
  }

  /** Returns whether the frame was taken (false: hidden source or no DOM), so the caller can acknowledge it either way. */
  pushBrowserFrame(frame: BrowserSourceFrame): boolean {
    if (this.disposed || !this.browserConfig.visible || typeof document === "undefined") return false;
    const { width, height } = frame;
    const canvas = (this.browserCanvas ??= document.createElement("canvas"));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      this.browserPixels = null;
    }
    const rgba = bgraPremulToRgba(frame.bgra, width, height, this.browserPixels ?? undefined);
    this.browserPixels = rgba;
    canvas.getContext("2d")?.putImageData(new ImageData(rgba, width, height), 0, 0);
    this.hasBrowserFrame = true;
    return true;
  }

  clearBrowserFrame(): void {
    this.hasBrowserFrame = false;
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
    this.setRunning(true);
    return this.outputStream!;
  }

  updateInput(primary: MediaStream): void {
    if (!this.outputStream || typeof document === "undefined") return;
    this.attachPrimary(primary);
  }

  setRunning(running: boolean): void {
    if (!running) {
      if (this.timer !== null) clearInterval(this.timer);
      this.timer = null;
      return;
    }
    if (this.timer !== null || this.disposed || !this.canvas) return;
    this.timer = setInterval(() => this.drawFrame(), Math.round(1000 / DEFAULT_FPS));
  }

  dispose(): void {
    this.disposed = true;
    this.setRunning(false);
    this.clearBrowserFrame();
    this.browserCanvas = null;
    this.browserPixels = null;
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

  private drawFrame(): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx) return;

    const v = this.baseVideo;
    // Resizing clears the canvas and renegotiates the encoder: only when the real resolution changed.
    const size = nextCanvasSize(canvas, v);
    if (size) {
      canvas.width = size.width;
      canvas.height = size.height;
    }

    const cw = canvas.width;
    const ch = canvas.height;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, cw, ch);

    const browser = this.browserConfig.visible && this.hasBrowserFrame ? this.browserCanvas : null;
    const fullBrowser = browser !== null && this.browserConfig.mode === "fullscreen";
    if (!fullBrowser && v && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0) {
      ctx.drawImage(v, 0, 0, cw, ch);
    }

    if (browser) {
      const aspect = browser.width / Math.max(1, browser.height);
      const rect = computeBrowserSourceRect(cw, ch, this.browserConfig, aspect);
      if (this.browserConfig.mode === "overlay") {
        ctx.save();
        ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
        ctx.shadowBlur = 14;
        ctx.drawImage(browser, rect.x, rect.y, rect.width, rect.height);
        ctx.restore();
      } else {
        ctx.drawImage(browser, rect.x, rect.y, rect.width, rect.height);
      }
    }
  }
}

export interface CompositedSourceOptions {
  /** False where there is no DOM (tests, node): the raw stream always goes out. */
  canvasAvailable?: boolean;
}

/**
 * Wraps a MediaSourceStrategy (RoutingSource) with the compositor. The raw source stream goes out as is; as soon as a
 * web source or the shared screen is shown, the canvas stream goes out instead, and back. Each switch is announced
 * through `onStreamChange` so the session can `replaceTrack` on the live senders without cutting the connection.
 */
export class CompositedSource implements MediaSourceStrategy {
  readonly id = "composited";
  private raw: MediaStream | null = null;
  private mode: OutputMode = "raw";
  private lastKey = "";
  private readonly changeListeners = new Set<(s: MediaStream) => void>();
  private readonly canvasAvailable: boolean;

  constructor(
    private readonly inner: MediaSourceStrategy,
    readonly compositor: OutputCompositor,
    opts: CompositedSourceOptions = {},
  ) {
    this.canvasAvailable = opts.canvasAvailable ?? typeof document !== "undefined";
  }

  get outputMode(): OutputMode {
    return this.mode;
  }

  /** The browser/screen demand changed: switch between the raw stream and the canvas without releasing the source. */
  setDemand(d: CompositorDemand): void {
    const next = this.canvasAvailable ? chooseOutput(d) : "raw";
    if (next === this.mode) return;
    this.mode = next;
    if (next === "canvas") this.engageCanvas();
    else this.compositor.setRunning(false);
    this.announce();
  }

  async acquire(options: SourceOptions): Promise<MediaStream> {
    const raw = await this.inner.acquire(options);
    this.raw = raw;
    if (this.mode === "canvas") this.engageCanvas();
    const out = this.output(raw);
    this.lastKey = streamKey(out);
    return out;
  }

  release(): void {
    this.inner.release();
    this.compositor.dispose();
    this.raw = null;
    this.lastKey = "";
  }

  onEnded(cb: () => void): () => void {
    return this.inner.onEnded(cb);
  }

  /** The stream to send changed (raw <-> canvas, or the tracks behind it): listeners swap their senders' tracks. */
  onStreamChange(cb: (s: MediaStream) => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  get sync(): SourceSync | undefined {
    return this.inner.sync;
  }

  private engageCanvas(): void {
    if (!this.raw) return;
    // `compose` reuses the canvas and its captured track once created; it only re-attaches the input and restarts the loop.
    this.compositor.compose([this.raw]);
  }

  private output(raw: MediaStream): MediaStream {
    return this.mode === "canvas" && this.canvasAvailable ? this.compositor.compose([raw]) : raw;
  }

  private announce(): void {
    if (!this.raw) return;
    const out = this.output(this.raw);
    const key = streamKey(out);
    if (key === this.lastKey) return;
    this.lastKey = key;
    for (const cb of this.changeListeners) cb(out);
  }
}
