import { BrowserWindow, clipboard, globalShortcut, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { ApiError } from "../core/errors";
import { t } from "../core/messages";
import { isShortcutAction, type ControlRequest, type ControlResult, type ShortcutAction } from "../core/control/actions";
import { FALLBACK_SCENE_IDS, commandFor, pickScene } from "../core/control/scenes";
import { RendererLink } from "../core/control/renderer-link";
import { ControlService } from "../core/control/service";
import { isValidPort, parseShortcutChange, type ControlSettings, type ControlView } from "../core/control/settings";
import { ShortcutRegistry, type ShortcutStatus } from "../core/control/shortcuts";
import type { IpcResult } from "../shared/ipc";
import { ControlHttpHandler } from "./control-http";
import { ControlServer } from "./control-server";
import { ControlStore, newToken } from "./control-store";
import type { Kiosk } from "./ipc";
import { log } from "./log";

/**
 * Global shortcuts and the local control API (Stream Deck, Bitfocus Companion). Both end in the same `ControlService`:
 * the microphone, web source, screen share and scenes are run by the application window (one store with the Régie
 * panel); scenes fall back to the main process talking to the Sada server when the window cannot take them.
 * Only the application window may use the settings channels.
 */
export function registerControl(getMain: () => BrowserWindow | null, getKiosk: () => Kiosk | null, userData: string): { dispose(): void } {
  const store = new ControlStore(userData);
  let settings: ControlSettings = store.load();
  store.save(settings); // the token exists from the first launch
  let status = {} as Record<ShortcutAction, ShortcutStatus>;
  let apiError: string | null = null;

  const mainContents = () => {
    const w = getMain();
    return w && !w.isDestroyed() ? w.webContents : null;
  };
  const fromMain = (e: IpcMainInvokeEvent | IpcMainEvent) => mainContents() !== null && e.sender === mainContents();

  const link = new RendererLink((id, request) => {
    const wc = mainContents();
    if (!wc) return false;
    wc.send("control:request", id, request);
    return true;
  });

  const scenes = async (request: ControlRequest): Promise<ControlResult> => {
    const api = getKiosk()?.api;
    if (!api) return { ok: false, code: "ui_unavailable", message: t("control.uiUnavailable") };
    const [regie, live] = await Promise.all([api.getRegie(), api.getLiveStatus()]);
    const ids = regie.scenes && regie.scenes.length > 0 ? regie.scenes.map((s) => s.id) : [...FALLBACK_SCENE_IDS];
    let target: string | null;
    if (request.action === "scene.set") {
      target = request.scene && ids.includes(request.scene) ? request.scene : null;
      if (!target) return { ok: false, code: "unknown_scene", message: t("control.unknownScene", { scene: request.scene ?? "" }) };
    } else {
      const direction = request.action === "scene.next" ? "next" : "previous";
      target = pickScene(ids, live.scene, direction);
      if (!target) return { ok: false, code: "no_scene", message: t(direction === "next" ? "control.noNextScene" : "control.noPreviousScene") };
    }
    const c = commandFor(target);
    const after = await api.sendLiveCommand(c.command, c.arg);
    return { ok: true, state: { scene: after.scene ?? target } };
  };

  // Scenes go through the window first: its store shows the change at once, like a click in the Régie panel. Without a
  // loaded Régie there, the main process takes the scene by itself.
  const sceneViaWindow = async (request: ControlRequest): Promise<ControlResult> => {
    const r = await link.request(request);
    return r.code === "ui_unavailable" ? scenes(request) : r;
  };
  const service = new ControlService({ window: (r) => link.request(r), scene: sceneViaWindow });
  const run = (request: ControlRequest) => service.execute(request).then((r) => (r.ok ? r : (log(`Control ${request.action}: ${r.message ?? r.code ?? "failed"}`), r)));

  const shortcuts = new ShortcutRegistry(
    { register: (a, cb) => globalShortcut.register(a, cb), unregister: (a) => globalShortcut.unregister(a) },
    (action) => void run({ action }),
  );
  const applyShortcuts = () => {
    status = shortcuts.apply(settings.shortcuts);
  };

  const server = new ControlServer(
    (port) => new ControlHttpHandler({ token: () => settings.api.token, port, execute: run }),
  );
  const applyApi = async () => {
    await server.stop();
    apiError = null;
    if (!settings.api.enabled) return;
    try {
      await server.start(settings.api.port);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      apiError = code === "EADDRINUSE" ? t("control.apiPortBusy", { port: settings.api.port }) : t("control.apiFailed", { detail: code ?? (e instanceof Error ? e.message : String(e)) });
      log(`Local API: ${apiError}`);
    }
  };

  const view = (): ControlView => ({
    shortcuts: (Object.keys(settings.shortcuts) as ShortcutAction[]).map((action) => ({ action, accelerator: settings.shortcuts[action], status: status[action] ?? "disabled" })),
    api: { enabled: settings.api.enabled, port: settings.api.port, token: settings.api.token, running: server.listening, error: apiError, baseUrl: `http://127.0.0.1:${settings.api.port}` },
  });
  const save = () => store.save(settings);

  const handle = <T>(channel: string, fn: (...args: unknown[]) => Promise<T> | T) =>
    ipcMain.handle(channel, async (e, ...args): Promise<IpcResult<T>> => {
      try {
        if (!fromMain(e)) throw new ApiError(0, t("ipc.invalidSource"));
        return { ok: true, value: await fn(...args) };
      } catch (err) {
        return { ok: false, status: 0, message: err instanceof Error ? err.message : String(err) };
      }
    });

  handle("control:get", () => view());
  handle("control:set-shortcut", (action, accelerator) => {
    const change = parseShortcutChange(action, accelerator);
    if (!change || !isShortcutAction(change.action)) throw new Error(t("control.invalidChange"));
    settings = { ...settings, shortcuts: { ...settings.shortcuts, [change.action]: change.accelerator } };
    save();
    applyShortcuts();
    return view();
  });
  handle("control:set-api", async (enabled, port) => {
    if (typeof enabled !== "boolean" || !isValidPort(port)) throw new Error(t("control.invalidChange"));
    settings = { ...settings, api: { ...settings.api, enabled, port } };
    save();
    await applyApi();
    return view();
  });
  handle("control:regenerate-token", () => {
    // The old token stops working at once, also for a running server: it reads the current settings on each request.
    settings = { ...settings, api: { ...settings.api, token: newToken() } };
    save();
    return view();
  });
  handle("control:copy-token", () => {
    clipboard.writeText(settings.api.token);
    return null;
  });
  ipcMain.on("control:response", (e, id: unknown, result: unknown) => {
    if (fromMain(e)) link.resolve(id, result);
  });

  applyShortcuts();
  void applyApi();

  return {
    dispose: () => {
      shortcuts.dispose();
      void server.stop();
    },
  };
}
