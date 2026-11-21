import type { CurrentLive, Slot } from "../api/types";

/** Un créneau sans heure de fin est supposé durer deux heures. */
export const DEFAULT_SLOT_MS = 2 * 60 * 60_000;

export const slotEnd = (s: Slot) => s.endsAt ?? s.startsAt + DEFAULT_SLOT_MS;

/** Identité d'un créneau planifié ; sans identifiant serveur, le type et le titre. */
export const slotKey = (s: Slot) => (s.id ? `slot:${s.id}` : `schedule|${s.type}|${s.title}`);

/** Identité du direct en cours côté serveur. Le direct manuel a sa propre clé. */
export const currentKey = (c: CurrentLive) =>
  c.source === "manual" ? `manual|${c.type}|${c.title}` : c.slotId ? `slot:${c.slotId}` : `schedule|${c.type}|${c.title}`;

/** Prochain créneau : le premier qui n'est pas terminé et qui n'est pas écarté. */
export function nextSlot(schedule: Slot[], now: number, skip: readonly string[] = []): Slot | null {
  for (const s of schedule) {
    if (slotEnd(s) <= now) continue;
    if (skip.includes(slotKey(s))) continue;
    return s;
  }
  return null;
}

/** Un créneau est en cours à cet instant. */
export const runningSlot = (schedule: Slot[], now: number): Slot | null =>
  schedule.find((s) => s.startsAt <= now && now < slotEnd(s)) ?? null;
