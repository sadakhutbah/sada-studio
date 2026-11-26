/** Actions that can be driven from outside the window: global shortcuts, and the local API (Stream Deck, Companion). */
export const CONTROL_ACTIONS = [
  "mic.toggle",
  "mic.mute",
  "mic.unmute",
  "browser.toggle",
  "browser.show",
  "browser.hide",
  "screen.toggle",
  "screen.start",
  "screen.stop",
  "scene.next",
  "scene.previous",
  "scene.set",
] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

/** The ones a global shortcut can be bound to (the others need an argument or are the explicit variants of these). */
export const SHORTCUT_ACTIONS = ["mic.toggle", "browser.toggle", "screen.toggle", "scene.next", "scene.previous"] as const;
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

export interface ControlRequest {
  action: ControlAction;
  /** `scene.set`: the scene identifier. */
  scene?: string;
}

/** What the operator's screen shows once the action ran (whatever the answering side knows). */
export interface ControlState {
  micMuted?: boolean;
  /** "none": no web source added. */
  browser?: "none" | "shown" | "hidden";
  screen?: "on" | "off";
  scene?: string;
}

export interface ControlResult {
  ok: boolean;
  message?: string;
  /** Machine-readable cause of a failure (`ui_unavailable`, `timeout`, `no_browser_source`...). */
  code?: string;
  state?: ControlState;
}

export const isControlAction = (v: unknown): v is ControlAction => typeof v === "string" && (CONTROL_ACTIONS as readonly string[]).includes(v);
export const isShortcutAction = (v: unknown): v is ShortcutAction => typeof v === "string" && (SHORTCUT_ACTIONS as readonly string[]).includes(v);

const SCENE_ID = /^[\w-]{1,64}$/;
export const isSceneId = (v: unknown): v is string => typeof v === "string" && SCENE_ID.test(v);

/** A request from an untrusted side: a known action, and a valid scene where one is needed. Null when it is neither. */
export function parseControlRequest(action: unknown, scene?: unknown): ControlRequest | null {
  if (!isControlAction(action)) return null;
  if (action === "scene.set") return isSceneId(scene) ? { action, scene } : null;
  return { action };
}

/** `scene.*` goes to the window's Régie store first, and to the main process (Sada server) when the window cannot take it. */
export const isSceneAction = (a: ControlAction): boolean => a.startsWith("scene.");

const STATE_BROWSER = ["none", "shown", "hidden"];

/** An answer from the window, as received over IPC: only the expected fields, bounded. */
export function normalizeControlResult(raw: unknown): ControlResult {
  if (!raw || typeof raw !== "object") return { ok: false, code: "bad_result" };
  const r = raw as Record<string, unknown>;
  const out: ControlResult = { ok: r.ok === true };
  if (typeof r.message === "string") out.message = r.message.slice(0, 300);
  if (typeof r.code === "string" && /^[\w.-]{1,40}$/.test(r.code)) out.code = r.code;
  if (r.state && typeof r.state === "object") {
    const s = r.state as Record<string, unknown>;
    const state: ControlState = {};
    if (typeof s.micMuted === "boolean") state.micMuted = s.micMuted;
    if (typeof s.browser === "string" && STATE_BROWSER.includes(s.browser)) state.browser = s.browser as ControlState["browser"];
    if (s.screen === "on" || s.screen === "off") state.screen = s.screen;
    if (isSceneId(s.scene)) state.scene = s.scene;
    out.state = state;
  }
  return out;
}
