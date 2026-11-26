import { BrowserWindow, type NativeImage, type Session } from "electron";
import { fitWithin } from "../core/sources/frame-gate";
import type { BrowserSourceFrame } from "../core/sources/types";

/**
 * Shared pieces of the hidden offscreen windows (the operator's web source and the mosque's screens): a session that
 * grants nothing, a locked-down window, and painted pictures turned into raw frames for the compositor.
 */

/** No permission is ever granted (camera, microphone, screen, notifications, geolocation, devices…). */
export function denyAllPermissions(ses: Session): void {
  ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, cb) => cb({}));
}

export interface OffscreenWindowOptions {
  partition: string;
  width: number;
  height: number;
  fps: number;
  /** Scripts of the page (the web source needs them; a mosque screen is a document, never a program). */
  javascript: boolean;
}

/** A hidden, sandboxed, muted offscreen window, without preload or bridge, that opens nothing. */
export function createOffscreenWindow(o: OffscreenWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width: o.width,
    height: o.height,
    useContentSize: true,
    transparent: true,
    frame: false,
    webPreferences: {
      partition: o.partition,
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      javascript: o.javascript,
      backgroundThrottling: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      // No preload: the page gets no bridge to the application.
    },
  });
  const wc = win.webContents;
  wc.setAudioMuted(true);
  wc.setFrameRate(o.fps);
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  return win;
}

/** Raw pixels, scaled down first when above the bounds: no PNG/JPEG encoding on the main process. Null when empty. */
export function nativeImageToFrame(image: NativeImage): BrowserSourceFrame | null {
  const size = image.getSize();
  if (size.width <= 0 || size.height <= 0) return null;
  const fit = fitWithin(size.width, size.height);
  const out = fit.width === size.width && fit.height === size.height ? image : image.resize({ width: fit.width, height: fit.height, quality: "good" });
  return { width: fit.width, height: fit.height, bgra: new Uint8Array(out.toBitmap()) };
}
