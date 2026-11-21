import { app } from "electron";
import { autoUpdater } from "electron-updater";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UpdateGate, type UpdateContext } from "../core/kiosk/update-gate";
import { resolveUpdateFeed } from "../core/kiosk/update-feed";

const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 6 * 3600_000;

function readFeedFile(): unknown {
  try {
    return JSON.parse(readFileSync(join(app.getPath("userData"), "update.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Automatic update from a static HTTP feed (generic provider, see `publish` in electron-builder.yml; no token needed).
 * Download happens in the background whenever it wants; installation goes through `UpdateGate`: never during a live
 * stream nor in the margin before a slot. Inactive outside an installed application (development, tests).
 */
export function startUpdater(context: () => UpdateContext, log: (m: string) => void): UpdateGate | null {
  if (!app.isPackaged) return null;
  const feed = resolveUpdateFeed({ env: process.env, file: readFeedFile() });
  if (feed) {
    autoUpdater.setFeedURL({ provider: "generic", url: feed.url, channel: feed.channel });
    log(`Update feed (${feed.source}): ${feed.url} [${feed.channel}]`);
  }
  const gate = new UpdateGate({
    context,
    install: () => {
      log("Update: installing.");
      autoUpdater.quitAndInstall(true, true);
    },
  });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on("checking-for-update", () => log("Update: checking."));
  autoUpdater.on("update-not-available", (info) => log(`Update: none available (current ${app.getVersion()}, feed ${info.version}).`));
  let pending = "";
  autoUpdater.on("update-available", (info) => {
    pending = info.version;
    log(`Update: ${info.version} available, downloading.`);
  });
  let lastLogged = -1;
  autoUpdater.on("download-progress", (p) => {
    gate.onProgress(pending, p.percent);
    const step = Math.floor(p.percent / 25);
    if (step !== lastLogged) {
      lastLogged = step;
      log(`Update: downloading ${Math.round(p.percent)}%.`);
    }
  });
  autoUpdater.on("update-downloaded", (info) => {
    log(`Update: ${info.version} downloaded.`);
    gate.onDownloaded(info.version);
  });
  autoUpdater.on("error", (e) => log(`Update: ${e.message}`));
  const check = () => void autoUpdater.checkForUpdates().catch((e: Error) => log(`Update: ${e.message}`));
  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
  return gate;
}
