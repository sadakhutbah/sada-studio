import type { WhipSignaling } from "../transport/whip";

export type StreamKind = "khutba" | "dars";

export interface MosqueInfo {
  name: string;
  id?: number;
  slug?: string;
}

/** Ce qui identifie l'appareil auprès de Sada une fois appairé. Le secret ne quitte jamais le processus principal. */
export interface DeviceCredentials {
  baseUrl: string;
  deviceId: string;
  deviceSecret: string;
  mosque: MosqueInfo;
}

export interface PairingChallenge {
  deviceCode: string;
  /** Code court à saisir dans la console, ex. « K7QM-4TZ2 ». */
  userCode: string;
  expiresInS: number;
  /** Intervalle d'interrogation conseillé, en secondes. */
  intervalS: number;
}

export type PairPoll =
  | { status: "pending" }
  | { status: "paired"; deviceId: string; deviceSecret: string; mosque: MosqueInfo }
  | { status: "expired" }
  | { status: "denied" };

/** Un créneau du planning (heures en ms depuis l'époque). */
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

/** Un contrôle du poste, tel que le serveur le reçoit (identifiants stables : camera, micro, network, windows_autologon…). */
export interface HealthCheck {
  id: string;
  ok: boolean;
  detail: string;
}

/** Santé détaillée jointe à chaque battement ; le serveur s'en sert pour prévenir les opérateurs par e-mail. */
export interface HealthPayload {
  checks: HealthCheck[];
  /** Dernière erreur de la session d'émission (conservée jusqu'au prochain direct réussi). */
  last_error: { code: string; message: string } | null;
  /** Le direct demandé n'a pas pu démarrer (en cours tant qu'il n'a pas démarré). */
  live_start_failure: { message: string } | null;
}

/** Ce que l'appareil dit de lui à chaque battement. */
export interface HeartbeatReport {
  state: string;
  version: string;
  camera: boolean;
  micro: boolean;
  /** kbit/s envoyés en ce moment. */
  bitrate: number;
  health: HealthPayload;
}

export interface HeartbeatReply {
  config: Record<string, unknown>;
  schedule: Slot[];
  command: LiveOrder;
  current: CurrentLive | null;
}

export interface StreamMeta {
  type: StreamKind;
  title: string;
}

export interface PairingApi {
  start(baseUrl: string): Promise<PairingChallenge>;
  poll(baseUrl: string, deviceCode: string): Promise<PairPoll>;
}

/**
 * Surface de l'API Sada utilisée par le boîtier. Le contrat serveur (branche feat/studio-devices) est provisoire :
 * tout ajustement de forme ne touche que `SadaHttpApi`.
 */
export interface StudioApi {
  readonly pairing: PairingApi;
  /** Identité de l'appareil pour les appels suivants ; `null` l'oublie. */
  useDevice(device: DeviceCredentials | null): void;
  heartbeat(report: HeartbeatReport): Promise<HeartbeatReply>;
  /** Direct manuel, hors planning. 409 : un direct est déjà en cours. */
  startLive(meta: StreamMeta): Promise<void>;
  stopLive(): Promise<void>;
  readonly whip: WhipSignaling;
}
