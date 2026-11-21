import { app, BrowserWindow, dialog, Menu, nativeImage, session, shell, Tray } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { backoffDelay } from "../core/kiosk/backoff";
import { t } from "../core/messages";
import { registerIpc, type Kiosk } from "./ipc";
import { log } from "./log";

// Identity first: the name shown in the Dock, the menu bar, the task bar and the About box must be ours, also in development.
// In development, keep the data directory the name used to give (the installed app has its own), so that tests never share
// the paired-device vault with a real installation.
const APP_NAME = "Sada Studio";
const devUserData = app.isPackaged ? null : app.getPath("userData");
app.setName(APP_NAME);
if (devUserData) app.setPath("userData", devUserData);
// Must match `appId` in electron-builder.yml: Windows groups notifications and pinned shortcuts by it.
if (process.platform === "win32") app.setAppUserModelId("org.sadakhutbah.studio");
app.setAboutPanelOptions({
  applicationName: APP_NAME,
  applicationVersion: app.getVersion(),
  copyright: `Copyright © ${new Date().getFullYear()} Sada`,
  website: "https://sadakhutbah.org",
  iconPath: app.isPackaged ? join(process.resourcesPath, "icon.png") : join(app.getAppPath(), "build/icon.png"),
});

// A device runs a single instance: a second launch brings the first window back.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// A live must never slow down because the window is hidden or covered.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
// Testing without hardware (CI, WSL): simulated camera and microphone, no permission prompt.
if (process.env.SADA_STUDIO_FAKE_MEDIA === "1") {
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
}

const devUrl = process.env.ELECTRON_RENDERER_URL;
/** Testing only (application not installed): prefilled instance and UI script before capture. */
const dev = !app.isPackaged;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let kiosk: Kiosk | null = null;
let quitting = false;

const iconPath = () => (app.isPackaged ? join(process.resourcesPath, "icon.png") : join(app.getAppPath(), "build/icon.png"));

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 980,
    minHeight: 680,
    show: false,
    title: "Sada Studio",
    icon: iconPath(),
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
  w.once("ready-to-show", () => w.show());
  // Closing the window does not quit: the application keeps running in the notification area.
  w.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    w.hide();
  });
  // No link opens inside the application: the system browser handles it.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (e, url) => {
    if (!devUrl || !url.startsWith(devUrl)) e.preventDefault();
  });
  watchRenderer(w);
  load(w);
  return w;
}

function load(w: BrowserWindow) {
  if (devUrl) void w.loadURL(devUrl);
  else void w.loadFile(join(__dirname, "../renderer/index.html"));
}

/** The renderer crashes or freezes: reload the page. The order comes from the server, so recovery is automatic. */
function watchRenderer(w: BrowserWindow) {
  const crashes: number[] = [];
  let freeze: ReturnType<typeof setTimeout> | undefined;
  const reload = (why: string) => {
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - crashes[0] > 10 * 60_000) crashes.shift();
    // Repeated crashes: space out the reloads (1 s, 2 s, 4 s… up to 30 s) instead of looping.
    const wait = backoffDelay(crashes.length, { baseMs: 1_000, maxMs: 30_000 });
    log(`Renderer reloaded (${why}) in ${wait} ms, ${crashes.length} incident(s) in 10 min.`);
    setTimeout(() => {
      if (!w.isDestroyed()) load(w);
    }, wait);
  };
  w.webContents.on("render-process-gone", (_e, d) => reload(`render-process-gone: ${d.reason}`));
  w.webContents.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) reload(`load failed: ${desc}`);
  });
  w.on("unresponsive", () => {
    freeze = setTimeout(() => reload("UI frozen"), 30_000);
  });
  w.on("responsive", () => clearTimeout(freeze));
}

function showWindow() {
  if (!win || win.isDestroyed()) win = createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Quitting stops the lives: ask for confirmation, more firmly during a live. */
async function requestQuit() {
  const live = kiosk?.supervisor.view.wantLive;
  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: t("quit.title", { app: APP_NAME }),
    message: live ? t("quit.live") : t("quit.idle"),
    detail: t("quit.detail"),
    buttons: [t("quit.stay"), t("quit.quit")],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (response === 1) app.quit();
}

/** macOS: a standard menu whose first entry carries the application name (About, Hide, Quit). */
function createAppMenu() {
  if (process.platform !== "darwin") return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      { role: "windowMenu" },
    ]),
  );
  // Development runs the stock Electron binary: at least show our icon in the Dock.
  if (!app.isPackaged) app.dock?.setIcon(nativeImage.createFromPath(iconPath()));
}

function createTray() {
  const img = nativeImage.createFromPath(iconPath());
  tray = new Tray(img.isEmpty() ? img : img.resize({ width: 16, height: 16 }));
  tray.setToolTip("Sada Studio");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t("tray.open"), click: showWindow },
      { type: "separator" },
      { label: t("quit.quit"), click: () => void requestQuit() },
    ]),
  );
  tray.on("click", showWindow);
}

function lockDownPermissions() {
  const ses = session.defaultSession;
  // Camera and microphone only, and only for the UI itself.
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

/** Testing aid: optional UI script, window capture, then quit (SADA_STUDIO_CAPTURE=/path.png). */
function captureAndQuit(w: BrowserWindow, path: string) {
  w.webContents.once("did-finish-load", () => {
    const script = process.env.SADA_STUDIO_CAPTURE_SCRIPT;
    const delay = Number(process.env.SADA_STUDIO_CAPTURE_DELAY ?? 5000);
    const shoot = async () => {
      writeFileSync(path, (await w.webContents.capturePage()).toPNG());
      quitting = true;
      app.quit();
    };
    if (script) setTimeout(() => void w.webContents.executeJavaScript(script).catch(() => undefined), Number(process.env.SADA_STUDIO_CAPTURE_SCRIPT_DELAY ?? 4000));
    setTimeout(() => void shoot(), delay + (script ? 2500 : 0));
  });
}

app.on("second-instance", showWindow);
app.on("before-quit", () => {
  quitting = true;
});
// Windows shutdown or sign-out: never block it.
app.on("session-end" as never, () => {
  quitting = true;
});
// The window may be hidden: the application lives in the notification area.
app.on("window-all-closed", () => undefined);

void app.whenReady().then(() => {
  lockDownPermissions();
  // Start with the Windows (and macOS) session; no effect on Linux and in development.
  if (app.isPackaged && (process.platform === "win32" || process.platform === "darwin")) {
    app.setLoginItemSettings({ openAtLogin: true, args: ["--autostart"] });
  }
  kiosk = registerIpc(app.getVersion());
  createAppMenu();
  createTray();
  win = createWindow();
  if (dev && process.env.SADA_STUDIO_INSTANCE && kiosk.supervisor.view.phase === "unpaired") {
    void kiosk.supervisor.startPairing(process.env.SADA_STUDIO_INSTANCE).catch((e: Error) => log(`Pairing: ${e.message}`));
  }
  if (dev && process.env.SADA_STUDIO_CAPTURE) captureAndQuit(win, process.env.SADA_STUDIO_CAPTURE);
  app.on("activate", showWindow);
});
