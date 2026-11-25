import type { SetupState } from "../api/types";
import type { MessageKey } from "../messages";

/**
 * What the setup view shows, as a pure function of what is known: the answer of the server, the state of the
 * WHEP player and the last error. No text here: each phase maps to a message key the interface translates.
 */
export type SetupPhase =
  | "off"
  | "entering"
  | "serverDown"
  | "lapsed"
  | "waking"
  | "unreachable"
  | "unavailable"
  | "starting"
  | "watching";

export interface SetupInput {
  /** The operator opened the setup mode. */
  wanted: boolean;
  /** Last answer of the server (kept while the next one is awaited). */
  state: SetupState | null;
  /** Last renewal failed: `server` = unreachable, `lapsed` = the lease was lost and is being taken again. */
  error: "server" | "lapsed" | null;
  /** The programme picture is playing. */
  playing: boolean;
}

export function setupPhase(i: SetupInput): SetupPhase {
  if (!i.wanted) return "off";
  if (i.error === "lapsed") return "lapsed";
  if (!i.state) return i.error === "server" ? "serverDown" : "entering";
  if (i.state.orchestrator === "unreachable") return "unreachable";
  if (i.state.orchestrator === "waking") return "waking";
  if (!i.state.available) return "unavailable";
  return i.playing ? "watching" : "starting";
}

/** Waiting text shown over the programme view while it has no picture (null: the picture is shown). */
export const PHASE_MESSAGE: Record<SetupPhase, MessageKey | null> = {
  off: null,
  entering: "setup.phase.entering",
  serverDown: "setup.phase.serverDown",
  lapsed: "setup.phase.lapsed",
  waking: "setup.phase.waking",
  unreachable: "setup.phase.unreachable",
  unavailable: "setup.phase.unavailable",
  starting: "setup.phase.starting",
  watching: null,
};

/** Whether the programme picture should be requested from the relay now. */
export function shouldPlay(phase: SetupPhase): boolean {
  return phase === "starting" || phase === "watching";
}

/** Badge on the picture: a real live is on air (the picture is the broadcast) or a rehearsal (nothing is sent). */
export function badge(state: SetupState | null): MessageKey {
  return state?.live ? "setup.badge.live" : "setup.badge.rehearsal";
}

/** Delay before the next renewal: quick while something is awaited, calm once the picture plays. */
export function renewDelayMs(phase: SetupPhase): number {
  return phase === "watching" ? 10_000 : 3_000;
}

/** Retry delay of the programme picture while the relay has none yet (bounded growth, never a hammer). */
export function retryDelayMs(attempt: number): number {
  return Math.min(1_500 * 2 ** Math.max(0, attempt), 10_000);
}

/** The operator left the application alone for too long: the setup mode closes by itself, the orchestrator may sleep. */
export function isIdle(lastActivityAt: number, now: number, limitMs: number): boolean {
  return now - lastActivityAt >= limitMs;
}

export const IDLE_LIMIT_MS = 20 * 60_000;
