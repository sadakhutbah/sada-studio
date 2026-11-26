import { app, BrowserWindow, ipcMain } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isLocaleChoice, normalizeLocaleChoice, resolveLocale, type LocaleChoice, type LocaleView } from "../core/locale";
import { setLocale, t } from "../core/messages";
import type { IpcResult } from "../shared/ipc";

/** The language choice, in a small JSON of the user data directory. */
export class LocaleStore {
  private readonly file: string;

  constructor(userData: string) {
    this.file = join(userData, "locale.json");
  }

  load(): LocaleChoice {
    try {
      return normalizeLocaleChoice(JSON.parse(readFileSync(this.file, "utf8")));
    } catch {
      return "auto"; // first launch or unreadable file
    }
  }

  save(choice: LocaleChoice): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ choice }));
      renameSync(tmp, this.file);
    } catch {
      // Disk full or locked: the choice holds for this run only.
    }
  }
}

/**
 * Single source of the language: the saved choice, else the system language. Applies it to the main process
 * messages, tells the windows when it changes, and calls `onChange` (tray menu, dialogs built once).
 * Must run before anything produces a message.
 */
export function registerLocale(userData: string, onChange: () => void): { view(): LocaleView } {
  const store = new LocaleStore(userData);
  let choice = store.load();
  const resolve = () => resolveLocale(app.getLocale(), choice);
  setLocale(resolve());
  const view = (): LocaleView => ({ locale: resolve(), choice });

  ipcMain.handle("locale:get", (): LocaleView => view());
  ipcMain.handle("locale:set", (_e, next: unknown): IpcResult<LocaleView> => {
    if (!isLocaleChoice(next)) return { ok: false, status: 0, message: t("ipc.invalidLocale") };
    choice = next;
    store.save(choice);
    setLocale(resolve());
    const v = view();
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send("locale:changed", v);
    onChange();
    return { ok: true, value: v };
  });
  return { view };
}
