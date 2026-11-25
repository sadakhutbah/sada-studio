import type { OverlayCorner, OverlayKind, TransitionMode } from "../core/api/types";

/** Validation of what the renderer sends over IPC: the main process holds the device secret, so it trusts nothing. */

/** Path prefixes of the resources a DELETE may target (WHIP/WHEP sessions of the device's instance). */
const RESOURCE_PREFIXES = ["/api/v1/live/", "/api/v1/studio/setup/"] as const;

/** A WHIP/WHEP resource path: under a known prefix, no traversal, no query, no origin. */
export function isResourcePath(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 512 || !v.startsWith("/") || v.startsWith("//")) return false;
  if (!/^[A-Za-z0-9._~\-/]+$/.test(v)) return false; // no `%`, `?`, `#`, `\`, `:`, whitespace
  if (v.split("/").some((seg) => seg === "." || seg === "..")) return false;
  return RESOURCE_PREFIXES.some((p) => v.startsWith(p) && v.length > p.length);
}

/** Régie commands the UI issues. */
export const REGIE_COMMANDS: readonly string[] = ["scene", "janaza", "auto"];

export interface RegieCommand {
  cmd: string;
  arg?: string;
  transition?: TransitionMode;
}

export function parseRegieCommand(cmd: unknown, arg: unknown, transition: unknown): RegieCommand | null {
  if (typeof cmd !== "string" || !REGIE_COMMANDS.includes(cmd)) return null;
  if (arg !== undefined && arg !== null && (typeof arg !== "string" || !/^[\w-]{1,64}$/.test(arg))) return null;
  if (cmd === "scene" && typeof arg !== "string") return null;
  if (transition !== undefined && transition !== null && transition !== "fade" && transition !== "cut") return null;
  return {
    cmd,
    ...(typeof arg === "string" ? { arg } : {}),
    ...(transition === "fade" || transition === "cut" ? { transition } : {}),
  };
}

export const isTransition = (m: unknown): m is TransitionMode => m === "fade" || m === "cut";

const CORNERS: readonly OverlayCorner[] = ["tl", "tr", "bl", "br"];
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

/** Exact overlay payload per kind (same fields and limits as the form); anything else is dropped or refused. */
export function parseOverlay(kind: unknown, payload: unknown): { kind: OverlayKind; payload: Record<string, unknown> } | null {
  if (kind !== "qr" && kind !== "banner" && kind !== "logo") return null;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.visible !== "boolean") return null;
  if (kind === "logo") return { kind, payload: { visible: p.visible } };
  if (kind === "banner") {
    if (!str(p.title, 120) || !str(p.subtitle, 160)) return null;
    return { kind, payload: { visible: p.visible, title: p.title, subtitle: p.subtitle } };
  }
  if (!str(p.url, 512) || !str(p.label, 60) || !CORNERS.includes(p.corner as OverlayCorner)) return null;
  return { kind, payload: { visible: p.visible, url: p.url, label: p.label, corner: p.corner } };
}
