import { app } from "electron";
import { autoUpdater } from "electron-updater";
import { UpdateGate, type UpdateContext } from "../core/kiosk/update-gate";

const CHECK_EVERY_MS = 6 * 3600_000;

/**
 * Mise à jour automatique (releases GitHub, voir `publish` dans electron-builder.yml).
 * Le téléchargement se fait quand il veut ; l'installation passe par `UpdateGate` : jamais pendant un direct
 * ni dans la marge avant un créneau. Inactive hors application installée (développement, essais).
 */
export function startUpdater(context: () => UpdateContext, log: (m: string) => void): UpdateGate | null {
  if (!app.isPackaged) return null;
  const gate = new UpdateGate({
    context,
    install: () => {
      log("Installation de la mise à jour.");
      autoUpdater.quitAndInstall(true, true);
    },
  });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on("update-downloaded", (info) => gate.onDownloaded(info.version));
  autoUpdater.on("error", (e) => log(`Mise à jour : ${e.message}`));
  const check = () => void autoUpdater.checkForUpdates().catch((e: Error) => log(`Mise à jour : ${e.message}`));
  setTimeout(check, 60_000);
  setInterval(check, CHECK_EVERY_MS);
  return gate;
}
