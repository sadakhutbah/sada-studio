import type { LiveStatus, OverlayKind, OverlayUpdateResponse, RegieData, StreamMeta, TransitionMode } from "../core/api/types";
import type { CalibrationView, CaptureSettings, CaptureView } from "../core/capture/settings";
import type { WindowsFacts } from "../core/health/health";
import type { ClientReport, KioskView } from "../core/kiosk/supervisor";
import type { UpdateStatus } from "../core/kiosk/update-gate";

/** Serializable result of an IPC call: errors keep their HTTP code (0 = network). */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

/** The device state as the UI sees it: never the device secret. */
export type KioskSnapshot = KioskView & { update: UpdateStatus | null };

/** Media units of the IP camera capture (fragmented MP4) pushed to the player of the UI. */
export interface CaptureMedia {
  /** Initialization segment (ftyp + moov): starts a new timeline segment (first start, restart, new window). */
  init: boolean;
  data: Uint8Array;
}

/** "IP camera + local microphone" source, driven by the main process (ffmpeg). */
export interface CaptureBridge {
  get(): Promise<CaptureView>;
  onChange(cb: (v: CaptureView) => void): () => void;
  onMedia(cb: (m: CaptureMedia) => void): () => void;
  /** Source choice, RTSP address, sound card. */
  setSettings(s: CaptureSettings): Promise<IpcResult<CaptureView>>;
  /** Starts the capture if needed and (re)sends the current initialization segment. */
  acquire(): Promise<IpcResult<null>>;
  release(): Promise<IpcResult<null>>;
  /** DirectShow sound cards, re-read. */
  devices(): Promise<string[]>;
  /** Audio delay in ms (any value: rounded to the 50 ms step). */
  setDelay(ms: number): Promise<IpcResult<CaptureView>>;
  calibrate(): Promise<IpcResult<CalibrationView>>;
}

/** macOS camera / microphone permission (always true elsewhere). */
export interface MediaAccess {
  camera: boolean;
  microphone: boolean;
}

export interface ProjectorDisplay {
  id: number;
  /** 1-based position in the system's list. */
  index: number;
  external: boolean;
  width: number;
  height: number;
}

/** WebRTC signalling relayed between the operator window and the projector window. */
export type ProjectorSignal =
  | { kind: "ready" }
  | { kind: "offer" | "answer"; sdp: string }
  | { kind: "ice"; candidate: RTCIceCandidateInit };

/** What the main process exposes to the UI (`window.studio`). */
export interface StudioBridge {
  capture: CaptureBridge;
  media: {
    /** Asks once (macOS), then only reads the status: safe to call repeatedly. */
    access(): Promise<MediaAccess>;
    openSettings(kind: "camera" | "microphone"): Promise<void>;
  };
  projector: {
    displays(): Promise<ProjectorDisplay[]>;
    isOpen(): Promise<boolean>;
    open(displayId: number | null): Promise<void>;
    close(): Promise<void>;
    onState(cb: (open: boolean) => void): () => void;
    signal(msg: ProjectorSignal): void;
    onSignal(cb: (msg: ProjectorSignal) => void): () => void;
  };
  kiosk: {
    get(): Promise<KioskSnapshot>;
    onChange(cb: (s: KioskSnapshot) => void): () => void;
    startPairing(baseUrl: string): Promise<IpcResult<null>>;
    cancelPairing(): Promise<IpcResult<null>>;
    unpair(): Promise<IpcResult<null>>;
    startManual(meta: StreamMeta): Promise<IpcResult<null>>;
    stopLive(): Promise<IpcResult<null>>;
    dismissConflict(): Promise<void>;
    /** State of the broadcast session and of the hardware, included in each heartbeat. */
    report(r: ClientReport): void;
    windowsFacts(): Promise<WindowsFacts | null>;
  };
  whipOffer(sdp: string): Promise<IpcResult<{ answer: string; resource: string }>>;
  whipPatch(resource: string, fragment: string): Promise<IpcResult<null>>;
  whipClose(resource: string): Promise<IpcResult<null>>;
  regie: {
    get(): Promise<IpcResult<RegieData>>;
    status(): Promise<IpcResult<LiveStatus>>;
    command(cmd: string, arg?: string, transition?: TransitionMode): Promise<IpcResult<LiveStatus>>;
    setTransition(mode: TransitionMode): Promise<IpcResult<{ ok: boolean; transition: TransitionMode }>>;
    setMute(muted: boolean): Promise<IpcResult<{ ok: boolean; muted: boolean; mic_muted: boolean }>>;
    setOverlay(kind: OverlayKind, payload: Record<string, unknown>): Promise<IpcResult<OverlayUpdateResponse>>;
  };
}

declare global {
  interface Window {
    studio: StudioBridge;
  }
}
