import { app } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WindowsFacts } from "../core/health/health";
import { parseActiveHours, parseAutoLogon, parseSleepTimeouts } from "../core/health/windows-parsers";

const run = promisify(execFile);

async function out(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run(cmd, args, { timeout: 5_000, windowsHide: true, encoding: "utf8" });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Lectures seules (reg query, powercfg /query) : rien n'est modifié. Hors Windows : `null`, sans rien exécuter.
 */
export async function collectWindowsFacts(): Promise<WindowsFacts | null> {
  if (process.platform !== "win32") return null;
  const [winlogon, update, sleep] = await Promise.all([
    out("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon", "/v", "AutoAdminLogon"]),
    out("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings"]),
    out("powercfg", ["/query", "SCHEME_CURRENT", "SUB_SLEEP", "STANDBYIDLE"]),
  ]);
  return {
    autoLogon: winlogon === null ? null : parseAutoLogon(winlogon),
    activeHours: update === null ? null : parseActiveHours(update),
    sleepAcSeconds: sleep === null ? null : (parseSleepTimeouts(sleep)?.acSeconds ?? null),
    launchAtLogin: app.isPackaged ? app.getLoginItemSettings().openAtLogin : null,
  };
}
