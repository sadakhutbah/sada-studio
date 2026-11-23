/**
 * State machine of the ffmpeg capture. Pure function: (state, event) → state.
 *
 *   idle ──START──▶ starting ──FLOWING──▶ running
 *                      ▲  │                  │
 *                RETRY │  └──EXITED──┐       │ EXITED
 *                      │             ▼       ▼
 *                      └──────── reconnecting   (downSince kept; attempt+1 per failed try)
 *   STOP from starting / running / reconnecting ──▶ stopping ──STOPPED──▶ idle
 *
 * Unlike the broadcast session there is no `error` end state: an unattended PC keeps retrying, with backoff,
 * and the operator is warned (see `isProlongedOutage`) instead.
 */
export type CaptureStatus = "idle" | "starting" | "running" | "reconnecting" | "stopping";

export interface CaptureState {
  readonly status: CaptureStatus;
  /** Consecutive failed attempts since the last time media flowed. */
  readonly attempt: number;
  readonly lastError: string | null;
  /** Wall time (ms) when the media stopped flowing; kept across attempts, null while healthy. */
  readonly downSince: number | null;
  readonly startedAt: number | null;
}

export type CaptureEvent =
  | { type: "START"; at: number }
  | { type: "FLOWING"; at: number }
  | { type: "EXITED"; at: number; reason: string }
  | { type: "RETRY" }
  | { type: "STOP" }
  | { type: "STOPPED" };

export const INITIAL_CAPTURE_STATE: CaptureState = { status: "idle", attempt: 0, lastError: null, downSince: null, startedAt: null };

export function transition(s: CaptureState, e: CaptureEvent): CaptureState {
  switch (s.status) {
    case "idle":
      return e.type === "START" ? { ...INITIAL_CAPTURE_STATE, status: "starting", downSince: e.at } : s;
    case "starting":
      if (e.type === "FLOWING") return { status: "running", attempt: 0, lastError: null, downSince: null, startedAt: e.at };
      if (e.type === "EXITED") return { ...s, status: "reconnecting", attempt: s.attempt + 1, lastError: e.reason };
      if (e.type === "STOP") return { ...s, status: "stopping" };
      return s;
    case "running":
      if (e.type === "EXITED") return { ...s, status: "reconnecting", attempt: 1, lastError: e.reason, downSince: e.at };
      if (e.type === "STOP") return { ...s, status: "stopping" };
      return s;
    case "reconnecting":
      if (e.type === "RETRY") return { ...s, status: "starting" };
      if (e.type === "STOP") return { ...s, status: "stopping" };
      return s;
    case "stopping":
      return e.type === "STOPPED" ? INITIAL_CAPTURE_STATE : s;
  }
}

/** The media has been missing for at least `thresholdMs`: the operator must be told. */
export function isProlongedOutage(s: CaptureState, now: number, thresholdMs: number): boolean {
  return s.downSince !== null && (s.status === "starting" || s.status === "reconnecting") && now - s.downSince >= thresholdMs;
}

export class CaptureMachine {
  private current = INITIAL_CAPTURE_STATE;
  private readonly listeners = new Set<(s: CaptureState) => void>();

  get state(): CaptureState {
    return this.current;
  }

  send(e: CaptureEvent): CaptureState {
    const next = transition(this.current, e);
    if (next !== this.current) {
      this.current = next;
      for (const l of this.listeners) l(next);
    }
    return this.current;
  }

  subscribe(fn: (s: CaptureState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
