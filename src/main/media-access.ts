import { shell, systemPreferences } from "electron";
import type { ScreenAccess } from "../core/sources/types";
import type { MediaAccess } from "../shared/ipc";

type Kind = "camera" | "microphone";

let pending: Promise<MediaAccess> | null = null;

/**
 * macOS privacy (TCC): asks once, camera then microphone, never in parallel.
 * Once the user has answered, only the status is read (it never prompts), so the UI can poll it
 * instead of calling getUserMedia in a loop (each call re-opened the system prompt).
 * Other systems: always granted (the permission handler of the session decides).
 */
export function ensureMediaAccess(): Promise<MediaAccess> {
  if (process.platform !== "darwin") return Promise.resolve({ camera: true, microphone: true });
  pending ??= (async () => {
    const one = async (kind: Kind) => {
      const status = systemPreferences.getMediaAccessStatus(kind);
      if (status === "granted") return true;
      if (status === "not-determined") return systemPreferences.askForMediaAccess(kind);
      return false;
    };
    const camera = await one("camera");
    const microphone = await one("microphone");
    return { camera, microphone };
  })().finally(() => {
    pending = null;
  });
  return pending;
}

/** macOS screen-recording permission (read-only, never prompts); always granted elsewhere. */
export function screenAccessStatus(): ScreenAccess {
  if (process.platform !== "darwin") return "granted";
  return systemPreferences.getMediaAccessStatus("screen");
}

/** Opens the matching pane of System Settings (macOS only). */
export async function openMediaSettings(kind: Kind | "screen"): Promise<void> {
  if (process.platform !== "darwin") return;
  const pane = kind === "camera" ? "Privacy_Camera" : kind === "screen" ? "Privacy_ScreenCapture" : "Privacy_Microphone";
  await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
}
