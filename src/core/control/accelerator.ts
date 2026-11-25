/** Global shortcut accelerators (Electron syntax): validation, canonical form, and building one from a key press. */

const MODIFIERS: Record<string, string> = {
  commandorcontrol: "CommandOrControl",
  cmdorctrl: "CommandOrControl",
  command: "Command",
  cmd: "Command",
  control: "Control",
  ctrl: "Control",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  super: "Super",
  meta: "Super",
};
/** Order of the canonical form. */
const MODIFIER_ORDER = ["CommandOrControl", "Command", "Control", "Alt", "Shift", "Super"];
/** Modifiers that make a shortcut deliberate: Shift alone only changes the letter typed. */
const STRONG = new Set(["CommandOrControl", "Command", "Control", "Alt", "Super"]);

const NAMED_KEYS: Record<string, string> = {
  up: "Up", down: "Down", left: "Left", right: "Right", space: "Space", home: "Home", end: "End",
  pageup: "PageUp", pagedown: "PageDown", insert: "Insert", delete: "Delete", enter: "Enter", plus: "Plus",
};

function normalizeKey(raw: string): string | null {
  if (/^[a-z0-9]$/i.test(raw)) return raw.toUpperCase();
  const f = /^f([1-9]|1\d|2[0-4])$/i.exec(raw);
  if (f) return `F${f[1]}`;
  return NAMED_KEYS[raw.toLowerCase()] ?? null;
}

/**
 * Canonical accelerator (`CommandOrControl+Alt+Shift+M`), or null when it is not one we accept: unknown or repeated
 * modifier, no key or several, a key outside letters/digits/F-keys/arrows/navigation keys, no strong modifier.
 */
export function normalizeAccelerator(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 60) return null;
  const parts = raw.trim().split("+").map((p) => p.trim());
  if (parts.length < 2 || parts.some((p) => p === "")) return null;
  const key = normalizeKey(parts[parts.length - 1]!);
  if (!key) return null;
  const mods = new Set<string>();
  for (const p of parts.slice(0, -1)) {
    const m = MODIFIERS[p.toLowerCase()];
    if (!m || mods.has(m)) return null;
    mods.add(m);
  }
  if (mods.has("CommandOrControl") && (mods.has("Command") || mods.has("Control"))) return null;
  if (![...mods].some((m) => STRONG.has(m))) return null;
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join("+");
}

export interface KeyEventLike {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const CODE_KEYS: Record<string, string> = {
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Space: "Space", Home: "Home", End: "End",
  PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert", Delete: "Delete", Enter: "Enter",
};

/** The accelerator a key press stands for (`code`, so that the layout and Shift do not change the key); null for a modifier alone or an unsupported key. */
export function acceleratorFromKeyEvent(e: KeyEventLike, mac: boolean): string | null {
  let key: string | null = null;
  const letter = /^Key([A-Z])$/.exec(e.code);
  const digit = /^Digit(\d)$/.exec(e.code);
  if (letter) key = letter[1]!;
  else if (digit) key = digit[1]!;
  else if (/^F([1-9]|1\d|2[0-4])$/.test(e.code)) key = e.code;
  else key = CODE_KEYS[e.code] ?? null;
  if (!key) return null;
  const mods: string[] = [];
  if (mac) {
    if (e.metaKey) mods.push("CommandOrControl");
    if (e.ctrlKey) mods.push("Control");
  } else {
    if (e.ctrlKey) mods.push("CommandOrControl");
    if (e.metaKey) mods.push("Super");
  }
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return normalizeAccelerator([...mods, key].join("+"));
}
