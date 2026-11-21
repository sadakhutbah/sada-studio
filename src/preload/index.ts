import { contextBridge, ipcRenderer } from "electron";
import type { StudioBridge } from "../shared/ipc";

const bridge: StudioBridge = {
  rememberState: () => ipcRenderer.invoke("studio:remember-state"),
  login: (credentials, remember) => ipcRenderer.invoke("studio:login", credentials, remember),
  autoLogin: () => ipcRenderer.invoke("studio:auto-login"),
  selectMosque: (id) => ipcRenderer.invoke("studio:select-mosque", id),
  logout: (forget) => ipcRenderer.invoke("studio:logout", forget),
  whipOffer: (sdp) => ipcRenderer.invoke("studio:whip-offer", sdp),
  whipPatch: (resource, fragment) => ipcRenderer.invoke("studio:whip-patch", resource, fragment),
  whipClose: (resource) => ipcRenderer.invoke("studio:whip-close", resource),
  keepAwake: (on) => ipcRenderer.invoke("studio:keep-awake", on),
  version: process.env.npm_package_version ?? "",
};

contextBridge.exposeInMainWorld("studio", bridge);
