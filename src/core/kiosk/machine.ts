import type { CurrentLive, HeartbeatReply, LiveOrder, MosqueInfo, Slot, StreamKind } from "../api/types";
import { currentKey, nextSlot, runningSlot, slotKey } from "./schedule";

/**
 * State machine of the device: pure function (state, event) → state. It extends the session machine
 * (core/session/machine.ts), which only knows about the link with the relay.
 *
 *   unpaired ──PAIRING_STARTED──▶ pairing ──PAIRED──▶ standby ◀──▶ armed ◀──▶ onair
 *      ▲  ▲                          │ ▲ code renewal                   (standby / arming / live order)
 *      │  └── UNPAIR ────────────────┘ └─ PAIRING_STARTED
 *      └──── REVOKED ──▶ revoked ──PAIRING_STARTED──▶ pairing
 *
 * Control rules (the server is the master):
 *  - "onair" = we must broadcast: `live` order from the server, or a manual live started here.
 *  - a scheduled slot never cuts a running manual live;
 *  - a manual stop dismisses the current live: the application does not restart it before the next slot;
 *  - "armed": a slot starts within the arming margin (the camera is prepared, nothing is sent).
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
  /** Last typed instance address, to prefill the pairing screen. */
  baseUrl: string;
  pairing: { userCode: string; expiresAt: number } | null;
  mosque: MosqueInfo | null;
  /** Last heartbeat succeeded; false after a failure. */
  online: boolean;
  lastSeenAt: number | null;
  command: LiveOrder;
  current: CurrentLive | null;
  schedule: Slot[];
  nextSlot: Slot | null;
  manual: ManualLive | null;
  /** Lives dismissed by a manual stop (keys): never restarted as long as they stay the same. */
  suppressed: string[];
  conflict: { message: string; at: number } | null;
  notice: Notice | null;
  /** We must broadcast now. */
  wantLive: boolean;
  /** Live actually targeted (manual first), for display. */
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
  /** Before a slot, the state becomes "armed" from this margin. */
  armMarginMs: number;
  /** After a manual start, an `idle` order older than this is not taken for an end. */
  manualGraceMs: number;
  /** A displayed conflict disappears on its own after this delay, when the server is quiet. */
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

/** Restores an already paired device (startup). `suppressed` comes from the persisted state. */
export function pairedState(mosque: MosqueInfo, baseUrl: string, suppressed: string[] = []): KioskState {
  return { ...INITIAL_KIOSK, phase: "standby", baseUrl, mosque, suppressed };
}

const isPaired = (s: KioskState) => s.phase === "standby" || s.phase === "armed" || s.phase === "onair";

/** Recomputes the derived fields (next slot, phase, broadcast order) at instant `at`. */
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
      // The server ended the manual live (after a grace delay, to absorb the start latency).
      let manual = s.manual;
      if (manual && reply.command === "idle" && at - manual.startedAt > o.manualGraceMs) manual = null;
      // The manual stop is forgotten once the dismissed live is neither running nor scheduled.
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
      // What we stop is not restarted: neither the running slot nor the manual live.
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
