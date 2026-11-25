import { BrowserWindow, session, type Session } from "electron";
import { lookup } from "node:dns/promises";
import { isAllowedBrowserRequest, isPrivateOrLocalHost, validateBrowserSourceUrl } from "../core/sources/browser-source";
import { FrameGate, DEFAULT_FRAME_FPS, MAX_FRAME_FPS, fitWithin } from "../core/sources/frame-gate";
import { t } from "../core/messages";
import type { BrowserSourceFrame, BrowserSourceStatus } from "../core/sources/types";

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
/** Non-persistent (no `persist:` prefix): cookies, cache and storage live in memory and are dropped on stop. */
export const BROWSER_SOURCE_PARTITION = "browser-source";
const DNS_CACHE_MS = 60_000;

export interface BrowserSourceStartOptions {
  url: string;
  width?: number;
  height?: number;
  fps?: number;
}

const IDLE: BrowserSourceStatus = { active: false, loading: false, visible: false, url: "", error: null };

/**
 * Locks the session of the web source down: no permission is ever granted (camera, microphone, screen, notifications,
 * geolocation, devices...), and every request is checked against the public-host rule, redirects included.
 * `resolve` lets tests replace DNS.
 */
export function lockDownBrowserSession(ses: Session, resolve: (host: string) => Promise<string[]> = defaultResolve): void {
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, cb) => cb({}));
  const verdicts = new Map<string, { ok: boolean; at: number }>();
  ses.webRequest.onBeforeRequest(async (details, cb) => {
    if (!isAllowedBrowserRequest(details.url)) return cb({ cancel: true });
    let host = "";
    try {
      const u = new URL(details.url);
      if (!/^(https?|wss?):$/.test(u.protocol)) return cb({});
      host = u.hostname;
    } catch {
      return cb({ cancel: true });
    }
    // A public name that resolves to a private address (DNS rebinding of the lookup we can see) is refused too.
    const now = Date.now();
    const known = verdicts.get(host);
    if (known && now - known.at < DNS_CACHE_MS) return cb({ cancel: !known.ok });
    let ok = false;
    try {
      ok = (await resolve(host)).every((a) => !isPrivateOrLocalHost(a));
    } catch {
      ok = false;
    }
    verdicts.set(host, { ok, at: now });
    cb({ cancel: !ok });
  });
}

async function defaultResolve(host: string): Promise<string[]> {
  if (/^[\d.]+$/.test(host) || host.includes(":")) return [host]; // already an IP literal
  return (await lookup(host, { all: true })).map((r) => r.address);
}

/**
 * Renders an external web page locally inside a hidden offscreen Chromium window and streams its painted frames
 * (raw BGRA, at most 15 per second, bounded size, one in flight) to the renderer for live composition.
 */
export class BrowserSourceService {
  private win: BrowserWindow | null = null;
  private status: BrowserSourceStatus = { ...IDLE };
  private frameListeners = new Set<(frame: BrowserSourceFrame) => void>();
  private statusListeners = new Set<(status: BrowserSourceStatus) => void>();
  private readonly gate = new FrameGate(DEFAULT_FRAME_FPS);
  private locked = false;

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

  /** The UI consumed the last frame: the next paint may be sent. */
  ackFrame(): void {
    this.gate.ack();
  }

  async start(opts: BrowserSourceStartOptions): Promise<BrowserSourceStatus> {
    const safeUrl = validateBrowserSourceUrl(opts.url);
    const width = Math.max(320, Math.min(1920, Math.round(opts.width ?? DEFAULT_WIDTH)));
    const height = Math.max(180, Math.min(1080, Math.round(opts.height ?? DEFAULT_HEIGHT)));
    const fps = Math.max(5, Math.min(MAX_FRAME_FPS, Math.round(opts.fps ?? DEFAULT_FRAME_FPS)));
    this.gate.setFps(fps);
    this.gate.reset();

    const win = this.ensureWindow(width, height, fps);
    this.setStatus({ active: true, loading: true, visible: true, url: safeUrl, error: null });
    win.webContents.startPainting();

    try {
      await win.loadURL(safeUrl);
      if (this.win === win && !win.isDestroyed()) {
        this.setStatus({ ...this.status, loading: false, error: null });
        this.captureOnce(win);
      }
    } catch (e) {
      if (this.win === win) {
        const message = e instanceof Error ? e.message : String(e);
        this.setStatus({ ...this.status, loading: false, error: t("browser.loadFailed", { detail: message }) });
      }
    }
    return this.getStatus();
  }

  reload(): BrowserSourceStatus {
    if (!this.win || this.win.isDestroyed() || !this.status.url) return this.getStatus();
    this.setStatus({ ...this.status, loading: true, error: null });
    this.win.webContents.reloadIgnoringCache();
    return this.getStatus();
  }

  /** Hidden: the page stops painting (no frames, no CPU); shown: it paints again, starting with a fresh frame. */
  setVisible(visible: boolean): BrowserSourceStatus {
    const win = this.win;
    if (!win || win.isDestroyed()) return this.getStatus();
    if (visible) {
      this.gate.reset();
      win.webContents.startPainting();
      this.captureOnce(win);
    } else {
      win.webContents.stopPainting();
    }
    this.setStatus({ ...this.status, visible });
    return this.getStatus();
  }

  stop(): BrowserSourceStatus {
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) win.destroy();
    // Nothing the page stored survives its removal.
    const ses = session.fromPartition(BROWSER_SOURCE_PARTITION);
    void ses.clearStorageData().catch(() => undefined);
    void ses.clearCache().catch(() => undefined);
    this.gate.reset();
    this.setStatus({ ...IDLE, url: this.status.url });
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

    const ses = session.fromPartition(BROWSER_SOURCE_PARTITION);
    if (!this.locked) {
      lockDownBrowserSession(ses);
      this.locked = true;
    }

    const win = new BrowserWindow({
      show: false,
      width,
      height,
      transparent: true,
      frame: false,
      webPreferences: {
        partition: BROWSER_SOURCE_PARTITION,
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        backgroundThrottling: false,
        // No preload: the external page gets no bridge to the application.
      },
    });

    const wc = win.webContents;
    wc.setAudioMuted(true);
    wc.setFrameRate(fps);
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    // Every navigation, redirects and frames included, must stay on public http(s) hosts.
    const guard = (event: { preventDefault(): void }, targetUrl: string) => {
      try {
        validateBrowserSourceUrl(targetUrl);
      } catch {
        event.preventDefault();
      }
    };
    wc.on("will-navigate", guard);
    wc.on("will-redirect", guard);
    wc.on("will-frame-navigate", (details) => guard(details, details.url));

    wc.on("did-finish-load", () => {
      if (this.win !== win) return;
      this.setStatus({ ...this.status, loading: false, error: null });
      if (this.status.visible) this.captureOnce(win);
    });

    wc.on("did-fail-load", (_e, code, description, _url, isMainFrame) => {
      // A sub-frame or an aborted load (-3) is not a failure of the page.
      if (!isMainFrame || this.win !== win || code === -3) return;
      this.setStatus({ ...this.status, loading: false, error: t("browser.loadFailed", { detail: description || String(code) }) });
    });

    wc.on("paint", (_event, _dirty, image) => {
      if (this.win !== win || !this.status.active || !this.status.visible) return;
      if (!this.gate.tryBegin(Date.now())) return;
      this.emitImage(image);
    });

    win.on("closed", () => {
      if (this.win === win) {
        this.win = null;
        this.setStatus({ ...IDLE, url: this.status.url });
      }
    });

    this.win = win;
    return win;
  }

  private captureOnce(win: BrowserWindow): void {
    void win.webContents
      .capturePage()
      .then((image) => {
        if (this.win !== win || !this.status.active || !this.status.visible) return;
        if (this.gate.tryBegin(Date.now())) this.emitImage(image);
      })
      .catch(() => {
        /* window may have closed */
      });
  }

  /** Raw pixels, scaled down first when above the bounds: no PNG/JPEG encoding on the main process. */
  private emitImage(image: Electron.NativeImage): void {
    const size = image.getSize();
    if (size.width <= 0 || size.height <= 0) {
      this.gate.ack();
      return;
    }
    const fit = fitWithin(size.width, size.height);
    const out = fit.width === size.width && fit.height === size.height ? image : image.resize({ width: fit.width, height: fit.height, quality: "good" });
    this.emitFrame({ width: fit.width, height: fit.height, bgra: new Uint8Array(out.toBitmap()) });
  }

  private emitFrame(frame: BrowserSourceFrame): void {
    for (const cb of this.frameListeners) cb(frame);
  }

  private setStatus(next: BrowserSourceStatus): void {
    this.status = next;
    for (const cb of this.statusListeners) cb(this.getStatus());
  }
}
