import { session, type BrowserWindow, type Session } from "electron";
import { COUNTDOWN_ATTR, escapeHtml } from "../core/program/screen-fill";
import type { BrowserSourceFrame } from "../core/sources/types";
import { createOffscreenWindow, denyAllPermissions, nativeImageToFrame } from "./offscreen";

/**
 * Renders the mosque's screens (HTML pages of the imported template) in a hidden offscreen window of its own — never
 * the operator's web source window — and hands back raw frames for the compositor.
 *
 * The page is a document, never a program:
 * - `javascript: false` in the window's preferences and `Emulation.setScriptExecutionDisabled` on top of it: no script
 *   context runs in the page at all (no isolated world either, no preload, no bridge);
 * - its own non-persistent partition, every request refused but `data:` (the fonts are inlined) and every permission
 *   denied; navigation and new windows refused;
 * - the page is set with `Page.setDocumentContent` through the DevTools protocol (no URL length limit, no navigation);
 * - the countdown is updated in place each second by the main process, through native DOM commands of the same
 *   protocol (`DOM.setOuterHTML` on the marked elements), so the page needs no script and is not reloaded each second.
 *   The protocol is attached by this process to this window only; the page cannot reach it.
 */

export const SCREEN_RENDER_PARTITION = "sada-screens";
const WIDTH = 1280;
const HEIGHT = 720;
const RENDER_TIMEOUT_MS = 5_000;
/** The page is considered laid out once nothing has been painted for this long (fonts decoded, layout settled). */
const SETTLE_QUIET_MS = 120;
const SETTLE_MAX_MS = 2_000;

/** Only inline resources: `data:` (fonts, pictures embedded by the server) and the blank page the window starts on. */
export function isAllowedScreenRequest(url: string): boolean {
  return url.startsWith("data:") || url === "about:blank";
}

export function lockDownScreenSession(ses: Session): void {
  denyAllPermissions(ses);
  ses.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !isAllowedScreenRequest(details.url) }));
}

export interface ScreenRenderRequest {
  /** Identity of the filled page without its countdown: the same key is not set again, only its countdown updated. */
  key: string;
  html: string;
  transparent: boolean;
  /** Countdown text for the marked elements (`data-sada-decompte`), null when the page has none. */
  countdown: string | null;
}

type Cdp = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;

interface Ready {
  win: BrowserWindow;
  cdp: Cdp;
  frameId: string;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("screen rendering timed out")), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });
}

export class ScreenRenderService {
  private ready: Promise<Ready> | null = null;
  private loaded: { key: string; transparent: boolean; countdown: string | null } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private locked = false;
  private readonly paintWaiters = new Set<() => void>();

  /** One render at a time, in order; a failed or stuck render closes the window (a fresh one is opened next time). */
  render(req: ScreenRenderRequest): Promise<BrowserSourceFrame> {
    const job = this.queue.then(() => withTimeout(this.renderNow(req), RENDER_TIMEOUT_MS));
    this.queue = job.catch(() => this.reset());
    return job;
  }

  dispose(): void {
    this.reset();
    this.paintWaiters.clear();
  }

  private reset(): void {
    const ready = this.ready;
    this.ready = null;
    this.loaded = null;
    void ready?.then(({ win }) => !win.isDestroyed() && win.destroy()).catch(() => undefined);
    const ses = session.fromPartition(SCREEN_RENDER_PARTITION);
    void ses.clearStorageData().catch(() => undefined);
    void ses.clearCache().catch(() => undefined);
  }

  private ensure(): Promise<Ready> {
    this.ready ??= this.open().catch((e) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }

  private async open(): Promise<Ready> {
    const ses = session.fromPartition(SCREEN_RENDER_PARTITION);
    if (!this.locked) {
      lockDownScreenSession(ses);
      this.locked = true;
    }
    const win = createOffscreenWindow({ partition: SCREEN_RENDER_PARTITION, width: WIDTH, height: HEIGHT, fps: 30, javascript: false });
    const wc = win.webContents;
    const refuse = (e: { preventDefault(): void }) => e.preventDefault();
    wc.on("will-navigate", refuse);
    wc.on("will-redirect", refuse);
    wc.on("will-frame-navigate", refuse);
    wc.on("paint", () => {
      for (const w of this.paintWaiters) w();
    });
    win.on("closed", () => {
      if (this.ready) void this.ready.then((r) => r.win === win && this.reset()).catch(() => undefined);
    });
    await win.loadURL("about:blank");
    wc.debugger.attach("1.3");
    const cdp: Cdp = (method, params) => wc.debugger.sendCommand(method, params) as Promise<Record<string, unknown>>;
    await cdp("Emulation.setScriptExecutionDisabled", { value: true });
    await cdp("Page.enable");
    const tree = (await cdp("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
    return { win, cdp, frameId: tree.frameTree.frame.id };
  }

  private async renderNow(req: ScreenRenderRequest): Promise<BrowserSourceFrame> {
    const { win, cdp, frameId } = await this.ensure();
    const l = this.loaded;
    if (!l || l.key !== req.key || l.transparent !== req.transparent) {
      this.loaded = null;
      // Same as the engine: a transparent page for a banner over the camera, a white default otherwise.
      await cdp("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: req.transparent ? 0 : 1 } });
      const settled = this.settle(SETTLE_MAX_MS);
      await cdp("Page.setDocumentContent", { frameId, html: req.html });
      await settled;
      this.loaded = { key: req.key, transparent: req.transparent, countdown: null };
    }
    if (req.countdown !== null && this.loaded?.countdown !== req.countdown) {
      const { root } = (await cdp("DOM.getDocument", { depth: 0 })) as { root: { nodeId: number } };
      const { nodeIds } = (await cdp("DOM.querySelectorAll", { nodeId: root.nodeId, selector: `[${COUNTDOWN_ATTR}]` })) as { nodeIds: number[] };
      if (nodeIds.length > 0) {
        const settled = this.settle(500);
        const outerHTML = `<span ${COUNTDOWN_ATTR}>${escapeHtml(req.countdown)}</span>`;
        for (const nodeId of nodeIds) await cdp("DOM.setOuterHTML", { nodeId, outerHTML });
        await settled;
      }
      if (this.loaded) this.loaded.countdown = req.countdown;
    }
    if (win.isDestroyed()) throw new Error("screen window closed");
    const frame = nativeImageToFrame(await win.webContents.capturePage());
    if (!frame) throw new Error("empty screen picture");
    return frame;
  }

  /** Resolves once painting has been quiet for a moment (or nothing was painted), at most after `maxMs`. */
  private settle(maxMs: number): Promise<void> {
    return new Promise((resolve) => {
      let quiet: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(quiet);
        clearTimeout(max);
        this.paintWaiters.delete(onPaint);
        resolve();
      };
      const onPaint = () => {
        clearTimeout(quiet);
        quiet = setTimeout(done, SETTLE_QUIET_MS);
      };
      const max = setTimeout(done, maxMs);
      // Nothing repainted at all (an identical page): do not wait for the maximum.
      quiet = setTimeout(done, SETTLE_QUIET_MS * 3);
      this.paintWaiters.add(onPaint);
    });
  }
}
