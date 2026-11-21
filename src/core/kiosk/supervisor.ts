import { ApiError, DeviceRevokedError } from "../errors";
import { normalizeBaseUrl } from "../api/sada-api";
import type { DeviceCredentials, HealthCheck, HealthPayload, HeartbeatReport, StreamMeta, StudioApi } from "../api/types";
import { Backoff } from "./backoff";
import { DEFAULT_KIOSK_OPTIONS, INITIAL_KIOSK, kioskTransition, pairedState, type KioskEvent, type KioskOptions, type KioskState } from "./machine";

/** Où l'identité de l'appareil est rangée (coffre du système en production). */
export interface DeviceStore {
  load(): DeviceCredentials | null;
  save(device: DeviceCredentials): void;
  clear(): void;
  /** Le secret survit à un redémarrage (coffre disponible). */
  readonly persistent: boolean;
}

/** Petit état à conserver entre deux lancements : « j'étais en direct », directs écartés. */
export interface Persisted {
  wasLive: boolean;
  suppressed: string[];
}

export interface PersistStore {
  load(): Persisted;
  save(p: Persisted): void;
}

/** Ce que l'interface rapporte : l'état de la session d'émission et du matériel. */
export interface ClientReport {
  sessionState: string;
  camera: boolean;
  micro: boolean;
  bitrateKbps: number;
  /** Contrôles du poste (caméra, micro, réglages Windows…), sans « network » que le superviseur ajoute lui-même. */
  checks: HealthCheck[];
  lastError: { code: string; message: string } | null;
  startFailure: string | null;
}

export interface SupervisorOptions extends KioskOptions {
  version: string;
  /** Cadence de battement par défaut (le serveur peut la fixer via config.heartbeat_interval, en secondes). */
  heartbeatMs: number;
  /** Cadence plus serrée pendant un direct ou l'armement. */
  heartbeatLiveMs: number;
  /** Attente après échec de battement : croissante, bornée. */
  failureBackoff: { baseMs: number; maxMs: number };
  tickMs: number;
  /** Écart minimal entre deux battements immédiats : une caméra qui clignote ne harcèle pas le serveur. */
  minBeatGapMs: number;
}

export const DEFAULT_SUPERVISOR_OPTIONS: SupervisorOptions = {
  ...DEFAULT_KIOSK_OPTIONS,
  version: "0.0.0",
  heartbeatMs: 30_000,
  heartbeatLiveMs: 10_000,
  failureBackoff: { baseMs: 5_000, maxMs: 120_000 },
  tickMs: 10_000,
  minBeatGapMs: 2_000,
};

export type KioskView = KioskState & {
  version: string;
  /** Redémarrage après un direct : on attend l'ordre du serveur, qui reste maître. */
  resuming: boolean;
  /** Le secret de l'appareil est gardé de façon durable. */
  persistent: boolean;
  /** Un arrêt n'a pas encore pu être annoncé au serveur. */
  stopPending: boolean;
  /** État de la session d'émission rapporté par l'interface (idle, live, reconnecting…). */
  reportedState: string;
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Chef d'orchestre du boîtier (processus principal, sans dépendance à Electron) :
 * appairage par code, boucle de battement, direct manuel, reprise. L'état vit dans `kioskTransition` ;
 * ici seulement les effets (réseau, minuteries, rangement).
 * Le serveur reste maître : l'application n'émet que lorsque l'état dit `wantLive`.
 */
export class KioskSupervisor {
  private state: KioskState = INITIAL_KIOSK;
  private device: DeviceCredentials | null = null;
  private report: ClientReport = { sessionState: "idle", camera: false, micro: false, bitrateKbps: 0, checks: [], lastError: null, startFailure: null };
  private lastBeatAt = 0;
  private beating = false;
  private beatAgain = false;
  private consecutiveFailures = 0;
  private signature = "";
  private resuming = false;
  private stopPending = false;
  private readonly listeners = new Set<(v: KioskView) => void>();
  private readonly failures: Backoff;
  private hbTimer: ReturnType<typeof setTimeout> | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private pairTimer: ReturnType<typeof setTimeout> | undefined;
  /** Incrémenté à chaque changement d'appairage : une réponse tardive d'un appairage révolu est ignorée. */
  private epoch = 0;
  private readonly o: SupervisorOptions;

  constructor(
    private readonly api: StudioApi,
    private readonly devices: DeviceStore,
    private readonly persist: PersistStore,
    options: Partial<SupervisorOptions> = {},
  ) {
    this.o = { ...DEFAULT_SUPERVISOR_OPTIONS, ...options };
    this.failures = new Backoff({ ...this.o.failureBackoff, jitter: 0.2 });
  }

  get view(): KioskView {
    return { ...this.state, version: this.o.version, resuming: this.resuming, persistent: this.devices.persistent, stopPending: this.stopPending, reportedState: this.report.sessionState };
  }

  subscribe(fn: (v: KioskView) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Démarrage : reprend l'appairage mémorisé, s'il y en a un. Le battement dit aussitôt ce qu'il faut faire. */
  boot(): void {
    const saved = this.persist.load();
    const device = this.devices.load();
    this.resuming = saved.wasLive && device !== null;
    if (device) {
      this.device = device;
      this.api.useDevice(device);
      this.state = pairedState(device.mosque, device.baseUrl, saved.suppressed);
      this.emit();
      this.startLoops(0);
    } else {
      this.state = { ...INITIAL_KIOSK };
      this.emit();
    }
  }

  dispose(): void {
    this.epoch++;
    this.stopLoops();
    clearTimeout(this.pairTimer);
  }

  // ───── Appairage ─────

  /** Demande un code ; l'écran l'affiche, la console le valide. Le code est renouvelé tant que personne ne le saisit. */
  async startPairing(baseUrl: string): Promise<void> {
    if (this.device) throw new ApiError(0, "Cet appareil est déjà appairé.");
    const epoch = ++this.epoch;
    clearTimeout(this.pairTimer);
    const challenge = await this.api.pairing.start(baseUrl);
    if (epoch !== this.epoch) return;
    const at = Date.now();
    this.dispatch({ type: "PAIRING_STARTED", baseUrl, userCode: challenge.userCode, expiresAt: at + challenge.expiresInS * 1000 });
    this.schedulePoll(epoch, baseUrl, challenge.deviceCode, challenge.intervalS * 1000, at + challenge.expiresInS * 1000);
  }

  private schedulePoll(epoch: number, baseUrl: string, deviceCode: string, everyMs: number, expiresAt: number): void {
    this.pairTimer = setTimeout(() => void this.pollOnce(epoch, baseUrl, deviceCode, everyMs, expiresAt), everyMs);
  }

  private async pollOnce(epoch: number, baseUrl: string, deviceCode: string, everyMs: number, expiresAt: number): Promise<void> {
    if (epoch !== this.epoch) return;
    if (Date.now() >= expiresAt) return this.renew(epoch, baseUrl);
    try {
      const r = await this.api.pairing.poll(baseUrl, deviceCode);
      if (epoch !== this.epoch) return;
      if (r.status === "paired") {
        const device: DeviceCredentials = { baseUrl: normalizeBaseUrl(baseUrl), deviceId: r.deviceId, deviceSecret: r.deviceSecret, mosque: r.mosque };
        this.devices.save(device);
        this.device = device;
        this.api.useDevice(device);
        this.dispatch({ type: "PAIRED", mosque: r.mosque, at: Date.now() });
        this.startLoops(0);
        return;
      }
      if (r.status === "expired") return this.renew(epoch, baseUrl);
      if (r.status === "denied") {
        this.dispatch({ type: "PAIRING_FAILED", code: "pair-denied", message: "La demande a été refusée dans la console Sada. Relancez l'appairage pour obtenir un nouveau code." });
        return;
      }
    } catch (e) {
      if (epoch !== this.epoch) return;
      // Réseau coupé pendant l'attente : on continue d'attendre, sans quitter l'écran du code.
      if (e instanceof ApiError && e.status !== 0 && e.status >= 400 && e.status < 500 && e.status !== 408) {
        this.dispatch({ type: "PAIRING_FAILED", code: "pair-failed", message: e.message });
        return;
      }
    }
    this.schedulePoll(epoch, baseUrl, deviceCode, everyMs, expiresAt);
  }

  /** Code expiré : un nouveau est demandé tout seul (personne n'a à relancer quoi que ce soit). */
  private async renew(epoch: number, baseUrl: string): Promise<void> {
    try {
      const c = await this.api.pairing.start(baseUrl);
      if (epoch !== this.epoch) return;
      const at = Date.now();
      this.dispatch({ type: "PAIRING_STARTED", baseUrl, userCode: c.userCode, expiresAt: at + c.expiresInS * 1000 });
      this.schedulePoll(epoch, baseUrl, c.deviceCode, c.intervalS * 1000, at + c.expiresInS * 1000);
    } catch {
      if (epoch !== this.epoch) return;
      // Serveur injoignable : on réessaie dans quelques secondes ; le code affiché est déjà périmé.
      this.pairTimer = setTimeout(() => void this.renew(epoch, baseUrl), 5_000);
    }
  }

  cancelPairing(): void {
    if (this.state.phase !== "pairing") return;
    this.epoch++;
    clearTimeout(this.pairTimer);
    this.dispatch({ type: "UNPAIR" });
  }

  /** « Désappairer » : l'identité est oubliée ici ; le retrait côté console se fait dans « Appareils ». */
  unpair(): void {
    this.epoch++;
    this.forgetDevice();
    this.dispatch({ type: "UNPAIR" });
    this.persistNow();
  }

  private forgetDevice(): void {
    this.stopLoops();
    this.devices.clear();
    this.device = null;
    this.api.useDevice(null);
    this.stopPending = false;
    this.resuming = false;
  }

  // ───── Direct manuel ─────

  async startManual(meta: StreamMeta): Promise<void> {
    if (!this.device) throw new ApiError(0, "Cet appareil n'est pas appairé.");
    if (this.state.wantLive) throw new ApiError(409, "Un direct est déjà en cours.");
    const title = meta.title.trim();
    if (!title) throw new ApiError(0, "Saisissez un titre pour le direct.");
    try {
      await this.api.startLive({ type: meta.type, title });
    } catch (e) {
      if (e instanceof DeviceRevokedError) return this.revoke(e);
      if (e instanceof ApiError && e.status === 409) this.dispatch({ type: "MANUAL_REFUSED", message: e.message, at: Date.now() });
      throw e;
    }
    this.dispatch({ type: "MANUAL_STARTED", kind: meta.type, title, at: Date.now() });
    this.persistNow();
    this.rearm(0);
  }

  /** Arrêt (manuel ou d'un direct planifié) : coupe ici d'abord, puis le dit au serveur ; l'annonce est reprise tant qu'elle échoue. */
  async stopLive(): Promise<void> {
    this.dispatch({ type: "STOP_REQUESTED", at: Date.now() });
    this.persistNow();
    this.stopPending = true;
    this.emit();
    await this.flushStop();
  }

  private async flushStop(): Promise<void> {
    if (!this.stopPending || !this.device) return;
    try {
      await this.api.stopLive();
      this.stopPending = false;
    } catch (e) {
      if (e instanceof DeviceRevokedError) return this.revoke(e);
      // 409/404 : plus rien à arrêter côté serveur ; tout autre échec sera repris au prochain battement.
      if (e instanceof ApiError && (e.status === 404 || e.status === 409)) this.stopPending = false;
    }
    this.emit();
  }

  dismissConflict(): void {
    this.dispatch({ type: "DISMISS_CONFLICT" });
  }

  // ───── Rapports de l'interface ─────

  setReport(r: ClientReport): void {
    const was = this.report.sessionState;
    this.report = r;
    if (was !== r.sessionState) {
      this.persistNow();
      this.emit();
    }
    // Un contrôle change d'état (caméra débranchée, erreur de session…) : le serveur l'apprend sans attendre le rythme normal.
    const sig = this.healthSignature();
    if (sig !== this.signature) {
      const first = this.signature === "";
      this.signature = sig;
      if (!first && this.device) this.beatSoon();
    }
  }

  private healthSignature(): string {
    const r = this.report;
    const ok = r.checks.map((c) => `${c.id}:${c.ok ? 1 : 0}`).join(",");
    return `${ok}|${this.networkCheck().ok ? 1 : 0}|${r.lastError?.code ?? ""}|${r.startFailure ? 1 : 0}`;
  }

  /** Battement immédiat, en respectant l'écart minimal ; si un battement est en route, un autre suivra. */
  private beatSoon(): void {
    if (this.beating) {
      this.beatAgain = true;
      return;
    }
    this.rearm(Math.max(0, this.lastBeatAt + this.o.minBeatGapMs - Date.now()));
  }

  /** « network » : le serveur répond, et la liaison d'émission n'est pas en train de se rétablir. */
  private networkCheck(): HealthCheck {
    if (this.report.sessionState === "reconnecting") return { id: "network", ok: false, detail: "La liaison avec le relais est coupée : reconnexion en cours." };
    if (this.consecutiveFailures >= 3) {
      return { id: "network", ok: false, detail: `Le serveur Sada n'a pas répondu à ${this.consecutiveFailures} battements de suite.` };
    }
    return { id: "network", ok: true, detail: "Serveur Sada joignable." };
  }

  private healthPayload(): HealthPayload {
    return {
      checks: [...this.report.checks, this.networkCheck()],
      last_error: this.report.lastError,
      live_start_failure: this.report.startFailure ? { message: this.report.startFailure } : null,
    };
  }

  // ───── Battement ─────

  private startLoops(firstDelayMs: number): void {
    this.stopLoops();
    this.failures.reset();
    this.tickTimer = setInterval(() => this.dispatch({ type: "TICK", at: Date.now() }), this.o.tickMs);
    this.rearm(firstDelayMs);
  }

  private stopLoops(): void {
    clearTimeout(this.hbTimer);
    clearInterval(this.tickTimer);
    this.hbTimer = undefined;
    this.tickTimer = undefined;
  }

  private rearm(delayMs: number): void {
    if (!this.device) return;
    clearTimeout(this.hbTimer);
    this.hbTimer = setTimeout(() => void this.beat(), delayMs);
  }

  private async beat(): Promise<void> {
    const device = this.device;
    if (!device) return;
    const body: HeartbeatReport = {
      state: this.report.sessionState,
      version: this.o.version,
      camera: this.report.camera,
      micro: this.report.micro,
      bitrate: Math.round(this.report.bitrateKbps),
      health: this.healthPayload(),
    };
    this.beating = true;
    this.beatAgain = false;
    this.signature = this.healthSignature();
    try {
      await this.flushStop();
      const reply = await this.api.heartbeat(body);
      this.lastBeatAt = Date.now();
      if (this.device !== device) return;
      this.failures.reset();
      this.consecutiveFailures = 0;
      this.resuming = false;
      this.dispatch({ type: "HEARTBEAT_OK", reply, at: Date.now() });
      this.persistNow();
      const asked = Number(reply.config.heartbeat_interval);
      const base = Number.isFinite(asked) && asked > 0 ? clamp(asked * 1000, 5_000, 120_000) : this.o.heartbeatMs;
      const busy = this.state.phase === "onair" || this.state.phase === "armed";
      this.rearm(busy ? Math.min(base, this.o.heartbeatLiveMs) : base);
    } catch (e) {
      this.lastBeatAt = Date.now();
      if (this.device !== device) return;
      this.consecutiveFailures++;
      if (e instanceof DeviceRevokedError) return this.revoke(e);
      this.dispatch({ type: "HEARTBEAT_FAILED" });
      // Pas de réseau : on garde l'ordre en cours (un direct ne s'arrête pas faute de battement) et on réessaie en s'espaçant.
      this.rearm(this.failures.next());
    } finally {
      this.beating = false;
      if (this.beatAgain && this.consecutiveFailures === 0 && this.device === device && this.healthSignature() !== this.signature) this.beatSoon();
    }
  }

  private revoke(e: DeviceRevokedError): void {
    this.epoch++;
    this.forgetDevice();
    this.dispatch({
      type: "REVOKED",
      message: `${e.message} Cet appareil n'est plus autorisé : appairez-le de nouveau depuis la console Sada, rubrique Appareils.`,
    });
    this.persistNow();
  }

  // ───── Mécanique ─────

  private dispatch(e: KioskEvent): void {
    const next = kioskTransition(this.state, e, this.o);
    if (next === this.state) return;
    this.state = next;
    this.emit();
  }

  private persistNow(): void {
    const live = this.report.sessionState === "live" || this.report.sessionState === "connecting" || this.report.sessionState === "reconnecting";
    this.persist.save({ wasLive: live && this.state.wantLive, suppressed: this.state.suppressed });
  }

  private emit(): void {
    const v = this.view;
    for (const l of this.listeners) l(v);
  }
}
