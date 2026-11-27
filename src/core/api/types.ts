import type { WhipSignaling } from "../transport/whip";

export type StreamKind = "khutba" | "dars" | "conference";

export interface MosqueInfo {
  name: string;
  id?: number;
  slug?: string;
}

/** What identifies the device to Sada once paired. The secret never leaves the main process. */
export interface DeviceCredentials {
  baseUrl: string;
  deviceId: string;
  deviceSecret: string;
  mosque: MosqueInfo;
}

export interface PairingChallenge {
  deviceCode: string;
  /** Short code to type in the console, e.g. "K7QM-4TZ2". */
  userCode: string;
  expiresInS: number;
  /** Recommended polling interval, in seconds. */
  intervalS: number;
}

export type PairPoll =
  | { status: "pending" }
  | { status: "paired"; deviceId: string; deviceSecret: string; mosque: MosqueInfo }
  | { status: "expired" }
  | { status: "denied" };

/** A schedule slot (times in ms since the epoch). */
export interface Slot {
  id?: string;
  type: StreamKind;
  title: string;
  startsAt: number;
  endsAt: number | null;
}

export type LiveSource = "manual" | "schedule";

export interface CurrentLive {
  type: StreamKind;
  title: string;
  source: LiveSource;
  slotId?: string;
}

export type LiveOrder = "idle" | "live";

/** A workstation check as the server receives it (stable ids: camera, micro, network, windows_autologon…). */
export interface HealthCheck {
  id: string;
  ok: boolean;
  detail: string;
}

/** Detailed health attached to each heartbeat; the server uses it to e-mail the operators. */
export interface HealthPayload {
  checks: HealthCheck[];
  /** Last error of the broadcast session (kept until the next successful live). */
  last_error: { code: string; message: string } | null;
  /** The requested live could not start (set until it has started). */
  live_start_failure: { message: string } | null;
}

/** What the device reports about itself on each heartbeat. */
export interface HeartbeatReport {
  state: string;
  version: string;
  camera: boolean;
  micro: boolean;
  /** kbit/s currently being sent. */
  bitrate: number;
  health: HealthPayload;
}

/** New device credential issued by the server after a rotation requested in the console. */
export interface RotatedCredentials {
  deviceId: string;
  deviceSecret: string;
}

export interface HeartbeatReply {
  config: Record<string, unknown>;
  /** Present only when the console requested a rotation: store it and use it right away. */
  credentials?: RotatedCredentials;
  schedule: Slot[];
  command: LiveOrder;
  current: CurrentLive | null;
  /**
   * The web control room asks for this device's picture, outside a live: publish the programme to `previewWhip`
   * while it stays true. Nothing of it is broadcast (the server's preview path is read by the control room only).
   */
  preview?: boolean;
}

export interface StreamMeta {
  type: StreamKind;
  title: string;
}

export type TransitionMode = "fade" | "cut";
export type OverlayCorner = "tl" | "tr" | "bl" | "br";
export type OverlayKind = "qr" | "banner" | "logo";

export interface LiveOverlays {
  qr: { visible: boolean; url: string; label: string; corner: OverlayCorner };
  banner: { visible: boolean; title: string; subtitle: string };
  logo: { visible: boolean };
}

/**
 * A programme picture (mosque logo, scene image) revalidated by ETag. `changed: false`: the copy the client holds is
 * still current (304). `png: null`: the server has none (404: no logo configured, unknown scene).
 */
export type AssetFetch = { changed: false } | { changed: true; etag: string; png: Uint8Array | null };

/**
 * A screen of the mosque's imported template (`GET /api/v1/studio/live/screen/{ecran}`, CONTRACT.md):
 * `source: "gabarit"` → `html` is the page of that screen (fonts inlined, scripts removed, placeholders NOT filled),
 * `values` the variables to put in it, `countdown` the variable the studio updates every second;
 * `source: "engine"` → no template for it, `html` is null and the studio uses the engine's picture (`png`).
 * `transparent`: a banner over the camera (transparent background) rather than an opaque full screen.
 */
export interface ScreenDescriptor {
  source: "gabarit" | "engine";
  html: string | null;
  values: Record<string, string>;
  countdown: { variable: string; target: string } | null;
  transparent: boolean;
  png: string;
}

/** `screen: null`: the server has no such screen (404). */
export type ScreenFetch = { changed: false } | { changed: true; etag: string; screen: ScreenDescriptor | null };

export interface LiveStatus {
  reachable?: boolean;
  ok?: boolean;
  state?: string;
  scene?: string;
  override?: boolean;
  transition?: TransitionMode;
  overlays?: LiveOverlays;
  mic?: boolean;
  mic_muted?: boolean;
  audio_level_db?: number | null;
  message?: string;
  /** Monotonic counter bumped by the orchestrator on every state change; absent on older servers. */
  rev?: number;
  /** Who composes the programme: this studio ("studio") or the orchestrator ("server"). */
  compositing?: Compositing;
}

export type Compositing = "studio" | "server";
/** How a scene is drawn: camera alone, camera under the scene's banner, or full screen (camera hidden). */
export type SceneKind = "camera" | "banner" | "full";

/** Where the orchestrator stands for the setup view: asleep and being woken, answering, or not coming. */
export type SetupOrchestrator = "waking" | "ready" | "unreachable";

/**
 * Answer of `POST /studio/setup` (`docs/studio-devices.md` of the sada repository): the lease, whether the orchestrator answers, whether a
 * real live is on air (the programme view is then the real broadcast) and whether the programme can be watched.
 * Protocol data only: the application writes its own sentences.
 */
export interface SetupState {
  active: boolean;
  /** Seconds before the lease lapses if it is not renewed. */
  expiresIn: number;
  orchestrator: SetupOrchestrator;
  live: boolean;
  /** The rehearsal programme is being composed (nothing goes to a destination). */
  rehearsing: boolean;
  /** The server has a monitoring copy to offer (false: no programme view possible). */
  available: boolean;
  /** The relay has the programme picture; `null` when it does not say. */
  program: boolean | null;
}

export interface RegieScene {
  id: string;
  kind: "camera" | "slate" | "custom";
  label: string;
  custom?: boolean;
  category?: string;
  slug?: string;
  preview_url?: string;
  scene_kind?: SceneKind;
}

export interface RegieAudioState {
  mic_on: boolean;
  muted: boolean;
  level_db: number | null;
}

export interface RegieData {
  mosque?: string;
  slug?: string;
  status: LiveStatus;
  transition?: TransitionMode;
  scenes?: RegieScene[];
  audio?: RegieAudioState;
  commands?: string[];
  extend_minutes?: string[];
  overlays?: LiveOverlays;
}

export interface OverlayUpdateResponse extends LiveStatus {
  ok: boolean;
  overlays: LiveOverlays;
}

/** Answer of the transition and mute commands (newer servers add the full state and its `rev`). */
export interface TransitionResponse extends LiveStatus {
  ok: boolean;
  transition: TransitionMode;
}
export interface MuteResponse extends LiveStatus {
  ok: boolean;
  muted: boolean;
  mic_muted: boolean;
}

export interface StudioConfigResponse {
  mosque: MosqueInfo;
  config?: Record<string, unknown>;
}

export interface PairingApi {
  /** `machineName`: computer name, suggested to the console as the device name. */
  start(baseUrl: string, machineName?: string): Promise<PairingChallenge>;
  poll(baseUrl: string, deviceCode: string): Promise<PairPoll>;
}

/**
 * Surface of the Sada API used by the device. The server contract is `docs/studio-devices.md` of the sada repository
 * (single source of truth): the wire format exists only in `SadaHttpApi`; the rest of the application never sees it.
 */
export interface StudioApi {
  readonly pairing: PairingApi;
  /** Device identity for subsequent calls; `null` forgets it. */
  useDevice(device: DeviceCredentials | null): void;
  heartbeat(report: HeartbeatReport): Promise<HeartbeatReply>;
  /** Manual live, outside the schedule. 409: a live is already running. */
  startLive(meta: StreamMeta): Promise<void>;
  stopLive(): Promise<void>;
  /** The device leaves the mosque by itself; the server revokes its identity. */
  unpair(): Promise<void>;
  readonly whip: WhipSignaling;
  /** WHIP of the preview the web control room asked for (refused with 409 when nobody asks any more). */
  readonly previewWhip: WhipSignaling;
}
