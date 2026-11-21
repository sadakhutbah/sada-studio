import type { CurrentLive, HeartbeatReply, LiveOrder, MosqueInfo, Slot, StreamKind } from "../api/types";
import { currentKey, nextSlot, runningSlot, slotKey } from "./schedule";

/**
 * Machine d'état du boîtier : fonction pure (état, évènement) → état. Elle étend la machine de session
 * (core/session/machine.ts), qui ne connaît que la liaison avec le relais.
 *
 *   unpaired ──PAIRING_STARTED──▶ pairing ──PAIRED──▶ standby ◀──▶ armed ◀──▶ onair
 *      ▲  ▲                          │ ▲ renouvellement du code        (veille / armement / ordre live)
 *      │  └── UNPAIR ────────────────┘ └─ PAIRING_STARTED
 *      └──── REVOKED ──▶ revoked ──PAIRING_STARTED──▶ pairing
 *
 * Règles de pilotage (le serveur est maître) :
 *  - « onair » = on doit émettre : ordre `live` du serveur, ou direct manuel lancé ici.
 *  - un créneau planifié ne coupe jamais un direct manuel en cours ;
 *  - un arrêt manuel écarte le direct courant : l'application ne le relance pas avant le créneau suivant ;
 *  - « armed » : un créneau commence dans la marge d'armement (la caméra est préparée, rien n'est envoyé).
 */
export type KioskPhase = "unpaired" | "pairing" | "standby" | "armed" | "onair" | "revoked";

export interface ManualLive {
  kind: StreamKind;
  title: string;
  startedAt: number;
}

export type NoticeCode = "revoked" | "pair-expired" | "pair-denied" | "pair-failed" | "unpaired";

export interface Notice {
  code: NoticeCode;
  message: string;
}

export interface KioskState {
  phase: KioskPhase;
  /** Dernière adresse d'instance saisie, pour préremplir l'écran d'appairage. */
  baseUrl: string;
  pairing: { userCode: string; expiresAt: number } | null;
  mosque: MosqueInfo | null;
  /** Dernier battement réussi ; faux après un échec. */
  online: boolean;
  lastSeenAt: number | null;
  command: LiveOrder;
  current: CurrentLive | null;
  schedule: Slot[];
  nextSlot: Slot | null;
  manual: ManualLive | null;
  /** Directs écartés par un arrêt manuel (clés) : jamais relancés tant qu'ils sont les mêmes. */
  suppressed: string[];
  conflict: { message: string; at: number } | null;
  notice: Notice | null;
  /** Il faut émettre maintenant. */
  wantLive: boolean;
  /** Direct effectivement visé (manuel d'abord), pour l'affichage. */
  live: CurrentLive | null;
}

export type KioskEvent =
  | { type: "PAIRING_STARTED"; baseUrl: string; userCode: string; expiresAt: number }
  | { type: "PAIRING_FAILED"; code: NoticeCode; message: string }
  | { type: "PAIRED"; mosque: MosqueInfo; at: number }
  | { type: "UNPAIR" }
  | { type: "REVOKED"; message: string }
  | { type: "HEARTBEAT_OK"; reply: HeartbeatReply; at: number }
  | { type: "HEARTBEAT_FAILED" }
  | { type: "TICK"; at: number }
  | { type: "MANUAL_STARTED"; kind: StreamKind; title: string; at: number }
  | { type: "MANUAL_REFUSED"; message: string; at: number }
  | { type: "STOP_REQUESTED"; at: number }
  | { type: "DISMISS_CONFLICT" };

export interface KioskOptions {
  /** Avant un créneau, on passe en « armed » à partir de cette marge. */
  armMarginMs: number;
  /** Après un départ manuel, un ordre `idle` plus ancien que cela n'est pas pris pour une fin. */
  manualGraceMs: number;
  /** Un conflit affiché disparaît de lui-même après cela, quand le serveur est calme. */
  conflictTtlMs: number;
}

export const DEFAULT_KIOSK_OPTIONS: KioskOptions = { armMarginMs: 10 * 60_000, manualGraceMs: 30_000, conflictTtlMs: 60_000 };

export const INITIAL_KIOSK: KioskState = {
  phase: "unpaired",
  baseUrl: "",
  pairing: null,
  mosque: null,
  online: false,
  lastSeenAt: null,
  command: "idle",
  current: null,
  schedule: [],
  nextSlot: null,
  manual: null,
  suppressed: [],
  conflict: null,
  notice: null,
  wantLive: false,
  live: null,
};

/** Restaure un boîtier déjà appairé (démarrage). `suppressed` vient de l'état persisté. */
export function pairedState(mosque: MosqueInfo, baseUrl: string, suppressed: string[] = []): KioskState {
  return { ...INITIAL_KIOSK, phase: "standby", baseUrl, mosque, suppressed };
}

const isPaired = (s: KioskState) => s.phase === "standby" || s.phase === "armed" || s.phase === "onair";

/** Recalcule les champs dérivés (prochain créneau, phase, ordre d'émettre) à l'instant `at`. */
function derive(s: KioskState, at: number, o: KioskOptions): KioskState {
  if (!isPaired(s)) return s;
  const next = nextSlot(s.schedule, at, s.suppressed);
  const serverLive = s.command === "live" && !(s.current && s.suppressed.includes(currentKey(s.current)));
  const wantLive = s.manual !== null || serverLive;
  const live: CurrentLive | null = s.manual
    ? { type: s.manual.kind, title: s.manual.title, source: "manual" }
    : serverLive
      ? (s.current ?? null)
      : null;
  const phase: KioskPhase = wantLive ? "onair" : next && next.startsAt - at <= o.armMarginMs ? "armed" : "standby";
  if (phase === s.phase && wantLive === s.wantLive && next === s.nextSlot && live === s.live) return s;
  return { ...s, phase, wantLive, nextSlot: next, live };
}

export function kioskTransition(s: KioskState, e: KioskEvent, o: KioskOptions = DEFAULT_KIOSK_OPTIONS): KioskState {
  switch (e.type) {
    case "PAIRING_STARTED":
      if (isPaired(s)) return s;
      return { ...INITIAL_KIOSK, phase: "pairing", baseUrl: e.baseUrl, pairing: { userCode: e.userCode, expiresAt: e.expiresAt }, notice: null };
    case "PAIRING_FAILED":
      if (s.phase !== "pairing") return s;
      return { ...INITIAL_KIOSK, baseUrl: s.baseUrl, notice: { code: e.code, message: e.message } };
    case "PAIRED":
      if (s.phase !== "pairing") return s;
      return derive({ ...INITIAL_KIOSK, phase: "standby", baseUrl: s.baseUrl, mosque: e.mosque, lastSeenAt: e.at }, e.at, o);
    case "UNPAIR":
      return { ...INITIAL_KIOSK, baseUrl: s.baseUrl };
    case "REVOKED":
      if (!isPaired(s)) return s;
      return { ...INITIAL_KIOSK, phase: "revoked", baseUrl: s.baseUrl, notice: { code: "revoked", message: e.message } };
    case "HEARTBEAT_FAILED":
      return isPaired(s) && s.online ? { ...s, online: false } : s;
    case "HEARTBEAT_OK": {
      if (!isPaired(s)) return s;
      const { reply, at } = e;
      // Le serveur a mis fin au direct manuel (après un délai de grâce, pour absorber la latence du départ).
      let manual = s.manual;
      if (manual && reply.command === "idle" && at - manual.startedAt > o.manualGraceMs) manual = null;
      // L'arrêt manuel s'oublie quand le direct écarté n'est plus ni en cours ni au planning.
      let suppressed = s.suppressed;
      if (suppressed.length) {
        const live = reply.current ? currentKey(reply.current) : null;
        const running = runningSlot(reply.schedule, at);
        const runningKey = running ? slotKey(running) : null;
        const kept = suppressed.filter((k) => k === live || k === runningKey);
        if (kept.length !== suppressed.length) suppressed = kept;
      }
      const conflict =
        s.conflict && reply.command === "idle" && !reply.current && at - s.conflict.at > o.conflictTtlMs ? null : s.conflict;
      return derive(
        { ...s, online: true, lastSeenAt: at, command: reply.command, current: reply.current, schedule: reply.schedule, manual, suppressed, conflict },
        at,
        o,
      );
    }
    case "TICK":
      return derive(s, e.at, o);
    case "MANUAL_STARTED":
      if (!isPaired(s)) return s;
      return derive({ ...s, manual: { kind: e.kind, title: e.title, startedAt: e.at }, suppressed: [], conflict: null }, e.at, o);
    case "MANUAL_REFUSED":
      return isPaired(s) ? { ...s, conflict: { message: e.message, at: e.at } } : s;
    case "STOP_REQUESTED": {
      if (!isPaired(s)) return s;
      // Ce que l'on arrête n'est pas relancé : ni le créneau en cours, ni le direct manuel.
      const keys = new Set(s.suppressed);
      if (s.manual) keys.add(`manual|${s.manual.kind}|${s.manual.title}`);
      if (s.current && s.command === "live") keys.add(currentKey(s.current));
      const running = runningSlot(s.schedule, e.at);
      if (running) keys.add(slotKey(running));
      return derive({ ...s, manual: null, suppressed: [...keys], conflict: null }, e.at, o);
    }
    case "DISMISS_CONFLICT":
      return s.conflict ? { ...s, conflict: null } : s;
  }
}
