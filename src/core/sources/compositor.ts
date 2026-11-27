import type { SceneKind } from "../api/types";
import type { OutputAudioMix } from "../audio/source-mix";
import type { SceneCompositor } from "../extension-points";
import {
  layerOrder,
  localCompositing,
  needsTransition,
  newTransitionFrame,
  programNeedsCanvas,
  TRANSITION_WAIT_MS,
  transitionFrame,
  type LayerFrame,
} from "../program/logic";
import { palette } from "../program/overlay-layout";
import { cssFont, OverlayPainter, OVERLAY_FONTS } from "../program/overlay-painter";
import { ProgramAssets, type FrameSink, type ProgramIO } from "../program/program-assets";
import type { ProgramView } from "../program/types";
import { computeBrowserSourceRect, DEFAULT_BROWSER_SOURCE } from "./browser-source";
import { chooseOutput, nextCanvasSize, streamKey, type CompositorDemand, type OutputMode } from "./compositor-logic";
import { FrameCanvas } from "./frame-canvas";
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
  /** The programme (scenes, overlays) needs the canvas, whatever the web source and the screen do. */
  programActive?(): boolean;
  onProgramActiveChange?(cb: () => void): () => void;
}

/** Housekeeping of the programme's pictures (revalidation, template countdown, pre-rendering). */
const PROGRAM_TICK_MS = 1_000;

interface SceneTransition {
  from: string;
  fromKind: SceneKind;
  fromLabel: string;
  mode: "fade" | "cut";
  waitSince: number;
  startedAt: number | null;
}

function canvasSink(): FrameSink<HTMLCanvasElement> {
  const f = new FrameCanvas();
  return { source: f.canvas, put: (frame) => f.put(frame), release: () => f.release() };
}

/**
 * Composites the programme onto a continuous canvas MediaStream, bottom to top: the active video stream (camera or
 * shared screen), the current scene (full screen masking the camera, or banner over it, with the engine's fade), the
 * local web source (fullscreen or corner overlay), then the overlays (logo, QR, free banner) drawn from the state.
 * Scenes and overlays are drawn only while the studio composes (`compositing: "studio"`, or the setup view).
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
  private browser: FrameCanvas | null = null;
  private hasBrowserFrame = false;
  private disposed = false;

  private width = DEFAULT_WIDTH;
  private height = DEFAULT_HEIGHT;
  private fps = DEFAULT_FPS;

  // --- programme (scenes and overlays, see setProgram) ---
  private program: ProgramView | null = null;
  private rehearsal = false;
  private forceLocal = false;
  private readonly io: ProgramIO | null;
  private assets: ProgramAssets<ImageBitmap, HTMLCanvasElement> | null = null;
  private overlays: OverlayPainter | null = null;
  private overlaysDirty = true;
  private fontsEpoch = 0;
  private fontsRequested = false;
  private transition: SceneTransition | null = null;
  private readonly tf = newTransitionFrame();
  private readonly steady: LayerFrame = { visible: true, alpha: 1, dx: 0, dy: 0 };
  private readonly fallbacks = new Map<string, HTMLCanvasElement>();
  private programTimer: ReturnType<typeof setInterval> | null = null;
  private active = false;
  private readonly activeListeners = new Set<() => void>();

  constructor(opts: { io?: ProgramIO } = {}) {
    this.io = opts.io ?? null;
  }

  /**
   * Size and frame rate of the picture (the quality chosen for the mosque). Taken when the canvas is created and by the
   * drawing loop the next time it starts: a canvas already running keeps following the real size of its video.
   */
  setProfile(p: { width: number; height: number; fps: number }): void {
    this.width = p.width;
    this.height = p.height;
    this.fps = p.fps;
  }



  /**
   * The programme to compose (scene, scenes, overlays, who composes). Called on every change of the Régie state;
   * a scene change starts the transition (fade or cut) once the incoming scene's picture is there (1.5 s at most).
   */
  setProgram(view: ProgramView | null): void {
    const prev = this.program;
    this.program = view;
    const local = localCompositing(view, this.composesLocally);
    if (view && prev && local && prev.scene !== view.scene) {
      const mode = view.transition ?? "fade";
      const fromKind = this.transition && this.transition.startedAt === null ? this.transition.fromKind : prev.sceneKind;
      this.transition = needsTransition(fromKind, view.sceneKind, mode)
        ? {
            from: prev.scene,
            fromKind,
            fromLabel: prev.scenes.find((s) => s.id === prev.scene)?.label ?? "",
            mode,
            waitSince: performance.now(),
            startedAt: null,
          }
        : null;
    } else if (!local) {
      this.transition = null;
    }
    this.overlaysDirty = true;
    this.programChanged();
  }

  /** Setup view open: the studio composes the rehearsal programme whatever `compositing` says. */
  setRehearsal(on: boolean): void {
    if (on === this.rehearsal) return;
    this.rehearsal = on;
    this.assets?.setScope(on);
    this.programChanged();
  }

  /**
   * The web control room watches our picture (preview, outside a live): compose the programme here whatever
   * `compositing` says, as it would go on air. Unlike the setup view, the live's own assets are used.
   */
  setForceLocal(on: boolean): void {
    if (on === this.forceLocal) return;
    this.forceLocal = on;
    this.programChanged();
  }

  private get composesLocally(): boolean {
    return this.rehearsal || this.forceLocal;
  }

  /** The canvas is needed by the programme (something drawn over or instead of the camera, or a transition running). */
  programActive(): boolean {
    return this.active;
  }

  onProgramActiveChange(cb: () => void): () => void {
    this.activeListeners.add(cb);
    return () => this.activeListeners.delete(cb);
  }

  private programChanged(): void {
    const local = localCompositing(this.program, this.composesLocally) && this.io !== null && typeof document !== "undefined";
    if (local) {
      this.ensureProgramTools();
      this.tickProgram();
      this.programTimer ??= setInterval(() => this.tickProgram(), PROGRAM_TICK_MS);
    } else if (this.programTimer !== null) {
      clearInterval(this.programTimer);
      this.programTimer = null;
    }
    this.updateActive();
  }

  private updateActive(): void {
    const active = this.io !== null && programNeedsCanvas(this.program, this.composesLocally, this.transition !== null);
    if (active === this.active) return;
    this.active = active;
    for (const cb of this.activeListeners) cb();
  }

  private ensureProgramTools(): void {
    if (!this.assets && this.io) {
      this.assets = new ProgramAssets<ImageBitmap, HTMLCanvasElement>({
        io: this.io,
        decode: (png) => createImageBitmap(new Blob([png as Uint8Array<ArrayBuffer>], { type: "image/png" })),
        release: (b) => b.close(),
        createSink: canvasSink,
        onChange: (what) => {
          if (what === "logo") this.overlaysDirty = true;
        },
      });
      this.assets.setScope(this.rehearsal);
    }
    this.overlays ??= new OverlayPainter();
    if (!this.fontsRequested && typeof document.fonts?.load === "function") {
      this.fontsRequested = true;
      void Promise.all(OVERLAY_FONTS.map((f) => document.fonts.load(f)))
        .catch(() => undefined)
        .then(() => {
          this.fontsEpoch++;
          this.overlaysDirty = true;
        });
    }
  }

  private tickProgram(): void {
    const view = this.program;
    if (!view || !this.assets) return;
    const keep = this.transition ? [this.transition.from] : [];
    void this.assets.tick(view, keep).catch(() => undefined);
  }

  setBrowserConfig(config: BrowserSourceConfig): void {
    this.browserConfig = { ...config };
    if (!config.visible) this.clearBrowserFrame();
  }

  /** Returns whether the frame was taken (false: hidden source or no DOM), so the caller can acknowledge it either way. */
  pushBrowserFrame(frame: BrowserSourceFrame): boolean {
    if (this.disposed || !this.browserConfig.visible || typeof document === "undefined") return false;
    (this.browser ??= new FrameCanvas()).put(frame);
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
    this.timer = setInterval(() => this.drawFrame(), Math.round(1000 / this.fps));
  }

  dispose(): void {
    this.disposed = true;
    this.setRunning(false);
    this.clearBrowserFrame();
    this.browser?.release();
    this.browser = null;
    // The programme state stays (the next capture composes it again); its pictures are fetched again when needed.
    if (this.programTimer !== null) clearInterval(this.programTimer);
    this.programTimer = null;
    this.assets?.dispose();
    this.assets = null;
    this.overlays = null;
    this.overlaysDirty = true;
    this.fallbacks.clear();
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
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;

    const captured = canvas.captureStream(this.fps);
    this.canvas = canvas;
    this.ctx = ctx;
    this.baseVideo = video;
    this.outputStream = new MediaStream(captured.getVideoTracks());
    this.programChanged();
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
      this.overlaysDirty = true;
    }

    const cw = canvas.width;
    const ch = canvas.height;
    const view = this.program;
    const local = view !== null && localCompositing(view, this.composesLocally) && this.assets !== null;

    // Scene layers: the incoming (current) scene, and the outgoing one while a transition runs.
    let sceneOut: SceneKind | null = null;
    let outFrame: LayerFrame | null = null;
    let inFrame: LayerFrame = this.steady;
    const tr = this.transition;
    if (local && tr) {
      const now = performance.now();
      if (tr.startedAt === null && (this.assets!.settled(view.scene) || now - tr.waitSince > TRANSITION_WAIT_MS)) tr.startedAt = now;
      sceneOut = tr.fromKind;
      if (tr.startedAt === null) {
        // Waiting for the incoming picture: the previous scene stays as it was.
        outFrame = this.steady;
        inFrame = this.tf.in;
        inFrame.visible = false;
      } else {
        const f = transitionFrame(tr.fromKind, view.sceneKind, (now - tr.startedAt) / 1000, tr.mode, ch / 720, this.tf);
        outFrame = f.out;
        inFrame = f.in;
        if (f.done) {
          this.transition = null;
          sceneOut = null;
          outFrame = null;
          this.updateActive();
        }
      }
    }

    const browser = this.browserConfig.visible && this.hasBrowserFrame ? this.browser!.canvas : null;
    const incoming = local && view.sceneKind !== "camera" ? this.sceneImage(view.scene, view.sceneKind, cw, ch) : null;
    if (local && this.overlaysDirty && this.overlays) {
      this.overlaysDirty = false;
      const logo = this.assets!.logo();
      this.overlays.update(view.overlays, cw, ch, logo, logo ? "logo" + String(logo.width) : "", view.darkGreen, this.fontsEpoch);
    }
    const layers = layerOrder({
      local,
      browser: browser === null ? "none" : this.browserConfig.mode === "fullscreen" ? "fullscreen" : "overlay",
      sceneIn: local ? view.sceneKind : "camera",
      sceneOut,
      sceneInOpaque: incoming !== null && inFrame.visible && inFrame.alpha >= 1 && inFrame.dy === 0,
      overlays: Boolean(this.overlays && !this.overlays.isEmpty),
    });

    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, cw, ch);
    for (const layer of layers) {
      switch (layer) {
        case "camera":
          if (v && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0) ctx.drawImage(v, 0, 0, cw, ch);
          break;
        case "scene-out":
          if (tr && outFrame?.visible) this.drawLayer(ctx, this.sceneImage(tr.from, tr.fromKind, cw, ch, tr.fromLabel), outFrame, cw, ch);
          break;
        case "scene-in":
          if (inFrame.visible) this.drawLayer(ctx, incoming, inFrame, cw, ch);
          break;
        case "browser":
          this.drawBrowser(ctx, browser!, cw, ch);
          break;
        case "overlays":
          ctx.drawImage(this.overlays!.canvas, 0, 0, cw, ch);
          break;
      }
    }
  }

  private drawLayer(ctx: CanvasRenderingContext2D, img: CanvasImageSource | null, f: LayerFrame, cw: number, ch: number): void {
    if (!img || f.alpha <= 0) return;
    ctx.globalAlpha = Math.min(1, f.alpha);
    ctx.drawImage(img, f.dx, f.dy, cw, ch);
    ctx.globalAlpha = 1;
  }

  private drawBrowser(ctx: CanvasRenderingContext2D, browser: HTMLCanvasElement, cw: number, ch: number): void {
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

  /**
   * The picture of a scene: its template frame or the engine's picture (last valid one kept), else for a full screen
   * a plain card in the mosque green with the scene's name — never black, never the camera it is meant to hide.
   */
  private sceneImage(id: string, kind: SceneKind, cw: number, ch: number, label?: string): CanvasImageSource | null {
    const img = this.assets?.sceneSource(id) ?? null;
    if (img || kind !== "full") return img;
    const name = label ?? this.program?.scenes.find((s) => s.id === id)?.label ?? "";
    return this.fallbackCard(name, cw, ch);
  }

  private fallbackCard(label: string, cw: number, ch: number): HTMLCanvasElement {
    const key = `${label}|${cw}x${ch}|${this.program?.darkGreen ?? ""}`;
    const held = this.fallbacks.get(key);
    if (held) return held;
    if (this.fallbacks.size >= 4) this.fallbacks.clear();
    const c = document.createElement("canvas");
    c.width = cw;
    c.height = ch;
    const g = c.getContext("2d")!;
    const pal = palette(this.program?.darkGreen);
    const grad = g.createLinearGradient(0, 0, 0, ch);
    grad.addColorStop(0, `rgb(${pal.deepTop.join(",")})`);
    grad.addColorStop(1, `rgb(${pal.deep.join(",")})`);
    g.fillStyle = grad;
    g.fillRect(0, 0, cw, ch);
    if (label) {
      g.font = cssFont({ family: "serif", weight: 600, size: Math.round((62 * ch) / 720) });
      g.fillStyle = "rgb(244, 240, 230)";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(label, cw / 2, ch / 2, cw * 0.8);
    }
    this.fallbacks.set(key, c);
    return c;
  }
}

export interface CompositedSourceOptions {
  /** False where there is no DOM (tests, node): the raw stream always goes out. */
  canvasAvailable?: boolean;
  /** Mix of the microphone with the sound of the screen and of the web page; absent: the microphone alone goes out. */
  audioMix?: OutputAudioMix;
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
  private acquiring = false;
  private mixed: { key: string; stream: MediaStream } | null = null;
  private readonly audioMix: OutputAudioMix | null;
  private readonly changeListeners = new Set<(s: MediaStream) => void>();
  private readonly canvasAvailable: boolean;
  private demand: CompositorDemand = { browserVisible: false, screenActive: false };

  constructor(
    private readonly inner: MediaSourceStrategy,
    readonly compositor: OutputCompositor,
    opts: CompositedSourceOptions = {},
  ) {
    this.canvasAvailable = opts.canvasAvailable ?? typeof document !== "undefined";
    this.audioMix = opts.audioMix ?? null;
    // A source's sound becomes audible or silent: the audio sender swaps between the microphone and the mix.
    this.audioMix?.onActiveChange(() => !this.acquiring && this.announce());
    // Scenes and overlays switch the output too: a logo shown, a full screen taken, a fade back to the camera ended.
    this.compositor.onProgramActiveChange?.(() => this.apply());
  }

  /** The source's own stream (camera, IP camera or screen with the microphone), before the canvas and the mix. */
  get rawStream(): MediaStream | null {
    return this.raw;
  }

  get outputMode(): OutputMode {
    return this.mode;
  }

  /** The browser/screen demand changed: switch between the raw stream and the canvas without releasing the source. */
  setDemand(d: CompositorDemand): void {
    this.demand = { ...d };
    this.apply();
  }

  /**
   * Raw stream or canvas, from the web source / screen demand and the programme. A switch only swaps the track the
   * senders carry (`onStreamChange` → `replaceTrack`): the WHIP connection is never renegotiated nor cut.
   */
  private apply(): void {
    const program = this.compositor.programActive?.() ?? false;
    const next = this.canvasAvailable ? chooseOutput({ ...this.demand, program }) : "raw";
    if (next === this.mode) return;
    this.mode = next;
    if (next === "canvas") this.engageCanvas();
    else this.compositor.setRunning(false);
    this.announce();
  }

  async acquire(options: SourceOptions): Promise<MediaStream> {
    const raw = await this.inner.acquire(options);
    this.raw = raw;
    this.acquiring = true;
    try {
      this.audioMix?.setMic(raw);
      this.audioMix?.setInput("screen", this.inner.systemAudio?.() ?? null);
    } finally {
      this.acquiring = false;
    }
    if (this.mode === "canvas") this.engageCanvas();
    const out = this.output(raw);
    this.lastKey = streamKey(out);
    return out;
  }

  release(): void {
    this.inner.release();
    this.audioMix?.setInput("screen", null);
    this.audioMix?.setMic(null);
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
    const canvas = this.mode === "canvas" && this.canvasAvailable;
    const mix = this.audioMix;
    const mixTrack = mix?.active ? mix.track : null;
    if (!mixTrack || typeof MediaStream !== "function") return canvas ? this.compositor.compose([raw]) : raw;
    // The mixed sound replaces the microphone track; the picture is the canvas or the source's own.
    const video = (canvas ? this.compositor.compose([raw]) : raw).getVideoTracks();
    const key = [...video, mixTrack].map((t) => t.id).join("|");
    if (this.mixed?.key !== key) this.mixed = { key, stream: new MediaStream([...video, mixTrack]) };
    return this.mixed.stream;
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
