import { app, BrowserWindow, session, shell } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerIpc } from "./ipc";

// Un direct ne doit jamais ralentir parce que la fenêtre est cachée ou couverte.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
// Essais sans matériel (CI, WSL) : caméra et micro simulés, sans demande d'autorisation.
if (process.env.SADA_STUDIO_FAKE_MEDIA === "1") {
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
}

const devUrl = process.env.ELECTRON_RENDERER_URL;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 980,
    minHeight: 680,
    show: false,
    title: "Sada Studio",
    backgroundColor: "#f7f3ea",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.once("ready-to-show", () => win.show());
  // Aucun lien ne s'ouvre dans l'application : le navigateur du système s'en charge.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!devUrl || !url.startsWith(devUrl)) e.preventDefault();
  });
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
  return win;
}

function lockDownPermissions() {
  const ses = session.defaultSession;
  // Seuls caméra et micro, et seulement pour l'interface elle-même.
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media"));
  ses.setPermissionCheckHandler((_wc, permission) => permission === "media");
  if (!devUrl) {
    ses.webRequest.onHeadersReceived((details, cb) =>
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; connect-src 'self'",
          ],
        },
      }),
    );
  }
}

/** Aide aux essais : enregistre une capture de la fenêtre puis quitte (SADA_STUDIO_CAPTURE=/chemin.png). */
function captureAndQuit(win: BrowserWindow, path: string) {
  win.webContents.once("did-finish-load", () => {
    setTimeout(async () => {
      const image = await win.webContents.capturePage();
      writeFileSync(path, image.toPNG());
      app.quit();
    }, Number(process.env.SADA_STUDIO_CAPTURE_DELAY ?? 5000));
  });
}

void app.whenReady().then(() => {
  lockDownPermissions();
  registerIpc();
  const win = createWindow();
  if (process.env.SADA_STUDIO_CAPTURE) captureAndQuit(win, process.env.SADA_STUDIO_CAPTURE);
  app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on("window-all-closed", () => app.quit());
