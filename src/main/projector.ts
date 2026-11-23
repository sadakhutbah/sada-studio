import { BrowserWindow, ipcMain, screen } from "electron";
import { join } from "node:path";
import type { ProjectorDisplay, ProjectorSignal } from "../shared/ipc";

let projector: BrowserWindow | null = null;

/** Every screen, with the external ones flagged (the primary screen is the operator's). */
export function listDisplays(): ProjectorDisplay[] {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    index: i + 1,
    external: d.id !== primary,
    width: d.bounds.width,
    height: d.bounds.height,
  }));
}

const broadcastState = (main: () => BrowserWindow | null) => {
  const w = main();
  if (w && !w.isDestroyed()) w.webContents.send("projector:state", projector !== null);
};

/** "Projector" mode (like OBS): a second frameless full-screen window showing only the preview video. */
export function registerProjector(devUrl: string | undefined, main: () => BrowserWindow | null) {
  const closeProjector = () => {
    if (projector && !projector.isDestroyed()) projector.close();
  };

  const open = (displayId: unknown) => {
    const displays = screen.getAllDisplays();
    const wanted = displays.find((d) => d.id === displayId);
    const external = displays.find((d) => d.id !== screen.getPrimaryDisplay().id);
    const d = wanted ?? external ?? screen.getPrimaryDisplay();
    if (projector && !projector.isDestroyed()) {
      projector.setBounds(d.bounds);
      projector.setFullScreen(true);
      projector.focus();
      return;
    }
    const w = new BrowserWindow({
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
      frame: false,
      fullscreen: true,
      skipTaskbar: true,
      backgroundColor: "#000000",
      autoHideMenuBar: true,
      title: "Sada Studio",
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    projector = w;
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    w.webContents.on("will-navigate", (e) => e.preventDefault());
    w.on("closed", () => {
      if (projector === w) projector = null;
      broadcastState(main);
    });
    if (devUrl) void w.loadURL(`${devUrl}#projector`);
    else void w.loadFile(join(__dirname, "../renderer/index.html"), { hash: "projector" });
    w.once("ready-to-show", () => {
      w.setFullScreen(true);
      w.show();
      broadcastState(main);
    });
  };

  ipcMain.handle("projector:displays", () => listDisplays());
  ipcMain.handle("projector:is-open", () => projector !== null);
  ipcMain.handle("projector:open", (_e, displayId: unknown) => open(displayId));
  ipcMain.handle("projector:close", () => closeProjector());
  // WebRTC signalling between the operator window (owner of the capture) and the projector window.
  ipcMain.on("projector:signal", (e, msg: ProjectorSignal) => {
    const m = main();
    const target = projector && e.sender === projector.webContents ? m : projector;
    if (target && !target.isDestroyed()) target.webContents.send("projector:signal", msg);
  });
  return closeProjector;
}
