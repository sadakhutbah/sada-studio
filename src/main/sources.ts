import { BrowserWindow, desktopCapturer, ipcMain, session, webContents, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { ApiError } from "../core/errors";
import { t } from "../core/messages";
import { screenAudioSupport } from "../core/sources/screen-audio";
import type { DesktopSourceInfo } from "../core/sources/types";
import type { IpcResult } from "../shared/ipc";
import { BrowserSourceService } from "./browser-source";
import { isDesktopSourceId, parseBrowserSourceUrl } from "./ipc-guards";
import { openMediaSettings, screenAccessStatus } from "./media-access";

const THUMBNAIL = { width: 240, height: 135 };
const MAX_SOURCES = 60;

async function run<T>(fn: () => Promise<T> | T): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.status, message: e.message, ...(e.code ? { code: e.code } : {}) };
    return { ok: false, status: 0, message: e instanceof Error ? e.message : String(e) };
  }
}

/** macOS: refuse before asking when the user already said no (asking again never re-prompts). */
function requireScreenAccess(): void {
  const s = screenAccessStatus();
  if (s === "denied" || s === "restricted") throw new ApiError(0, t("screen.denied"), "screen_denied");
}

/**
 * Local sources of the Régie: the hidden web page and the screen / window share. Only the application window may use
 * these channels (the projector window loads the same preload but has no business here). The page's frames go to that
 * window alone, never broadcast to every window.
 */
export function registerSources(getMain: () => BrowserWindow | null): { dispose(): void } {
  const browser = new BrowserSourceService();
  let selected: string | null = null;

  const mainContents = () => {
    const w = getMain();
    return w && !w.isDestroyed() ? w.webContents : null;
  };
  const fromMain = (e: IpcMainInvokeEvent | IpcMainEvent) => mainContents() !== null && e.sender === mainContents();
  const handle = <T>(channel: string, fn: (e: IpcMainInvokeEvent, ...args: unknown[]) => Promise<T> | T) =>
    ipcMain.handle(channel, (e, ...args) => run(() => {
      if (!fromMain(e)) throw new ApiError(0, t("ipc.invalidSource"));
      return fn(e, ...args);
    }));

  browser.onFrame((f) => mainContents()?.send("sources:browser-frame", f));
  browser.onStatus((s) => mainContents()?.send("sources:browser-status-changed", s));

  ipcMain.handle("sources:browser-status", (e) => (fromMain(e) ? browser.getStatus() : null));
  handle("sources:browser-start", (_e, url) => browser.start({ url: parseBrowserSourceUrl(url) }));
  handle("sources:browser-reload", () => browser.reload());
  handle("sources:browser-set-visible", (_e, visible) => browser.setVisible(Boolean(visible)));
  handle("sources:browser-stop", () => browser.stop());
  handle("sources:browser-audio-id", () => {
    const main = mainContents();
    return main ? browser.audioSourceId(main) : null;
  });
  ipcMain.on("sources:browser-frame-ack", (e) => {
    if (fromMain(e)) browser.ackFrame();
  });

  ipcMain.handle("sources:screen-access", (e) => (fromMain(e) ? screenAccessStatus() : "denied"));
  ipcMain.handle("sources:screen-open-settings", (e) => (fromMain(e) ? openMediaSettings("screen") : undefined));
  handle("sources:screen-audio-support", () => screenAudioSupport(process.platform));
  handle("sources:screen-list", async (): Promise<DesktopSourceInfo[]> => {
    requireScreenAccess();
    const found = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: THUMBNAIL, fetchWindowIcons: false });
    // The first call on macOS prompts: if the answer was no, say so rather than show an empty list.
    requireScreenAccess();
    return found
      .filter((s) => s.name.trim() !== "")
      .slice(0, MAX_SOURCES)
      .map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.id.startsWith("screen:") ? "screen" : "window",
        thumbnailDataUrl: s.thumbnail.isEmpty() ? "" : `data:image/jpeg;base64,${s.thumbnail.toJPEG(70).toString("base64")}`,
      }));
  });
  handle("sources:screen-select", (_e, id) => {
    if (id !== null && !isDesktopSourceId(id)) throw new ApiError(0, t("ipc.invalidSource"));
    selected = id;
    return null;
  });

  // `getDisplayMedia` from the application window is answered with the source the operator chose in the UI, and only
  // that: no picker, no automatic choice of the whole screen. Without a choice, or without permission, it is refused.
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      void (async () => {
        try {
          const main = mainContents();
          const caller = request.frame ? webContents.fromFrame(request.frame) : null;
          const s = screenAccessStatus();
          if (!main || !caller || caller.id !== main.id || !selected || s === "denied" || s === "restricted") return callback({});
          const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } });
          const source = sources.find((x) => x.id === selected);
          // The sound of the share only where Electron can capture it (Windows loopback), and only when the page asked.
          const withSound = request.audioRequested && screenAudioSupport(process.platform).supported;
          callback(source ? { video: source, ...(withSound ? { audio: "loopback" as const } : {}) } : {});
        } catch {
          callback({});
        }
      })();
    },
    { useSystemPicker: false },
  );

  return {
    dispose: () => {
      browser.dispose();
    },
  };
}
