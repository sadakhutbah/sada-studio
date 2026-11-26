import type {
  LiveStatus,
  OverlayKind,
  OverlayLayerFetch,
  OverlayUpdateResponse,
  RegieData,
  SetupState,
  StreamMeta,
  TransitionMode,
} from "../core/api/types";
import type { CalibrationView, CaptureSettings, CaptureView } from "../core/capture/settings";
import type { WindowsFacts } from "../core/health/health";
import type { ClientReport, KioskView } from "../core/kiosk/supervisor";
import type { UpdateStatus } from "../core/kiosk/update-gate";
import type { ControlRequest, ControlResult, ShortcutAction } from "../core/control/actions";
import type { LocaleChoice, LocaleView } from "../core/locale";
import type { ControlView } from "../core/control/settings";
import type { ScreenAudioSupport } from "../core/sources/screen-audio";
import type { BrowserSourceFrame, BrowserSourceStatus, DesktopSourceInfo, ScreenAccess } from "../core/sources/types";

/** Serializable result of an IPC call: errors keep their HTTP code (0 = network). */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string; code?: string };

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

/** Local sources driven by the main process: a hidden web page and the screens / windows of the computer. */
export interface SourcesBridge {
  browser: {
    status(): Promise<BrowserSourceStatus>;
    onStatus(cb: (s: BrowserSourceStatus) => void): () => void;
    /** Painted frames (raw BGRA, bounded size, rate-limited); call `ackFrame` once one is consumed to get the next. */
    onFrame(cb: (f: BrowserSourceFrame) => void): () => void;
    ackFrame(): void;
    /** Adds the source: opens the hidden window on a public http(s) address. */
    start(url: string): Promise<IpcResult<BrowserSourceStatus>>;
    reload(): Promise<IpcResult<BrowserSourceStatus>>;
    /** Shown or hidden: a hidden page stops painting. */
    setVisible(visible: boolean): Promise<IpcResult<BrowserSourceStatus>>;
    /** Removes the source: closes the window and drops what the page stored. */
    stop(): Promise<IpcResult<BrowserSourceStatus>>;
    /**
     * Allows the next `getDisplayMedia` call of the window to receive the page's sound (and nothing else); false when
     * there is no page. The page itself stays muted on this computer.
     */
    armAudio(): Promise<IpcResult<boolean>>;
  };
  screen: {
    /** macOS screen-recording permission (always `granted` elsewhere). */
    access(): Promise<ScreenAccess>;
    /** Screens and windows with a thumbnail; fails with code `screen_denied` when macOS refuses the recording. */
    list(): Promise<IpcResult<DesktopSourceInfo[]>>;
    /** The source the next screen capture will serve (null: none). */
    select(sourceId: string | null): Promise<IpcResult<null>>;
    openSettings(): Promise<void>;
    /** Whether the shared screen's sound can be captured on this system, and why not otherwise. */
    audioSupport(): Promise<IpcResult<ScreenAudioSupport>>;
  };
}

/** Global shortcuts and local control API (Stream Deck, Companion): settings, and the actions the window runs. */
export interface ControlBridge {
  get(): Promise<IpcResult<ControlView>>;
  /** "" removes the shortcut. */
  setShortcut(action: ShortcutAction, accelerator: string): Promise<IpcResult<ControlView>>;
  setApi(enabled: boolean, port: number): Promise<IpcResult<ControlView>>;
  regenerateToken(): Promise<IpcResult<ControlView>>;
  /** Puts the API token on the system clipboard. */
  copyToken(): Promise<IpcResult<null>>;
  /** The window runs the actions asked from outside (shortcuts, local API); its answer is sent back by the preload. */
  onRequest(handler: (request: ControlRequest) => Promise<ControlResult> | ControlResult): () => void;
}

/** What the main process exposes to the UI (`window.studio`). */
/** Interface language: the choice is saved by the main process, which applies it and tells every window. */
export interface LocaleBridge {
  get(): Promise<LocaleView>;
  set(choice: LocaleChoice): Promise<IpcResult<LocaleView>>;
  onChange(cb: (v: LocaleView) => void): () => void;
}

export interface StudioBridge {
  locale: LocaleBridge;
  control: ControlBridge;
  capture: CaptureBridge;
  sources: SourcesBridge;
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
  /** Setup mode: the programme as the orchestrator composes it, before any live (contract: `docs/studio-devices.md` of the sada repository). */
  setup: {
    enter(): Promise<IpcResult<SetupState>>;
    leave(): Promise<IpcResult<null>>;
    whepOffer(sdp: string): Promise<IpcResult<{ answer: string; resource: string }>>;
    whepClose(resource: string): Promise<IpcResult<null>>;
  };
  regie: {
    get(): Promise<IpcResult<RegieData>>;
    status(): Promise<IpcResult<LiveStatus>>;
    command(cmd: string, arg?: string, transition?: TransitionMode): Promise<IpcResult<LiveStatus>>;
    setTransition(mode: TransitionMode): Promise<IpcResult<{ ok: boolean; transition: TransitionMode }>>;
    setMute(muted: boolean): Promise<IpcResult<{ ok: boolean; muted: boolean; mic_muted: boolean }>>;
    setOverlay(kind: OverlayKind, payload: Record<string, unknown>): Promise<IpcResult<OverlayUpdateResponse>>;
    /** The server-drawn overlay layer; `etag`: the copy already held (answered `changed: false` if current). */
    overlayLayer(etag: string | null): Promise<IpcResult<OverlayLayerFetch>>;
  };
}

declare global {
  interface Window {
    studio: StudioBridge;
  }
}
