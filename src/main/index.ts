import { app, BrowserWindow, dialog, Menu, nativeImage, session, shell, Tray } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { backoffDelay } from "../core/kiosk/backoff";
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

// Un boîtier n'a qu'une instance : une seconde ouverture ramène la fenêtre de la première.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

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
/** Essais seulement (application non installée) : instance préremplie et script d'interface avant capture. */
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
  // Fermer la fenêtre ne quitte pas : l'application continue dans la zone de notification.
  w.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    w.hide();
  });
  // Aucun lien ne s'ouvre dans l'application : le navigateur du système s'en charge.
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

/** Le rendu plante ou se fige : on recharge la page. L'ordre vient du serveur, la reprise est donc automatique. */
function watchRenderer(w: BrowserWindow) {
  const crashes: number[] = [];
  let freeze: ReturnType<typeof setTimeout> | undefined;
  const reload = (why: string) => {
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - crashes[0] > 10 * 60_000) crashes.shift();
    // Plantages répétés : on espace les relances (1 s, 2 s, 4 s… jusqu'à 30 s) au lieu de boucler.
    const wait = backoffDelay(crashes.length, { baseMs: 1_000, maxMs: 30_000 });
    log(`Rendu relancé (${why}), dans ${wait} ms, ${crashes.length} incident(s) sur 10 min.`);
    setTimeout(() => {
      if (!w.isDestroyed()) load(w);
    }, wait);
  };
  w.webContents.on("render-process-gone", (_e, d) => reload(`render-process-gone : ${d.reason}`));
  w.webContents.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) reload(`chargement échoué : ${desc}`);
  });
  w.on("unresponsive", () => {
    freeze = setTimeout(() => reload("interface figée"), 30_000);
  });
  w.on("responsive", () => clearTimeout(freeze));
}

function showWindow() {
  if (!win || win.isDestroyed()) win = createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Quitter arrête les directs : on demande confirmation, plus fermement pendant un direct. */
async function requestQuit() {
  const live = kiosk?.supervisor.view.wantLive;
  const { response } = await dialog.showMessageBox({
    type: "warning",
    title: `Quitter ${APP_NAME}`,
    message: live ? "Un direct est en cours. Quitter l'arrêtera." : "Quitter Sada Studio ?",
    detail: "Une fois fermée, l'application ne diffusera plus les directs planifiés, jusqu'au prochain démarrage de Windows ou de l'application.",
    buttons: ["Rester", "Quitter"],
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
      { label: "Ouvrir Sada Studio", click: showWindow },
      { type: "separator" },
      { label: "Quitter", click: () => void requestQuit() },
    ]),
  );
  tray.on("click", showWindow);
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

/** Aide aux essais : script d'interface optionnel, capture de la fenêtre, puis on quitte (SADA_STUDIO_CAPTURE=/chemin.png). */
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
// Arrêt ou fermeture de session Windows : on ne bloque jamais l'extinction.
app.on("session-end" as never, () => {
  quitting = true;
});
// La fenêtre peut être cachée : l'application vit dans la zone de notification.
app.on("window-all-closed", () => undefined);

void app.whenReady().then(() => {
  lockDownPermissions();
  // Démarrage avec la session Windows (et macOS) ; sans effet sous Linux et en développement.
  if (app.isPackaged && (process.platform === "win32" || process.platform === "darwin")) {
    app.setLoginItemSettings({ openAtLogin: true, args: ["--autostart"] });
  }
  kiosk = registerIpc(app.getVersion());
  createAppMenu();
  createTray();
  win = createWindow();
  if (dev && process.env.SADA_STUDIO_INSTANCE && kiosk.supervisor.view.phase === "unpaired") {
    void kiosk.supervisor.startPairing(process.env.SADA_STUDIO_INSTANCE).catch((e: Error) => log(`Appairage : ${e.message}`));
  }
  if (dev && process.env.SADA_STUDIO_CAPTURE) captureAndQuit(win, process.env.SADA_STUDIO_CAPTURE);
  app.on("activate", showWindow);
});
