import type { CalibrationResult } from "./calibration";
import type { CaptureState } from "./machine";
import type { AudioBackend, IpCameraConfig } from "./types";

/** Which source feeds the broadcast: the PC's own camera (getUserMedia) or the IP camera + sound card pipeline. */
export type SourceKind = "camera" | "ip-camera";

/** What the operator chooses, persisted per device by the main process (the audio delay is stored apart, per sound card). */
export interface CaptureSettings {
  sourceKind: SourceKind;
  /** rtsp://… (credentials in the URL are kept in this local file only, never in logs or reports). */
  rtspUrl: string;
  /** DirectShow name of the sound card input. */
  audioDevice: string;
}

export const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = { sourceKind: "camera", rtspUrl: "", audioDevice: "" };

/** Subset of the settings the renderer puts in `SourceOptions` so a change restarts the capture. */
export type IpCameraOptions = Pick<CaptureSettings, "rtspUrl" | "audioDevice">;

export const isRtspUrl = (u: string) => /^rtsps?:\/\/[^\s/]+(\/\S*)?$/i.test(u.trim());

/** Validates and normalizes untrusted input (IPC, file). Returns null when it is not usable as is. */
export function parseSettings(raw: unknown): CaptureSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<CaptureSettings>;
  const sourceKind: SourceKind = r.sourceKind === "ip-camera" ? "ip-camera" : "camera";
  const rtspUrl = typeof r.rtspUrl === "string" ? r.rtspUrl.trim() : "";
  const audioDevice = typeof r.audioDevice === "string" ? r.audioDevice.trim() : "";
  if (rtspUrl.length > 2048 || audioDevice.length > 512) return null;
  // The source can be chosen before it is fully filled in (it just does not start); a filled URL must be a real one.
  if (rtspUrl && !isRtspUrl(rtspUrl)) return null;
  return { sourceKind, rtspUrl, audioDevice };
}

export const isComplete = (s: CaptureSettings) => isRtspUrl(s.rtspUrl) && s.audioDevice.trim() !== "";

/** Same URL with the password hidden: for the UI status line and logs. */
export function redactUrl(u: string): string {
  return u.replace(/(rtsps?:\/\/)([^@/\s]*)@/gi, (_m, scheme: string, cred: string) => `${scheme}${cred.includes(":") ? `${cred.split(":")[0]}:***` : cred}@`);
}

/**
 * Output of the capture, as seen by the application: a fragmented MP4 on stdout. The renderer plays it through
 * MediaSource and takes the tracks of that player to the existing WHIP chain (see docs/ip-camera-local-audio.md).
 */
export const MSE_OUTPUT_ARGS = [
  "-f", "mp4",
  "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
  "-frag_duration", "500000",
  "-flush_packets", "1",
  "pipe:1",
];

export const MSE_MIME = 'video/mp4; codecs="avc1.640028,mp4a.40.2"';

export function toIpCameraConfig(s: CaptureSettings, audioBackend: AudioBackend, outputArgs: string[] = MSE_OUTPUT_ARGS): IpCameraConfig {
  return { rtspUrl: s.rtspUrl, audioDevice: s.audioDevice, audioBackend, outputArgs };
}

export type CalibrationView =
  | { status: "idle" }
  | { status: "running"; seconds: number }
  | { status: "done"; result: CalibrationResult | { ok: false; reason: "ffmpeg"; detail: string }; at: number };

/** Everything the UI shows about the capture; the secret-bearing URL is redacted. */
export interface CaptureView {
  settings: CaptureSettings;
  /** Settings as shown to the user, password hidden. */
  rtspUrlShown: string;
  state: Pick<CaptureState, "status" | "attempt" | "lastError">;
  /** Prolonged outage: the operator is being warned. */
  alert: boolean;
  /** Audio delay applied to the selected sound card, ms. */
  delayMs: number;
  calibration: CalibrationView;
  ffmpeg: "ok" | "missing";
}

export const INITIAL_CAPTURE_VIEW: CaptureView = {
  settings: DEFAULT_CAPTURE_SETTINGS,
  rtspUrlShown: "",
  state: { status: "idle", attempt: 0, lastError: null },
  alert: false,
  delayMs: 0,
  calibration: { status: "idle" },
  ffmpeg: "ok",
};
