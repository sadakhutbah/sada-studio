import type { DesktopSourceInfo } from "./types";

/** The screen or window the operator shared last: kept between launches to offer it again. */
export interface RememberedScreen {
  id: string;
  name: string;
  kind: "screen" | "window";
}

/** What was stored (a hand-edited or old file may hold anything): a valid record, or null. */
export function normalizeRememberedScreen(raw: unknown): RememberedScreen | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !/^(screen|window):[\w.:-]{1,60}$/.test(r.id)) return null;
  if (typeof r.name !== "string" || r.name.length > 300) return null;
  if (r.kind !== "screen" && r.kind !== "window") return null;
  if (!r.id.startsWith(`${r.kind}:`)) return null;
  return { id: r.id, name: r.name, kind: r.kind };
}

export const rememberedFrom = (s: Pick<DesktopSourceInfo, "id" | "name" | "kind">): RememberedScreen => ({ id: s.id, name: s.name, kind: s.kind });

/**
 * Finds the remembered source again among the current ones. The id is tried first (it survives within a session, also
 * when a window's title changes); window ids do not survive a restart, so the same name of the same kind is the next
 * choice, but only when it is unambiguous: two windows with that name mean we cannot tell which one, so none is picked.
 */
export function findRemembered(remembered: RememberedScreen | null, list: readonly DesktopSourceInfo[]): DesktopSourceInfo | null {
  if (!remembered) return null;
  const byId = list.find((s) => s.id === remembered.id && s.kind === remembered.kind);
  if (byId) return byId;
  const byName = list.filter((s) => s.kind === remembered.kind && s.name === remembered.name);
  return byName.length === 1 ? byName[0]! : null;
}
