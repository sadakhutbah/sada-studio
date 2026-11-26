/** Scenes of the Régie, for the shortcuts and the local API (the main process picks them; the window is not involved). */

/** The scenes the panel falls back to when the server does not list any (same identifiers as the panel's). */
export const FALLBACK_SCENE_IDS = ["khutba", "avant", "priere", "entracte", "termine"] as const;

/**
 * The scene before or after `current` in the list, null at either end (a button pressed once too often must not jump
 * from the last scene back on air to the first). With an unknown current scene, "next" is the first one.
 */
export function pickScene(ids: readonly string[], current: string | undefined, direction: "next" | "previous"): string | null {
  const i = current === undefined ? -1 : ids.indexOf(current);
  if (i === -1) return direction === "next" ? (ids[0] ?? null) : null;
  return ids[direction === "next" ? i + 1 : i - 1] ?? null;
}

/** The Régie command that takes a scene: the funeral prayer has its own, the others go through `scene`. */
export function commandFor(sceneId: string): { command: "scene" | "janaza"; arg?: string } {
  return sceneId === "janaza" ? { command: "janaza" } : { command: "scene", arg: sceneId };
}
