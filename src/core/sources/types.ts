import type { CalibrationOutcome } from "../capture/calibrator";

/** Audio settings: automatic processing is off by default (imam's voice, recitations). */
export interface AudioSettings {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export const DEFAULT_AUDIO: AudioSettings = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

export interface DesktopSourceInfo {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnailDataUrl: string;
}

export type BrowserSourceMode = "fullscreen" | "overlay";
export type BrowserSourceCorner = "tl" | "tr" | "bl" | "br";
export type BrowserSourceSize = "sm" | "md" | "lg";

export interface BrowserSourceLayout {
  mode: BrowserSourceMode;
  corner: BrowserSourceCorner;
  size: BrowserSourceSize;
}

export interface BrowserSourceConfig extends BrowserSourceLayout {
  url: string;
  visible: boolean;
}

/** One painted frame of the web source: raw premultiplied BGRA pixels (no image encoding on the main process). */
export interface BrowserSourceFrame {
  width: number;
  height: number;
  bgra: Uint8Array;
}

/** Screen-recording permission as the main process reads it (always `granted` outside macOS). */
export type ScreenAccess = "granted" | "denied" | "not-determined" | "restricted" | "unknown";

export interface BrowserSourceStatus {
  /** The hidden window exists (the source is added). */
  active: boolean;
  loading: boolean;
  /** Whether frames are being produced (the source is shown in the programme). */
  visible: boolean;
  url: string;
  error: string | null;
}

export interface SourceOptions {
  /** Which source feeds the broadcast; the PC camera when absent. */
  sourceKind?: "camera" | "ip-camera" | "screen";
  /** For `ip-camera`: part of the capture settings, here so that a change restarts the capture (the main process holds the rest). */
  ipCamera?: { rtspUrl: string; audioDevice: string };
  /** For `screen`: desktopCapturer source id and whether to mix the local microphone. */
  screen?: { sourceId: string; includeMic?: boolean };
  /** Webcam: delay of the microphone, ms (applied live by Web Audio; saved per camera/microphone pair). */
  audioDelayMs?: number;
  videoDeviceId?: string;
  audioDeviceId?: string;
  audio: AudioSettings;
  /** Requested size and frame rate (ideal values; the hardware decides). */
  video?: { width: number; height: number; frameRate: number };
}

/**
 * Source strategy: where the tracks to broadcast come from (camera today; screen, composed
 * scene, audio mixing later). `acquire` returns the same stream as long as the options do not change,
 * so the preview and the broadcast share the same capture. The owner calls `release`.
 */
export interface MediaSourceStrategy {
  readonly id: string;
  acquire(options: SourceOptions): Promise<MediaStream>;
  release(): void;
  /** Notifies the loss of the source (camera unplugged). Returns the unsubscribe function. */
  onEnded(cb: () => void): () => void;
  /** Synchronization controls, for the sources whose delay is applied by the renderer (webcam). */
  readonly sync?: SourceSync;
  /** The stream to send changed while the source stays acquired (raw <-> composited): swap the senders' tracks. */
  onStreamChange?(cb: (s: MediaStream) => void): () => void;
}

export interface SourceSync {
  setAudioDelay(ms: number): void;
  calibrate(seconds?: number): Promise<CalibrationOutcome>;
}
