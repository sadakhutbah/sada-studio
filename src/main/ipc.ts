import { app, ipcMain, powerSaveBlocker } from "electron";
import { ApiError } from "../core/errors";
import { SadaHttpApi } from "../core/api/sada-api";
import type { Credentials } from "../core/api/types";
import type { IpcResult } from "../shared/ipc";
import { forgetCredentials, loadCredentials, saveCredentials, vaultAvailable } from "./credentials";

async function run<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.status, message: e.message };
    return { ok: false, status: 0, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Le client Sada vit dans le processus principal : cookies et mot de passe n'arrivent jamais à l'interface. */
export function registerIpc(): void {
  const api = new SadaHttpApi();
  let awake: number | null = null;

  ipcMain.handle("studio:remember-state", () =>
    run(async () => {
      const saved = loadCredentials();
      if (!app.isPackaged && process.env.SADA_STUDIO_DEMO) return { available: vaultAvailable(), saved: { baseUrl: "demo", username: "demo" } };
      return { available: vaultAvailable(), saved: saved ? { baseUrl: saved.baseUrl, username: saved.username } : null };
    }),
  );
  ipcMain.handle("studio:login", (_e, credentials: Credentials, remember: boolean) =>
    run(async () => {
      const session = await api.login(credentials);
      if (remember && vaultAvailable()) saveCredentials(credentials);
      else if (!remember) forgetCredentials();
      return session;
    }),
  );
  ipcMain.handle("studio:auto-login", () =>
    run(async () => {
      // Essais en développement seulement : SADA_STUDIO_DEMO="adresse|identifiant|mot de passe".
      const demo = !app.isPackaged && process.env.SADA_STUDIO_DEMO?.split("|");
      const saved = demo ? { baseUrl: demo[0], username: demo[1], password: demo[2] } : loadCredentials();
      if (!saved) throw new ApiError(0, "Aucune connexion mémorisée.");
      return api.login(saved);
    }),
  );
  ipcMain.handle("studio:select-mosque", (_e, id: number) => run(() => api.selectMosque(id)));
  ipcMain.handle("studio:logout", (_e, forget: boolean) =>
    run(async () => {
      await api.logout();
      if (forget) forgetCredentials();
      return null;
    }),
  );
  ipcMain.handle("studio:whip-offer", (_e, sdp: string) => run(() => api.whip.offer(sdp)));
  ipcMain.handle("studio:whip-patch", (_e, resource: string, fragment: string) =>
    run(async () => (await api.whip.patchIce(resource, fragment), null)),
  );
  ipcMain.handle("studio:whip-close", (_e, resource: string) => run(async () => (await api.whip.close(resource), null)));
  ipcMain.handle("studio:keep-awake", (_e, on: boolean) => {
    if (on && awake === null) awake = powerSaveBlocker.start("prevent-display-sleep");
    if (!on && awake !== null) {
      powerSaveBlocker.stop(awake);
      awake = null;
    }
  });
}
