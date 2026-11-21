import { contextBridge, ipcRenderer } from "electron";
import type { KioskSnapshot, StudioBridge } from "../shared/ipc";

const bridge: StudioBridge = {
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
