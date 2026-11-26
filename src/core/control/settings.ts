import { isShortcutAction, SHORTCUT_ACTIONS, type ShortcutAction } from "./actions";
import { normalizeAccelerator } from "./accelerator";
import type { ShortcutStatus } from "./shortcuts";

export const DEFAULT_API_PORT = 17420;
export const MIN_API_PORT = 1024;
export const MAX_API_PORT = 65535;
/** Length of the local API token, in hexadecimal digits (32 random bytes). */
export const TOKEN_HEX_LENGTH = 64;

export interface ControlSettings {
  /** Accelerator of each shortcut; "" = no shortcut. */
  shortcuts: Record<ShortcutAction, string>;
  api: { enabled: boolean; port: number; token: string };
}

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  "mic.toggle": "CommandOrControl+Alt+Shift+M",
  "browser.toggle": "CommandOrControl+Alt+Shift+B",
  "screen.toggle": "CommandOrControl+Alt+Shift+S",
  "scene.next": "CommandOrControl+Alt+Shift+Right",
  "scene.previous": "CommandOrControl+Alt+Shift+Left",
};

export const isValidToken = (v: unknown): v is string => typeof v === "string" && new RegExp(`^[0-9a-f]{${TOKEN_HEX_LENGTH}}$`).test(v);
export const isValidPort = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= MIN_API_PORT && v <= MAX_API_PORT;

/**
 * The stored settings (any shape: old file, hand edit) as valid ones. A missing shortcut takes its default, an invalid
 * one too; an empty string stays empty (the operator removed it). The API is off until the operator turns it on; a
 * missing or malformed token is replaced by a new one from `makeToken`.
 */
export function normalizeControlSettings(raw: unknown, makeToken: () => string): ControlSettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const sc = r.shortcuts && typeof r.shortcuts === "object" ? (r.shortcuts as Record<string, unknown>) : {};
  const shortcuts = { ...DEFAULT_SHORTCUTS };
  for (const action of SHORTCUT_ACTIONS) {
    const v = sc[action];
    if (v === "") shortcuts[action] = "";
    else if (v !== undefined) shortcuts[action] = normalizeAccelerator(v) ?? DEFAULT_SHORTCUTS[action];
  }
  const api = r.api && typeof r.api === "object" ? (r.api as Record<string, unknown>) : {};
  return {
    shortcuts,
    api: {
      enabled: api.enabled === true,
      port: isValidPort(api.port) ? api.port : DEFAULT_API_PORT,
      token: isValidToken(api.token) ? api.token : makeToken(),
    },
  };
}

/** What the settings view shows. */
export interface ControlView {
  shortcuts: { action: ShortcutAction; accelerator: string; status: ShortcutStatus }[];
  api: { enabled: boolean; port: number; token: string; running: boolean; error: string | null; baseUrl: string };
}

/** The settings view's shortcut to change: only a known action and an accelerator we accept (or "" to remove it). */
export function parseShortcutChange(action: unknown, accelerator: unknown): { action: ShortcutAction; accelerator: string } | null {
  if (!isShortcutAction(action)) return null;
  if (accelerator === "") return { action, accelerator: "" };
  const a = normalizeAccelerator(accelerator);
  return a ? { action, accelerator: a } : null;
}
