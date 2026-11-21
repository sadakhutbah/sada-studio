import { DEFAULT_AUDIO, type AudioSettings } from "@core/sources/types";
import type { StreamKind } from "@core/api/types";

export interface Prefs {
  /** Type and title of the next manual live. */
  kind: StreamKind;
  title: string;
  videoDeviceId: string;
  audioDeviceId: string;
  audio: AudioSettings;
  /** Last typed instance address. */
  instance: string;
}

const KEY = "sada-studio.prefs";
const DEFAULTS: Prefs = { kind: "khutba", title: "", videoDeviceId: "", audioDeviceId: "", audio: DEFAULT_AUDIO, instance: "" };

/** Non-secret preferences, kept in the UI's local storage. */
export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>;
    return { ...DEFAULTS, ...raw, audio: { ...DEFAULT_AUDIO, ...raw.audio } };
  } catch {
    return DEFAULTS;
  }
}

export const savePrefs = (p: Prefs) => localStorage.setItem(KEY, JSON.stringify(p));
