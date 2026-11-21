import { canStart, isActive, type SessionState } from "../session/machine";
import { Backoff, type BackoffOptions } from "./backoff";

/** Ce dont le gardien a besoin de la session d'émission (BroadcastSession y répond telle quelle). */
export interface KeeperSession {
  readonly snapshot: { state: SessionState };
  subscribe(fn: (s: { state: SessionState }) => void): () => void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface KeeperOptions {
  /** Après un échec (caméra, liaison) : attente croissante bornée. */
  retry: BackoffOptions;
  /** Après un refus « déjà en direct » (409) : bien plus patient, jamais agressif. */
  conflictRetry: BackoffOptions;
}

export const DEFAULT_KEEPER_OPTIONS: KeeperOptions = {
  retry: { baseMs: 5_000, maxMs: 60_000, jitter: 0.2 },
  conflictRetry: { baseMs: 60_000, maxMs: 300_000, jitter: 0.2 },
};

/**
 * Fait coller la session à l'ordre du serveur : démarre quand on doit émettre, arrête sinon,
 * et réessaie après une erreur (caméra absente, serveur injoignable, direct déjà en cours) en s'espaçant.
 * Il ne relance jamais ce que l'ordre ne demande plus ; la décision d'émettre vient de `KioskState.wantLive`.
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

  /** Prochaine nouvelle tentative annoncée (pour l'affichage), ou null. */
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
