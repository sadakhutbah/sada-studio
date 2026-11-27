import { ApiError, DeviceRevokedError } from "../errors";
import { normalizeBaseUrl } from "../api/sada-api";
import type { DeviceCredentials, HealthCheck, HealthPayload, HeartbeatReport, StreamMeta, StudioApi } from "../api/types";
import { t } from "../messages";
import { Backoff } from "./backoff";
import { DEFAULT_KIOSK_OPTIONS, INITIAL_KIOSK, kioskTransition, pairedState, type KioskEvent, type KioskOptions, type KioskState } from "./machine";

/** Where the device identity is stored (system vault in production). */
export interface DeviceStore {
  load(): DeviceCredentials | null;
  save(device: DeviceCredentials): void;
  clear(): void;
  /** The secret survives a restart (vault available). */
  readonly persistent: boolean;
}

/** Small state to keep between two launches: "I was live", dismissed lives. */
export interface Persisted {
  wasLive: boolean;
  suppressed: string[];
}

export interface PersistStore {
  load(): Persisted;
  save(p: Persisted): void;
}

/** What the UI reports: the state of the broadcast session and of the hardware. */
export interface ClientReport {
  sessionState: string;
  camera: boolean;
  micro: boolean;
  bitrateKbps: number;
  /** Workstation checks (camera, microphone, Windows settings…), without "network", which the supervisor adds itself. */
  checks: HealthCheck[];
  lastError: { code: string; message: string } | null;
  startFailure: string | null;
}

export interface SupervisorOptions extends KioskOptions {
  version: string;
  /** Default heartbeat interval (the server may set it via config.heartbeat_interval, in seconds). */
  heartbeatMs: number;
  /** Tighter interval during a live or while arming. */
  heartbeatLiveMs: number;
  /** Delay after a failed heartbeat: growing, bounded. */
  failureBackoff: { baseMs: number; maxMs: number };
  tickMs: number;
  /** Computer name, suggested to the console at pairing time. */
  machineName: string;
  /** Minimum gap between two immediate heartbeats: a flickering camera does not hammer the server. */
  minBeatGapMs: number;
}

export const DEFAULT_SUPERVISOR_OPTIONS: SupervisorOptions = {
  ...DEFAULT_KIOSK_OPTIONS,
  version: "0.0.0",
  heartbeatMs: 30_000,
  heartbeatLiveMs: 10_000,
  failureBackoff: { baseMs: 5_000, maxMs: 120_000 },
  tickMs: 10_000,
  machineName: "",
  minBeatGapMs: 2_000,
};

export type KioskView = KioskState & {
  version: string;
  /** Restart after a live: we wait for the server order, the server remains the master. */
  resuming: boolean;
  /** The device secret is stored durably. */
  persistent: boolean;
  /** A stop could not be announced to the server yet. */
  stopPending: boolean;
  /** Broadcast session state reported by the UI (idle, live, reconnecting…). */
  reportedState: string;
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Orchestrator of the device (main process, no Electron dependency):
 * pairing by code, heartbeat loop, manual live, resume. The state lives in `kioskTransition`;
 * only the effects live here (network, timers, storage).
 * The server remains the master: the application broadcasts only when the state says `wantLive`.
 */
export class KioskSupervisor {
  private state: KioskState = INITIAL_KIOSK;
  private device: DeviceCredentials | null = null;
  private extraChecks: () => HealthCheck[] = () => [];
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
  /** Incremented on each pairing change: a late response from a past pairing is ignored. */
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

  /** Startup: resumes the stored pairing, if any. The heartbeat immediately says what to do. */
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

  /** Requests a code; the screen shows it, the console validates it. The code is renewed until someone enters it. */
  async startPairing(baseUrl: string): Promise<void> {
    if (this.device) throw new ApiError(0, t("sup.alreadyPaired"));
    const epoch = ++this.epoch;
    clearTimeout(this.pairTimer);
    const challenge = await this.api.pairing.start(baseUrl, this.o.machineName);
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
        this.dispatch({ type: "PAIRING_FAILED", code: "pair-denied", message: t("sup.pairDenied") });
        return;
      }
    } catch (e) {
      if (epoch !== this.epoch) return;
      // Network down while waiting: keep waiting, without leaving the code screen.
      if (e instanceof ApiError && e.status !== 0 && e.status >= 400 && e.status < 500 && e.status !== 408) {
        this.dispatch({ type: "PAIRING_FAILED", code: "pair-failed", message: e.message });
        return;
      }
    }
    this.schedulePoll(epoch, baseUrl, deviceCode, everyMs, expiresAt);
  }

  /** Code expired: a new one is requested automatically (nobody has to restart anything). */
  private async renew(epoch: number, baseUrl: string): Promise<void> {
    try {
      const c = await this.api.pairing.start(baseUrl, this.o.machineName);
      if (epoch !== this.epoch) return;
      const at = Date.now();
      this.dispatch({ type: "PAIRING_STARTED", baseUrl, userCode: c.userCode, expiresAt: at + c.expiresInS * 1000 });
      this.schedulePoll(epoch, baseUrl, c.deviceCode, c.intervalS * 1000, at + c.expiresInS * 1000);
    } catch {
      if (epoch !== this.epoch) return;
      // Server unreachable: retry in a few seconds; the displayed code is already stale.
      this.pairTimer = setTimeout(() => void this.renew(epoch, baseUrl), 5_000);
    }
  }

  cancelPairing(): void {
    if (this.state.phase !== "pairing") return;
    this.epoch++;
    clearTimeout(this.pairTimer);
    this.dispatch({ type: "UNPAIR" });
  }

  /** "Unpair": the server is notified (it revokes the device and cuts its stream), then the identity is forgotten here.
   *  Server unreachable: the local forgetting happens anyway; the console can remove the device under "Devices". */
  async unpair(): Promise<void> {
    const wasPaired = this.device !== null;
    this.epoch++;
    if (wasPaired) {
      try {
        await this.api.unpair();
      } catch {
        /* 401: already revoked; network: can be removed from the console */
      }
    }
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
    if (!this.device) throw new ApiError(0, t("sup.notPaired"));
    if (this.state.wantLive) throw new ApiError(409, t("api.liveActive"));
    const title = meta.title.trim();
    if (!title) throw new ApiError(0, t("sup.titleRequired"));
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

  /** Stop (manual or of a scheduled live): cut here first, then tell the server; the announcement is retried while it fails. */
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
      // 409/404: nothing left to stop on the server; any other failure is retried on the next heartbeat.
      if (e instanceof ApiError && (e.status === 404 || e.status === 409)) this.stopPending = false;
    }
    this.emit();
  }

  dismissConflict(): void {
    this.dispatch({ type: "DISMISS_CONFLICT" });
  }

  // ───── Reports from the UI ─────

  setReport(r: ClientReport): void {
    const was = this.report.sessionState;
    this.report = r;
    if (was !== r.sessionState) {
      this.persistNow();
      this.emit();
    }
    this.refreshChecks();
  }

  /**
   * Checks produced by the main process itself (the IP camera capture, …) are added to the ones the UI reports,
   * read at each heartbeat so they are never stale.
   */
  setCheckProvider(provider: () => HealthCheck[]): void {
    this.extraChecks = provider;
  }

  /** A check changes state (camera unplugged, session error, capture outage…): the server learns of it without waiting for the normal cadence. */
  refreshChecks(): void {
    const sig = this.healthSignature();
    if (sig !== this.signature) {
      const first = this.signature === "";
      this.signature = sig;
      if (!first && this.device) this.beatSoon();
    }
  }

  private allChecks(): HealthCheck[] {
    return [...this.report.checks, ...this.extraChecks()];
  }

  private healthSignature(): string {
    const r = this.report;
    const ok = this.allChecks().map((c) => `${c.id}:${c.ok ? 1 : 0}`).join(",");
    return `${ok}|${this.networkCheck().ok ? 1 : 0}|${r.lastError?.code ?? ""}|${r.startFailure ? 1 : 0}`;
  }

  /** Immediate heartbeat, honoring the minimum gap; if one is in flight, another will follow. */
  private beatSoon(): void {
    if (this.beating) {
      this.beatAgain = true;
      return;
    }
    this.rearm(Math.max(0, this.lastBeatAt + this.o.minBeatGapMs - Date.now()));
  }

  /** "network": the server answers, and the broadcast link is not in the middle of recovering. */
  private networkCheck(): HealthCheck {
    if (this.report.sessionState === "reconnecting") return { id: "network", ok: false, detail: t("sup.relayLost") };
    if (this.consecutiveFailures >= 3) {
      return { id: "network", ok: false, detail: t("sup.heartbeatsMissed", { n: this.consecutiveFailures }) };
    }
    return { id: "network", ok: true, detail: t("sup.serverReachable") };
  }

  private healthPayload(): HealthPayload {
    return {
      checks: [...this.allChecks(), this.networkCheck()],
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
      if (reply.credentials) this.adopt(device, reply.credentials);
      this.dispatch({ type: "HEARTBEAT_OK", reply, at: Date.now() });
      this.persistNow();
      const asked = Number(reply.config.heartbeat_interval);
      const base = Number.isFinite(asked) && asked > 0 ? clamp(asked * 1000, 5_000, 120_000) : this.o.heartbeatMs;
      // On air, arming, or streaming the control room's preview: beat often, so a stop is seen within seconds.
      const busy = this.state.phase === "onair" || this.state.phase === "armed" || this.state.preview;
      this.rearm(busy ? Math.min(base, this.o.heartbeatLiveMs) : base);
    } catch (e) {
      this.lastBeatAt = Date.now();
      if (this.device !== device) return;
      this.consecutiveFailures++;
      if (e instanceof DeviceRevokedError) return this.revoke(e);
      this.dispatch({ type: "HEARTBEAT_FAILED" });
      // No network: keep the current order (a live does not stop for lack of heartbeat) and retry with growing delays.
      this.rearm(this.failures.next());
    } finally {
      this.beating = false;
      if (this.beatAgain && this.consecutiveFailures === 0 && this.device === device && this.healthSignature() !== this.signature) this.beatSoon();
    }
  }

  /** Rotation requested in the console: the new secret is stored before any other call (the old one is valid for one hour only). */
  private adopt(old: DeviceCredentials, next: { deviceId: string; deviceSecret: string }): void {
    const device: DeviceCredentials = { ...old, deviceId: next.deviceId || old.deviceId, deviceSecret: next.deviceSecret };
    this.devices.save(device);
    this.device = device;
    this.api.useDevice(device);
  }

  private revoke(e: DeviceRevokedError): void {
    this.epoch++;
    this.forgetDevice();
    this.dispatch({
      type: "REVOKED",
      message: t("sup.noLongerAuthorized", { message: e.message }),
    });
    this.persistNow();
  }

  // ───── Internals ─────

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
