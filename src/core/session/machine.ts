import type { ErrorCode } from "../errors";

/**
 * State machine of the broadcast session. Pure function: (state, event) → state.
 * No side effects here; `BroadcastSession` drives the capture and the transport.
 *
 *   idle ──START──▶ connecting ──CONNECTED──▶ live ◀──CONNECTED── reconnecting
 *                      │                       │  ──CONNECTION_LOST──▶  │ ▲
 *                      │                       │                        │ └ RETRY_FAILED (attempt+1)
 *   STOP from connecting / live / reconnecting ──▶ stopping ──STOPPED──▶ idle
 *   FATAL (or too many failures) ──▶ error ──RESET | START──▶ idle | connecting
 *
 * Server-driven control (pairing, standby, arming, live/idle order, manual live) lives in
 * `core/kiosk/machine.ts`: this machine only knows about the link with the relay.
 */
export type SessionStatus = "idle" | "connecting" | "live" | "reconnecting" | "error" | "stopping";

export interface SessionState {
  readonly status: SessionStatus;
  /** Consecutive reconnection attempts (0 when not reconnecting). */
  readonly attempt: number;
  readonly error: string | null;
  /** `conflict`: another live occupies the mosque (retry later, without insisting). */
  readonly errorCode: ErrorCode | null;
  /** Start of the live (ms, caller's clock); kept during a reconnection. */
  readonly startedAt: number | null;
}

export type SessionEvent =
  | { type: "START" }
  | { type: "CONNECTED"; at: number }
  | { type: "CONNECTION_LOST"; reason: string }
  | { type: "RETRY_FAILED"; reason: string }
  | { type: "FATAL"; reason: string; code?: ErrorCode }
  | { type: "STOP" }
  | { type: "STOPPED" }
  | { type: "RESET" };

export interface MachineOptions {
  /** Reconnection failures tolerated before switching to error. */
  maxAttempts: number;
}

export const INITIAL_STATE: SessionState = { status: "idle", attempt: 0, error: null, errorCode: null, startedAt: null };

const state = (status: SessionStatus, over: Partial<SessionState> = {}): SessionState => ({
  status,
  attempt: 0,
  error: null,
  errorCode: null,
  startedAt: null,
  ...over,
});

/** Event not allowed in the current state: the state is returned as is (same reference). */
export function transition(s: SessionState, e: SessionEvent, opts: MachineOptions): SessionState {
  switch (s.status) {
    case "idle":
      return e.type === "START" ? state("connecting") : s;
    case "connecting":
      if (e.type === "CONNECTED") return state("live", { startedAt: e.at });
      if (e.type === "FATAL") return state("error", { error: e.reason, errorCode: e.type === "FATAL" ? (e.code ?? null) : null });
      if (e.type === "STOP") return state("stopping");
      return s;
    case "live":
      if (e.type === "CONNECTION_LOST") return state("reconnecting", { attempt: 1, error: e.reason, startedAt: s.startedAt });
      if (e.type === "FATAL") return state("error", { error: e.reason, errorCode: e.type === "FATAL" ? (e.code ?? null) : null });
      if (e.type === "STOP") return state("stopping");
      return s;
    case "reconnecting":
      if (e.type === "CONNECTED") return state("live", { startedAt: s.startedAt });
      if (e.type === "RETRY_FAILED") {
        return s.attempt >= opts.maxAttempts
          ? state("error", { error: e.reason })
          : { ...s, attempt: s.attempt + 1, error: e.reason };
      }
      if (e.type === "FATAL") return state("error", { error: e.reason, errorCode: e.type === "FATAL" ? (e.code ?? null) : null });
      if (e.type === "STOP") return state("stopping");
      return s;
    case "stopping":
      return e.type === "STOPPED" ? state("idle") : s;
    case "error":
      if (e.type === "RESET") return state("idle");
      if (e.type === "START") return state("connecting");
      return s;
  }
}

export const isActive = (s: SessionState) => s.status === "connecting" || s.status === "live" || s.status === "reconnecting";
export const canStart = (s: SessionState) => s.status === "idle" || s.status === "error";

/** Observable state container around `transition`. */
export class SessionMachine {
  private current = INITIAL_STATE;
  private readonly listeners = new Set<(s: SessionState) => void>();
  constructor(private readonly opts: MachineOptions) {}

  get state(): SessionState {
    return this.current;
  }

  send(e: SessionEvent): SessionState {
    const next = transition(this.current, e, this.opts);
    if (next !== this.current) {
      this.current = next;
      for (const l of this.listeners) l(next);
    }
    return this.current;
  }

  subscribe(fn: (s: SessionState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
