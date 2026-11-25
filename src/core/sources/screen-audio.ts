import { t } from "../messages";

export interface ScreenAudioSupport {
  supported: boolean;
  /** Why not, in the user's language; null when supported. */
  reason: string | null;
}

/**
 * Whether the sound of the shared screen can be captured. Electron only gives system-audio loopback on Windows; elsewhere
 * (macOS included) the share goes out without its sound, and the interface says so instead of offering a dead switch.
 */
export function screenAudioSupport(platform: string): ScreenAudioSupport {
  if (platform === "win32") return { supported: true, reason: null };
  return { supported: false, reason: t(platform === "darwin" ? "screen.audioUnsupportedMac" : "screen.audioUnsupported") };
}
