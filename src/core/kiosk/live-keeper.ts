import { canStart, isActive, type SessionState } from "../session/machine";
import { Backoff, type BackoffOptions } from "./backoff";

/** What the keeper needs from the broadcast session (BroadcastSession satisfies it as is). */
export interface KeeperSession {
  readonly snapshot: { state: SessionState };
  subscribe(fn: (s: { state: SessionState }) => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface KeeperOptions {
  /** After a failure (camera, link): bounded growing delay. */
  retry: BackoffOptions;
  /** After an "already live" refusal (409): much more patient, never aggressive. */
  conflictRetry: BackoffOptions;
}

export const DEFAULT_KEEPER_OPTIONS: KeeperOptions = {
  retry: { baseMs: 5_000, maxMs: 60_000, jitter: 0.2 },
  conflictRetry: { baseMs: 60_000, maxMs: 300_000, jitter: 0.2 },
};

/**
 * Keeps the session in line with the server order: starts when we must broadcast, stops otherwise,
 * and retries after an error (camera missing, server unreachable, live already running) with growing delays.
 * It never restarts what the order no longer asks for; the decision to broadcast comes from `KioskState.wantLive`.
 */
export class LiveKeeper {
  private wanted = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly retry: Backoff;
  private readonly conflictRetry: Backoff;
  private readonly off: () => void;
  private readonly listeners = new Set<(n: { waitMs: number; at: number } | null) => void>();

  constructor(
    private readonly session: KeeperSession,
    options: KeeperOptions = DEFAULT_KEEPER_OPTIONS,
  ) {
    this.retry = new Backoff(options.retry);
    this.conflictRetry = new Backoff(options.conflictRetry);
    this.off = session.subscribe(() => this.evaluate());
  }

  /** Next announced retry (for display), or null. */
  onRetry(fn: (n: { waitMs: number; at: number } | null) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setWanted(wanted: boolean): void {
    if (wanted === this.wanted) return;
    this.wanted = wanted;
    if (wanted) {
      this.retry.reset();
      this.conflictRetry.reset();
    }
    this.evaluate();
  }

  dispose(): void {
    this.off();
    this.clear();
  }

  private clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const l of this.listeners) l(null);
  }

  private evaluate(): void {
    const state = this.session.snapshot.state;
    if (!this.wanted) {
      this.clear();
      if (state.status === "error") void this.session.stop();
      else if (isActive(state)) void this.session.stop();
      return;
    }
    if (state.status === "live") {
      this.retry.reset();
      this.conflictRetry.reset();
      this.clear();
      return;
    }
    if (this.timer) return;
    if (state.status === "idle") {
      void this.session.start();
    } else if (state.status === "error" && canStart(state)) {
      const b = state.errorCode === "conflict" ? this.conflictRetry : this.retry;
      const waitMs = b.next();
      const at = Date.now() + waitMs;
      for (const l of this.listeners) l({ waitMs, at });
      this.timer = setTimeout(() => {
        this.timer = undefined;
        for (const l of this.listeners) l(null);
        if (this.wanted && canStart(this.session.snapshot.state)) void this.session.start();
      }, waitMs);
    }
  }
}
