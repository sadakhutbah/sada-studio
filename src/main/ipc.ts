import { app, BrowserWindow, ipcMain, powerSaveBlocker } from "electron";
import { appendFileSync } from "node:fs";
import { hostname } from "node:os";
import { ensureMediaAccess, openMediaSettings } from "./media-access";
import { SadaHttpApi } from "../core/api/sada-api";
import type { StreamMeta } from "../core/api/types";
import { t } from "../core/messages";
import { ApiError } from "../core/errors";
import { KioskSupervisor, type ClientReport } from "../core/kiosk/supervisor";
import type { UpdateGate } from "../core/kiosk/update-gate";
import type { IpcResult, KioskSnapshot } from "../shared/ipc";
import { FileAudioOffsetStore, FileCaptureSettingsStore } from "./capture-files";
import { CaptureService } from "./capture-service";
import { FilePersistStore, SafeDeviceStore } from "./device-store";
import { resolveFfmpeg } from "./ffmpeg-io";
import { log } from "./log";
import { startUpdater } from "./updater";
import { collectWindowsFacts } from "./windows-facts";

async function run<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.status, message: e.message };
    return { ok: false, status: 0, message: e instanceof Error ? e.message : String(e) };
  }
}

const isMeta = (m: unknown): m is StreamMeta =>
  !!m && typeof m === "object" && ((m as StreamMeta).type === "khutba" || (m as StreamMeta).type === "dars" || (m as StreamMeta).type === "conference") && typeof (m as StreamMeta).title === "string";

const isReport = (r: unknown): r is ClientReport =>
  !!r && typeof r === "object" && typeof (r as ClientReport).sessionState === "string" && typeof (r as ClientReport).camera === "boolean" && Array.isArray((r as ClientReport).checks);

export interface Kiosk {
  supervisor: KioskSupervisor;
  capture: CaptureService;
  snapshot(): KioskSnapshot;
}

/**
 * Composition root: Sada client, vault, supervisor, updates. The client and the device secret
 * live here, in the main process; the UI only receives `KioskSnapshot`.
 */
export function registerIpc(version: string): Kiosk {
  const api = new SadaHttpApi();
  const supervisor = new KioskSupervisor(api, new SafeDeviceStore(), new FilePersistStore(), { version, machineName: hostname() });
  let gate: UpdateGate | null = null;
  let displayBlocker: number | null = null;

  const snapshot = (): KioskSnapshot => ({ ...supervisor.view, update: gate?.status ?? null });
  const broadcast = () => {
    const s = snapshot();
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("kiosk:changed", s);
    // The screen stays on during arming and the live; the system never suspends while the application runs.
    const need = s.phase === "onair" || s.phase === "armed";
    if (need && displayBlocker === null) displayBlocker = powerSaveBlocker.start("prevent-display-sleep");
    if (!need && displayBlocker !== null) {
      powerSaveBlocker.stop(displayBlocker);
      displayBlocker = null;
    }
  };
  supervisor.subscribe(broadcast);
  powerSaveBlocker.start("prevent-app-suspension");

  // "IP camera + local microphone" source: ffmpeg lives here, the UI only gets the state and the media.
  const userData = app.getPath("userData");
  const sendAll = (channel: string, payload: unknown) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
  };
  let lastAlert = false;
  let dumpIndex = 0;
  const capture = new CaptureService({
    settings: new FileCaptureSettingsStore(userData),
    offsets: new FileAudioOffsetStore(userData),
    ffmpegPath: resolveFfmpeg(app.isPackaged ? process.resourcesPath : null),
    audioBackend: process.env.SADA_STUDIO_AUDIO_BACKEND === "pcm" ? "pcm" : undefined,
    onView: (v) => {
      sendAll("capture:changed", v);
      // An outage starts or ends: the operators are told by the next heartbeat, brought forward.
      if (v.alert !== lastAlert) {
        lastAlert = v.alert;
        supervisor.refreshChecks();
      }
    },
    onMedia: (m) => {
      sendAll("capture:media", m);
      // Testing only (application not installed): one file per capture run, to measure the A/V alignment offline.
      if (!app.isPackaged && process.env.SADA_STUDIO_DUMP) {
        if (m.init) dumpIndex++;
        appendFileSync(`${process.env.SADA_STUDIO_DUMP}.${dumpIndex}.mp4`, m.data);
      }
    },
    log,
  });
  supervisor.setCheckProvider(() => capture.healthChecks());
  void capture.init();

  gate = startUpdater(
    () => {
      const v = supervisor.view;
      return {
        sessionActive: ["connecting", "live", "reconnecting"].includes(v.reportedState),
        wantLive: v.wantLive,
        nextSlotAt: v.nextSlot?.startsAt ?? null,
        slotRunning: v.current !== null,
      };
    },
    log,
  );
  gate?.subscribe(broadcast);

  ipcMain.handle("media:access", () => ensureMediaAccess());
  ipcMain.handle("media:open-settings", (_e, kind: unknown) => openMediaSettings(kind === "camera" ? "camera" : "microphone"));
  ipcMain.handle("capture:get", () => capture.view);
  ipcMain.handle("capture:set-settings", (_e, s: unknown) => run(async () => capture.setSettings(s)));
  ipcMain.handle("capture:acquire", () => run(async () => (await capture.acquire(), null)));
  ipcMain.handle("capture:release", () => run(async () => (await capture.release(), null)));
  ipcMain.handle("capture:devices", () => capture.refreshDevices());
  ipcMain.handle("capture:set-delay", (_e, ms: unknown) => run(async () => capture.setDelay(Number(ms))));
  ipcMain.handle("capture:calibrate", () => run(() => capture.calibrate()));

  ipcMain.handle("kiosk:get", () => snapshot());
  ipcMain.handle("kiosk:start-pairing", (_e, baseUrl: unknown) =>
    run(async () => (await supervisor.startPairing(String(baseUrl ?? "")), null)),
  );
  ipcMain.handle("kiosk:cancel-pairing", () => run(async () => (supervisor.cancelPairing(), null)));
  ipcMain.handle("kiosk:unpair", () => run(async () => (await supervisor.unpair(), null)));
  ipcMain.handle("kiosk:start-manual", (_e, meta: unknown) =>
    run(async () => {
      if (!isMeta(meta)) throw new ApiError(0, t("ipc.invalidLive"));
      await supervisor.startManual(meta);
      return null;
    }),
  );
  ipcMain.handle("kiosk:stop-live", () => run(async () => (await supervisor.stopLive(), null)));
  ipcMain.handle("kiosk:dismiss-conflict", () => supervisor.dismissConflict());
  ipcMain.on("kiosk:report", (_e, r: unknown) => isReport(r) && supervisor.setReport(r));
  ipcMain.handle("kiosk:windows-facts", () => collectWindowsFacts());
  ipcMain.handle("studio:whip-offer", (_e, sdp: string) => run(() => api.whip.offer(sdp)));
  ipcMain.handle("studio:whip-patch", (_e, resource: string, fragment: string) =>
    run(async () => (await api.whip.patchIce(resource, fragment), null)),
  );
  ipcMain.handle("studio:whip-close", (_e, resource: string) => run(async () => (await api.whip.close(resource), null)));

  supervisor.boot();
  return { supervisor, capture, snapshot };
}
