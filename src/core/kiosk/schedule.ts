import type { CurrentLive, Slot } from "../api/types";

/** A slot without an end time is assumed to last two hours. */
export const DEFAULT_SLOT_MS = 2 * 60 * 60_000;

export const slotEnd = (s: Slot) => s.endsAt ?? s.startsAt + DEFAULT_SLOT_MS;

/** Identity of a scheduled slot; without a server id, its type and title. */
export const slotKey = (s: Slot) => (s.id ? `slot:${s.id}` : `schedule|${s.type}|${s.title}`);

/** Identity of the live currently running on the server. The manual live has its own key. */
export const currentKey = (c: CurrentLive) =>
  c.source === "manual" ? `manual|${c.type}|${c.title}` : c.slotId ? `slot:${c.slotId}` : `schedule|${c.type}|${c.title}`;

/** Next slot: the first one that is not over and not dismissed. */
export function nextSlot(schedule: Slot[], now: number, skip: readonly string[] = []): Slot | null {
  for (const s of schedule) {
    if (slotEnd(s) <= now) continue;
    if (skip.includes(slotKey(s))) continue;
    return s;
  }
  return null;
}

/** A slot is running at this instant. */
export const runningSlot = (schedule: Slot[], now: number): Slot | null =>
  schedule.find((s) => s.startsAt <= now && now < slotEnd(s)) ?? null;
