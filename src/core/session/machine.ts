/**
 * Machine d'état de la session de diffusion. Fonction pure : (état, évènement) → état.
 * Aucun effet de bord ici ; c'est `BroadcastSession` qui pilote la capture et le transport.
 *
 *   idle ──START──▶ connecting ──CONNECTED──▶ live ◀──CONNECTED── reconnecting
 *                      │                       │  ──CONNECTION_LOST──▶  │ ▲
 *                      │                       │                        │ └ RETRY_FAILED (attempt+1)
 *   STOP depuis connecting / live / reconnecting ──▶ stopping ──STOPPED──▶ idle
 *   FATAL (ou trop d'échecs) ──▶ error ──RESET | START──▶ idle | connecting
 */
export type SessionStatus = "idle" | "connecting" | "live" | "reconnecting" | "error" | "stopping";

export interface SessionState {
  readonly status: SessionStatus;
  /** Tentatives de reconnexion consécutives (0 hors reconnexion). */
  readonly attempt: number;
  readonly error: string | null;
  /** Début du direct (ms, horloge de l'appelant) ; conservé pendant une reconnexion. */
  readonly startedAt: number | null;
}

export type SessionEvent =
  | { type: "START" }
  | { type: "CONNECTED"; at: number }
  | { type: "CONNECTION_LOST"; reason: string }
  | { type: "RETRY_FAILED"; reason: string }
  | { type: "FATAL"; reason: string }
  | { type: "STOP" }
  | { type: "STOPPED" }
  | { type: "RESET" };

export interface MachineOptions {
  /** Échecs de reconnexion tolérés avant de passer en erreur. */
  maxAttempts: number;
}

export const INITIAL_STATE: SessionState = { status: "idle", attempt: 0, error: null, startedAt: null };

const state = (status: SessionStatus, over: Partial<SessionState> = {}): SessionState => ({
  status,
  attempt: 0,
  error: null,
  startedAt: null,
  ...over,
});

/** Évènement non permis dans l'état courant : l'état est rendu tel quel (même référence). */
export function transition(s: SessionState, e: SessionEvent, opts: MachineOptions): SessionState {
  switch (s.status) {
    case "idle":
      return e.type === "START" ? state("connecting") : s;
    case "connecting":
      if (e.type === "CONNECTED") return state("live", { startedAt: e.at });
      if (e.type === "FATAL") return state("error", { error: e.reason });
      if (e.type === "STOP") return state("stopping");
      return s;
    case "live":
      if (e.type === "CONNECTION_LOST") return state("reconnecting", { attempt: 1, error: e.reason, startedAt: s.startedAt });
      if (e.type === "FATAL") return state("error", { error: e.reason });
      if (e.type === "STOP") return state("stopping");
      return s;
    case "reconnecting":
      if (e.type === "CONNECTED") return state("live", { startedAt: s.startedAt });
      if (e.type === "RETRY_FAILED") {
        return s.attempt >= opts.maxAttempts
          ? state("error", { error: e.reason })
          : { ...s, attempt: s.attempt + 1, error: e.reason };
      }
      if (e.type === "FATAL") return state("error", { error: e.reason });
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

/** Conteneur d'état observable autour de `transition`. */
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
