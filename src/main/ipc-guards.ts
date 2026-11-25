import type { OverlayCorner, OverlayKind, TransitionMode } from "../core/api/types";
import { t } from "../core/messages";
import { validateBrowserSourceUrl } from "../core/sources/browser-source";

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

/** Web source address from the UI: a string, valid and public (throws the message the UI shows). */
export function parseBrowserSourceUrl(v: unknown): string {
  if (typeof v !== "string") throw new Error(t("ipc.invalidSource"));
  return validateBrowserSourceUrl(v);
}

/** Id of a screen or window as `desktopCapturer` gives it (`screen:0:0`, `window:1234:0`). */
export function isDesktopSourceId(v: unknown): v is string {
  return typeof v === "string" && /^(screen|window):[\w.:-]{1,60}$/.test(v);
}

/** Channels of the shortcuts and the local control API: the settings view, and the window answering the requests. */
export const CONTROL_INVOKE_CHANNELS = ["control:get", "control:set-shortcut", "control:set-api", "control:regenerate-token", "control:copy-token"] as const;
export const CONTROL_SEND_CHANNELS = ["control:response"] as const;
export const CONTROL_EVENT_CHANNELS = ["control:request"] as const;

/** Channels of the local sources (web source, screen share): the only ones the UI may use for them. */
export const SOURCE_INVOKE_CHANNELS = [
  "sources:browser-status",
  "sources:browser-start",
  "sources:browser-reload",
  "sources:browser-set-visible",
  "sources:browser-stop",
  "sources:screen-access",
  "sources:screen-list",
  "sources:screen-select",
  "sources:screen-open-settings",
  "sources:screen-audio-support",
  "sources:browser-audio-id",
] as const;
/** One-way UI -> main. */
export const SOURCE_SEND_CHANNELS = ["sources:browser-frame-ack"] as const;
/** Main -> UI. */
export const SOURCE_EVENT_CHANNELS = ["sources:browser-frame", "sources:browser-status-changed"] as const;
