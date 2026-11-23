import { contextBridge, ipcRenderer } from "electron";
import type { CaptureView } from "../core/capture/settings";
import type { CaptureMedia, KioskSnapshot, StudioBridge } from "../shared/ipc";

const bridge: StudioBridge = {
  capture: {
    get: () => ipcRenderer.invoke("capture:get"),
    onChange: (cb) => {
      const listener = (_e: unknown, v: CaptureView) => cb(v);
      ipcRenderer.on("capture:changed", listener);
      return () => void ipcRenderer.removeListener("capture:changed", listener);
    },
    onMedia: (cb) => {
      const listener = (_e: unknown, m: CaptureMedia) => cb(m);
      ipcRenderer.on("capture:media", listener);
      return () => void ipcRenderer.removeListener("capture:media", listener);
    },
    setSettings: (s) => ipcRenderer.invoke("capture:set-settings", s),
    acquire: () => ipcRenderer.invoke("capture:acquire"),
    release: () => ipcRenderer.invoke("capture:release"),
    devices: () => ipcRenderer.invoke("capture:devices"),
    setDelay: (ms) => ipcRenderer.invoke("capture:set-delay", ms),
    calibrate: () => ipcRenderer.invoke("capture:calibrate"),
  },
  kiosk: {
    get: () => ipcRenderer.invoke("kiosk:get"),
    onChange: (cb) => {
      const listener = (_e: unknown, s: KioskSnapshot) => cb(s);
      ipcRenderer.on("kiosk:changed", listener);
      return () => void ipcRenderer.removeListener("kiosk:changed", listener);
    },
    startPairing: (baseUrl) => ipcRenderer.invoke("kiosk:start-pairing", baseUrl),
    cancelPairing: () => ipcRenderer.invoke("kiosk:cancel-pairing"),
    unpair: () => ipcRenderer.invoke("kiosk:unpair"),
    startManual: (meta) => ipcRenderer.invoke("kiosk:start-manual", meta),
    stopLive: () => ipcRenderer.invoke("kiosk:stop-live"),
    dismissConflict: () => ipcRenderer.invoke("kiosk:dismiss-conflict"),
    report: (r) => ipcRenderer.send("kiosk:report", r),
    windowsFacts: () => ipcRenderer.invoke("kiosk:windows-facts"),
  },
  whipOffer: (sdp) => ipcRenderer.invoke("studio:whip-offer", sdp),
  whipPatch: (resource, fragment) => ipcRenderer.invoke("studio:whip-patch", resource, fragment),
  whipClose: (resource) => ipcRenderer.invoke("studio:whip-close", resource),
};

contextBridge.exposeInMainWorld("studio", bridge);
