import { DEFAULT_BROWSER_SOURCE, normalizeBrowserSourceConfig } from "@core/sources/browser-source";
import { DEFAULT_AUDIO, type AudioSettings, type BrowserSourceLayout } from "@core/sources/types";
import { normalizeDelay } from "@core/capture/types";
import type { StreamKind } from "@core/api/types";

export interface Prefs {
  /** Type and title of the next manual live. */
  kind: StreamKind;
  title: string;
  videoDeviceId: string;
  audioDeviceId: string;
  audio: AudioSettings;
  /** Webcam microphone delay (ms) per camera/microphone pair, see `webcamPairKey`. */
  webcamDelays: Record<string, number>;
  /** Last typed instance address. */
  instance: string;
  /** Projector mode: open it by itself at the start of a live when an external screen is present. */
  projectorAuto: boolean;
  /** Last screen chosen for the projector. */
  projectorDisplay: number | null;
  /** Last web source: address and layout (it is never shown by itself at startup). */
  browserSource: BrowserSourceLayout & { url: string };
}

const pickBrowser = (c: Partial<BrowserSourceLayout & { url: string }> | null | undefined) => {
  const n = normalizeBrowserSourceConfig(c);
  return { url: n.url, mode: n.mode, corner: n.corner, size: n.size };
};

const KEY = "sada-studio.prefs";
const DEFAULTS: Prefs = { kind: "khutba", title: "", videoDeviceId: "", audioDeviceId: "", audio: DEFAULT_AUDIO, webcamDelays: {}, instance: "", projectorAuto: true, projectorDisplay: null, browserSource: pickBrowser(DEFAULT_BROWSER_SOURCE) };

/** Non-secret preferences, kept in the UI's local storage. */
export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>;
    return { ...DEFAULTS, ...raw, audio: { ...DEFAULT_AUDIO, ...raw.audio }, webcamDelays: { ...raw.webcamDelays }, browserSource: pickBrowser(raw.browserSource) };
  } catch {
    return DEFAULTS;
  }
}

export const savePrefs = (p: Prefs) => localStorage.setItem(KEY, JSON.stringify(p));

/** Identity of a camera/microphone pair (the default device when none is chosen). */
export const webcamPairKey = (p: Pick<Prefs, "videoDeviceId" | "audioDeviceId">) => `${p.videoDeviceId || "default"}|${p.audioDeviceId || "default"}`;

/** Delay saved for the selected pair, 0 when never set. */
export const webcamDelayOf = (p: Prefs): number => normalizeDelay(p.webcamDelays[webcamPairKey(p)] ?? 0);
