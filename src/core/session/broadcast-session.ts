import { FatalError } from "../errors";
import { t } from "../messages";
import { BitrateEstimator } from "../stats";
import type { MediaSourceStrategy, SourceOptions } from "../sources/types";
import type { ConnectOptions, Transport, TransportFactory, TransportStats } from "../transport/types";
import { SessionMachine, canStart, type SessionState } from "./machine";

export interface SessionDeps {
  source: MediaSourceStrategy;
  transportFactory: TransportFactory;
  /** Clock (ms); injectable for tests. */
  now?: () => number;
  /** Delay before the n-th reconnection attempt (ms). */
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
 * Orchestrates a broadcast: state machine + source strategy + transport strategy.
 * Automatic reconnection: the captured stream is kept, only the link is rebuilt.
 * The session never releases the source: the preview continues after the stop (the owner calls `release`).
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
  private offStreamChange: (() => void) | null = null;
  /** Incremented on each start/stop: a late response from a past generation is ignored. */
  private generation = 0;

  private connectOptions: ConnectOptions | undefined;

  constructor(private readonly deps: SessionDeps) {
    this.connectOptions = deps.connect;
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
      this.offEnded = this.deps.source.onEnded(() => this.fail(t("session.deviceLost")));
      this.offStreamChange?.();
      this.offStreamChange = this.deps.source.onStreamChange?.((s) => void this.applyStream(s)) ?? null;
      await this.openTransport(stream);
      if (gen !== this.generation) return;
      this.machine.send({ type: "CONNECTED", at: this.now() });
      this.startStats();
    } catch (e) {
      if (gen !== this.generation) return;
      await this.teardown();
      this.machine.send({ type: "FATAL", reason: messageOf(e), code: e instanceof FatalError ? e.code : undefined });
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

  /**
   * Changes what is broadcast while live (shared screen on or off, web source shown or hidden): the source is acquired
   * again with the new options and its tracks replace the senders' tracks. The WHIP connection is never closed.
   */
  async swapSource(source: SourceOptions): Promise<void> {
    if (!this.stream || (this.machine.state.status !== "live" && this.machine.state.status !== "reconnecting")) return;
    const gen = this.generation;
    const stream = await this.deps.source.acquire(source);
    if (gen !== this.generation) return;
    await this.applyStream(stream);
  }

  private async applyStream(stream: MediaStream): Promise<void> {
    if (!this.stream) return;
    this.stream = stream; // a reconnection then starts from the current media
    await this.transport?.replaceTracks?.(stream).catch(() => undefined);
  }

  private async openTransport(stream: MediaStream): Promise<void> {
    const t = this.deps.transportFactory();
    this.transport = t;
    t.onLost((reason) => this.onLost(t, reason));
    await t.connect(stream, this.connectOptions);
  }

  /** Quality announced by the server: applied at the next connection (a live in progress keeps its own). */
  setConnectOptions(options: ConnectOptions): void {
    this.connectOptions = { ...this.deps.connect, ...options };
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
        this.machine.send({ type: "FATAL", reason: e.message, code: e.code });
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
    this.offStreamChange?.();
    this.offStreamChange = null;
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
