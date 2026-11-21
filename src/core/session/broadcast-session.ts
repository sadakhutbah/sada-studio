import { FatalError } from "../errors";
import { BitrateEstimator } from "../stats";
import type { MediaSourceStrategy, SourceOptions } from "../sources/types";
import type { ConnectOptions, Transport, TransportFactory, TransportStats } from "../transport/types";
import { SessionMachine, canStart, type SessionState } from "./machine";

export interface SessionDeps {
  source: MediaSourceStrategy;
  transportFactory: TransportFactory;
  /** Horloge (ms) ; injectable pour les tests. */
  now?: () => number;
  /** Attente avant la n-ième tentative de reconnexion (ms). */
  backoffMs?: (attempt: number) => number;
  maxAttempts?: number;
  statsIntervalMs?: number;
  connect?: ConnectOptions;
}

export interface LiveStats {
  bitrateKbps: number;
  rttMs?: number;
  fps?: number;
}

export interface SessionSnapshot {
  state: SessionState;
  stats: LiveStats;
}

/** 1 s, 2 s, 4 s, 8 s puis 15 s. */
export const defaultBackoff = (attempt: number) => Math.min(15_000, 1000 * 2 ** (attempt - 1));

/**
 * Orchestre une diffusion : machine d'état + stratégie de source + stratégie de transport.
 * Reconnexion automatique : le flux capturé est conservé, seule la liaison est refaite.
 * La session ne libère jamais la source : l'aperçu continue après l'arrêt (c'est au propriétaire de `release`).
 */
export class BroadcastSession {
  private readonly machine: SessionMachine;
  private readonly now: () => number;
  private readonly backoff: (attempt: number) => number;
  private readonly listeners = new Set<(s: SessionSnapshot) => void>();
  private transport: Transport | null = null;
  private stream: MediaStream | null = null;
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly bitrate = new BitrateEstimator();
  private stats: LiveStats = { bitrateKbps: 0 };
  private offEnded: (() => void) | null = null;
  /** Incrémenté à chaque start/stop : une réponse tardive d'une génération révolue est ignorée. */
  private generation = 0;

  constructor(private readonly deps: SessionDeps) {
    this.now = deps.now ?? Date.now;
    this.backoff = deps.backoffMs ?? defaultBackoff;
    this.machine = new SessionMachine({ maxAttempts: deps.maxAttempts ?? 40 });
    this.machine.subscribe(() => this.emit());
  }

  get snapshot(): SessionSnapshot {
    return { state: this.machine.state, stats: this.stats };
  }

  subscribe(fn: (s: SessionSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async start(source: SourceOptions): Promise<void> {
    if (!canStart(this.machine.state)) return;
    const gen = ++this.generation;
    this.machine.send({ type: "START" });
    try {
      const stream = await this.deps.source.acquire(source);
      if (gen !== this.generation) return;
      this.stream = stream;
      this.offEnded?.();
      this.offEnded = this.deps.source.onEnded(() => this.fail("La caméra ou le micro a été déconnecté."));
      await this.openTransport(stream);
      if (gen !== this.generation) return;
      this.machine.send({ type: "CONNECTED", at: this.now() });
      this.startStats();
    } catch (e) {
      if (gen !== this.generation) return;
      await this.teardown();
      this.machine.send({ type: "FATAL", reason: messageOf(e) });
    }
  }

  async stop(): Promise<void> {
    const s = this.machine.state.status;
    if (s === "idle" || s === "stopping") return;
    if (s === "error") {
      this.machine.send({ type: "RESET" });
      return;
    }
    this.generation++;
    this.machine.send({ type: "STOP" });
    await this.teardown();
    this.machine.send({ type: "STOPPED" });
  }

  private async openTransport(stream: MediaStream): Promise<void> {
    const t = this.deps.transportFactory();
    this.transport = t;
    t.onLost((reason) => this.onLost(t, reason));
    await t.connect(stream, this.deps.connect);
  }

  private onLost(t: Transport, reason: string) {
    if (t !== this.transport || this.machine.state.status !== "live") return;
    this.machine.send({ type: "CONNECTION_LOST", reason });
    this.stopStats();
    this.scheduleRetry();
  }

  private scheduleRetry() {
    const { attempt } = this.machine.state;
    const gen = this.generation;
    this.retryTimer = setTimeout(() => void this.retry(gen), this.backoff(attempt));
  }

  private async retry(gen: number) {
    if (gen !== this.generation || this.machine.state.status !== "reconnecting" || !this.stream) return;
    await this.transport?.close().catch(() => undefined);
    try {
      await this.openTransport(this.stream);
      if (gen !== this.generation) return;
      this.machine.send({ type: "CONNECTED", at: this.now() });
      this.startStats();
    } catch (e) {
      if (gen !== this.generation) return;
      if (e instanceof FatalError) {
        await this.teardown();
        this.machine.send({ type: "FATAL", reason: e.message });
        return;
      }
      this.machine.send({ type: "RETRY_FAILED", reason: messageOf(e) });
      if (this.machine.state.status === "reconnecting") this.scheduleRetry();
      else await this.teardown();
    }
  }

  private fail(reason: string) {
    if (this.machine.state.status === "idle") return;
    this.generation++;
    void this.teardown().then(() => this.machine.send({ type: "FATAL", reason }));
  }

  private startStats() {
    this.stopStats();
    this.bitrate.reset();
    const every = this.deps.statsIntervalMs ?? 1000;
    this.statsTimer = setInterval(() => void this.pollStats(), every);
  }

  private stopStats() {
    clearInterval(this.statsTimer);
    this.statsTimer = undefined;
    this.stats = { bitrateKbps: 0 };
    this.emit();
  }

  private async pollStats() {
    const t = this.transport;
    if (!t || this.machine.state.status !== "live") return;
    let raw: TransportStats;
    try {
      raw = await t.getStats();
    } catch {
      return;
    }
    if (t !== this.transport) return;
    this.stats = { bitrateKbps: this.bitrate.sample(raw.bytesSent, this.now()), rttMs: raw.rttMs, fps: raw.fps };
    this.emit();
  }

  private async teardown() {
    clearTimeout(this.retryTimer);
    this.stopStats();
    this.offEnded?.();
    this.offEnded = null;
    const t = this.transport;
    this.transport = null;
    await t?.close().catch(() => undefined);
  }

  private emit() {
    const snap = this.snapshot;
    for (const l of this.listeners) l(snap);
  }
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
