import { contextBridge, ipcRenderer } from "electron";
import type { CaptureView } from "../core/capture/settings";
import type { BrowserSourceFrame, BrowserSourceStatus } from "../core/sources/types";
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
  sources: {
    browser: {
      status: () => ipcRenderer.invoke("sources:browser-status"),
      onStatus: (cb) => {
        const listener = (_e: unknown, v: BrowserSourceStatus) => cb(v);
        ipcRenderer.on("sources:browser-status-changed", listener);
        return () => void ipcRenderer.removeListener("sources:browser-status-changed", listener);
      },
      onFrame: (cb) => {
        const listener = (_e: unknown, f: BrowserSourceFrame) => cb(f);
        ipcRenderer.on("sources:browser-frame", listener);
        return () => void ipcRenderer.removeListener("sources:browser-frame", listener);
      },
      ackFrame: () => ipcRenderer.send("sources:browser-frame-ack"),
      start: (url) => ipcRenderer.invoke("sources:browser-start", url),
      reload: () => ipcRenderer.invoke("sources:browser-reload"),
      setVisible: (visible) => ipcRenderer.invoke("sources:browser-set-visible", visible),
      stop: () => ipcRenderer.invoke("sources:browser-stop"),
    },
    screen: {
      access: () => ipcRenderer.invoke("sources:screen-access"),
      list: () => ipcRenderer.invoke("sources:screen-list"),
      select: (sourceId) => ipcRenderer.invoke("sources:screen-select", sourceId),
      openSettings: () => ipcRenderer.invoke("sources:screen-open-settings"),
    },
  },
  media: {
    access: () => ipcRenderer.invoke("media:access"),
    openSettings: (kind) => ipcRenderer.invoke("media:open-settings", kind),
  },
  projector: {
    displays: () => ipcRenderer.invoke("projector:displays"),
    isOpen: () => ipcRenderer.invoke("projector:is-open"),
    open: (id) => ipcRenderer.invoke("projector:open", id),
    close: () => ipcRenderer.invoke("projector:close"),
    onState: (cb) => {
      const listener = (_e: unknown, v: boolean) => cb(v);
      ipcRenderer.on("projector:state", listener);
      return () => void ipcRenderer.removeListener("projector:state", listener);
    },
    signal: (m) => ipcRenderer.send("projector:signal", m),
    onSignal: (cb) => {
      const listener = (_e: unknown, m: Parameters<typeof cb>[0]) => cb(m);
      ipcRenderer.on("projector:signal", listener);
      return () => void ipcRenderer.removeListener("projector:signal", listener);
    },
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
  setup: {
    enter: () => ipcRenderer.invoke("setup:enter"),
    leave: () => ipcRenderer.invoke("setup:leave"),
    whepOffer: (sdp) => ipcRenderer.invoke("setup:whep-offer", sdp),
    whepClose: (resource) => ipcRenderer.invoke("setup:whep-close", resource),
  },
  regie: {
    get: () => ipcRenderer.invoke("regie:get"),
    status: () => ipcRenderer.invoke("regie:status"),
    command: (cmd, arg, transition) => ipcRenderer.invoke("regie:command", cmd, arg, transition),
    setTransition: (mode) => ipcRenderer.invoke("regie:set-transition", mode),
    setMute: (muted) => ipcRenderer.invoke("regie:set-mute", muted),
    setOverlay: (kind, payload) => ipcRenderer.invoke("regie:set-overlay", kind, payload),
    overlayLayer: (etag) => ipcRenderer.invoke("regie:overlay-layer", etag),
  },
};

contextBridge.exposeInMainWorld("studio", bridge);
