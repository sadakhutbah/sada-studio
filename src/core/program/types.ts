import type { Compositing, LiveOverlays, RegieScene, SceneKind, TransitionMode } from "../api/types";

/**
 * What the studio composes on air: input of `StudioSceneCompositor.setProgram`.
 *
 * One definition for the compositor and the Régie store (`selectProgramView` re-exports this type).
 *
 * - `scene`: id of the current scene; `sceneKind`: its kind (`camera` | `banner` | `full`).
 * - `scenes`: every scene with its `scene_kind` (kind of the outgoing scene of a transition, pre-rendering).
 * - `overlays`: logo, QR and free banner, drawn in canvas with the engine's geometry.
 * - `micMuted`: informative, the compositor draws nothing for it (the audio mixer applies the mute).
 * - `compositing`: `"studio"` → the studio draws scenes and overlays; `"server"` → the orchestrator does and the
 *   studio sends its camera untouched (except in setup mode, where the studio always composes).
 * - `transition` (default `"fade"`): between scenes, the engine's timing (sada/transitions.py).
 * - `darkGreen` (default `#1E7A3C`, the engine's `cfg.dark_green`): the green the overlay panels derive from.
 */
export interface ProgramView {
  scene: string;
  sceneKind: SceneKind;
  scenes: RegieScene[];
  overlays: LiveOverlays;
  micMuted: boolean;
  compositing: Compositing;
  transition?: TransitionMode;
  darkGreen?: string;
}

export type { Compositing, SceneKind };
