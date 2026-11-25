export type RegieShortcutAction =
  | { type: "stage"; index: number }
  | { type: "take" }
  | null;

export interface ShortcutKeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  target?: {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selector: string) => Element | null;
  } | null;
}

export function isEditableElement(target: ShortcutKeyLike["target"]): boolean {
  if (!target) return false;
  const tag = (target.tagName || "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || Boolean(target.isContentEditable);
}

export function resolveRegieShortcut(ev: ShortcutKeyLike, sceneCount: number): RegieShortcutAction {
  if (ev.ctrlKey || ev.metaKey || ev.altKey || isEditableElement(ev.target)) {
    return null;
  }
  if (ev.key >= "1" && ev.key <= "9") {
    const index = Number(ev.key) - 1;
    return index >= 0 && index < sceneCount ? { type: "stage", index } : null;
  }
  if (ev.key === "Enter") {
    // Only with the focus on a scene button: an Enter pressed anywhere else (body, another control) never goes on air.
    return ev.target?.closest?.("button[data-regie-scene]") ? { type: "take" } : null;
  }
  return null;
}
