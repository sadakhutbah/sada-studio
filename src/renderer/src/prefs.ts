import { DEFAULT_AUDIO, type AudioSettings } from "@core/sources/types";
import type { StreamKind } from "@core/api/types";

export interface Prefs {
  kind: StreamKind;
  title: string;
  videoDeviceId: string;
  audioDeviceId: string;
  audio: AudioSettings;
  mosqueId: number | null;
}

const KEY = "sada-studio.prefs";
const DEFAULTS: Prefs = { kind: "khutba", title: "", videoDeviceId: "", audioDeviceId: "", audio: DEFAULT_AUDIO, mosqueId: null };

/** Préférences non secrètes, gardées dans le stockage local de l'interface. */
export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>;
    return { ...DEFAULTS, ...raw, audio: { ...DEFAULT_AUDIO, ...raw.audio } };
  } catch {
    return DEFAULTS;
  }
}

export const savePrefs = (p: Prefs) => localStorage.setItem(KEY, JSON.stringify(p));
