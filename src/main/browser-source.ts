import { BrowserWindow } from "electron";
import { validateBrowserSourceUrl } from "../core/sources/browser-source";
import type { BrowserSourceFrame, BrowserSourceStatus } from "../core/sources/types";

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_FPS = 15;

export interface BrowserSourceStartOptions {
  url: string;
  width?: number;
  height?: number;
  fps?: number;
}

/**
 * Renders an external web page locally inside a hidden offscreen Chromium window
 * and streams painted PNG frames to the renderer for live composition.
 */
export class BrowserSourceService {
  private win: BrowserWindow | null = null;
  private status: BrowserSourceStatus = { active: false, loading: false, url: "", error: null };
  private frameListeners = new Set<(frame: BrowserSourceFrame) => void>();
  private statusListeners = new Set<(status: BrowserSourceStatus) => void>();
  private lastEmitMs = 0;
  private minIntervalMs = Math.round(1000 / DEFAULT_FPS);

  getStatus(): BrowserSourceStatus {
    return { ...this.status };
  }

  onFrame(cb: (frame: BrowserSourceFrame) => void): () => void {
    this.frameListeners.add(cb);
    return () => this.frameListeners.delete(cb);
  }

  onStatus(cb: (status: BrowserSourceStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  async start(opts: BrowserSourceStartOptions): Promise<BrowserSourceStatus> {
    const safeUrl = validateBrowserSourceUrl(opts.url);
    const width = Math.max(320, Math.min(1920, Math.round(opts.width ?? DEFAULT_WIDTH)));
    const height = Math.max(180, Math.min(1080, Math.round(opts.height ?? DEFAULT_HEIGHT)));
    const fps = Math.max(5, Math.min(30, Math.round(opts.fps ?? DEFAULT_FPS)));
    this.minIntervalMs = Math.round(1000 / fps);

    const win = this.ensureWindow(width, height, fps);
    this.setStatus({ active: true, loading: true, url: safeUrl, error: null });

    try {
      await win.loadURL(safeUrl);
      if (this.win === win && !win.isDestroyed()) {
        this.setStatus({ active: true, loading: false, url: safeUrl, error: null });
        this.captureOnce(win);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.setStatus({ active: true, loading: false, url: safeUrl, error: message });
    }
    return this.getStatus();
  }

  async reload(): Promise<BrowserSourceStatus> {
    if (!this.win || this.win.isDestroyed() || !this.status.url) {
      return this.getStatus();
    }
    this.setStatus({ ...this.status, loading: true, error: null });
    this.win.webContents.reloadIgnoringCache();
    return this.getStatus();
  }

  stop(): BrowserSourceStatus {
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    this.win = null;
    this.setStatus({ active: false, loading: false, url: this.status.url, error: null });
    return this.getStatus();
  }

  dispose(): void {
    this.stop();
    this.frameListeners.clear();
    this.statusListeners.clear();
  }

  private ensureWindow(width: number, height: number, fps: number): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) {
      this.win.setContentSize(width, height);
      this.win.webContents.setFrameRate(fps);
      return this.win;
    }

    const win = new BrowserWindow({
      show: false,
      width,
      height,
      transparent: true,
      frame: false,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });

    win.webContents.setAudioMuted(true);
    win.webContents.setFrameRate(fps);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, targetUrl) => {
      try {
        validateBrowserSourceUrl(targetUrl);
      } catch {
        event.preventDefault();
      }
    });

    win.webContents.on("did-finish-load", () => {
      if (this.win !== win) return;
      this.setStatus({ ...this.status, loading: false, error: null });
      this.captureOnce(win);
    });

    win.webContents.on("did-fail-load", (_e, code, description) => {
      if (this.win !== win || code === -3) return;
      this.setStatus({ ...this.status, loading: false, error: description || `Erreur chargement (${code})` });
    });

    win.webContents.on("paint", (_event, _dirty, image) => {
      if (this.win !== win || !this.status.active) return;
      const now = Date.now();
      if (now - this.lastEmitMs < this.minIntervalMs) return;
      this.lastEmitMs = now;
      const size = image.getSize();
      if (size.width <= 0 || size.height <= 0) return;
      const png = new Uint8Array(image.toPNG());
      this.emitFrame({ width: size.width, height: size.height, png });
    });

    win.on("closed", () => {
      if (this.win === win) this.win = null;
    });

    this.win = win;
    return win;
  }

  private captureOnce(win: BrowserWindow): void {
    void win.webContents
      .capturePage()
      .then((image) => {
        if (this.win !== win || !this.status.active) return;
        const size = image.getSize();
        if (size.width <= 0 || size.height <= 0) return;
        const png = new Uint8Array(image.toPNG());
        this.emitFrame({ width: size.width, height: size.height, png });
      })
      .catch(() => {
        /* window may have closed */
      });
  }

  private emitFrame(frame: BrowserSourceFrame): void {
    for (const cb of this.frameListeners) cb(frame);
  }

  private setStatus(next: BrowserSourceStatus): void {
    this.status = next;
    for (const cb of this.statusListeners) cb(this.getStatus());
  }
}
