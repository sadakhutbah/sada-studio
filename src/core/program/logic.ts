/** Pure decisions of the programme compositor (no DOM): what is drawn, in which order, and the transition timing. */
import type { LiveOverlays, RegieScene, SceneKind, TransitionMode } from "../api/types";
import type { ProgramView } from "./types";

/** Scenes that are a banner over the camera in the engine (`scenes.py::SCENES`, `full=False` but not the camera). */
const BANNER_SCENES = new Set(["khutba", "dars", "tarawih_video"]);

/**
 * Kind of a scene: the contract's `scene_kind` when the server gives it; otherwise derived from the older `kind`
 * (camera → camera; the engine's banner scenes → banner; any other slate or custom scene → full screen).
 */
export function programSceneKind(scene: RegieScene | undefined): SceneKind {
  if (!scene) return "camera";
  if (scene.scene_kind === "camera" || scene.scene_kind === "banner" || scene.scene_kind === "full") return scene.scene_kind;
  if (!scene.kind || scene.kind === "camera") return "camera";
  return BANNER_SCENES.has(scene.id) ? "banner" : "full";
}

/** The studio composes the programme itself: it is the publisher (`compositing: "studio"`), or the setup view is open. */
export function localCompositing(view: ProgramView | null, rehearsal: boolean): boolean {
  return view !== null && (rehearsal || view.compositing === "studio");
}

/** The overlays the engine would draw (`render_overlays`: QR needs a URL, the banner a title). */
export function visibleOverlays(o: LiveOverlays): { logo: boolean; qr: boolean; banner: boolean } {
  return {
    logo: Boolean(o.logo.visible),
    qr: Boolean(o.qr.visible) && Boolean(o.qr.url),
    banner: Boolean(o.banner.visible) && o.banner.title.trim() !== "",
  };
}

export function hasVisibleOverlay(o: LiveOverlays): boolean {
  const v = visibleOverlays(o);
  return v.logo || v.qr || v.banner;
}

/**
 * Whether the programme needs the canvas: something has to be drawn over (or instead of) the camera, or a
 * transition is still running (the canvas stays on until a fade back to the camera has finished).
 */
export function programNeedsCanvas(view: ProgramView | null, rehearsal: boolean, transitioning = false): boolean {
  if (!localCompositing(view, rehearsal) || !view) return false;
  return transitioning || view.sceneKind !== "camera" || hasVisibleOverlay(view.overlays);
}

/** Drawing order of the layers (bottom to top), as the engine composes: camera, scene, web source, overlays. */
export type ProgramLayer = "camera" | "scene-out" | "scene-in" | "browser" | "overlays";

export interface LayerInputs {
  local: boolean;
  /** A fullscreen web source covers the camera and the scene. */
  browser: "none" | "overlay" | "fullscreen";
  /** Kind of the incoming (current) scene and of the outgoing one while a transition runs (null: none). */
  sceneIn: SceneKind;
  sceneOut: SceneKind | null;
  /** The incoming full screen is fully opaque and steady: the camera under it need not be drawn. */
  sceneInOpaque: boolean;
  overlays: boolean;
}

export function layerOrder(i: LayerInputs): ProgramLayer[] {
  const out: ProgramLayer[] = [];
  const fullBrowser = i.browser === "fullscreen";
  const covered = fullBrowser || (i.local && i.sceneIn === "full" && i.sceneInOpaque && i.sceneOut === null);
  if (!covered) out.push("camera");
  if (i.local && !fullBrowser) {
    if (i.sceneOut !== null && i.sceneOut !== "camera") out.push("scene-out");
    if (i.sceneIn !== "camera") out.push("scene-in");
  }
  if (i.browser !== "none") out.push("browser");
  if (i.local && i.overlays) out.push("overlays");
  return out;
}

// --- transitions (same choreography as the engine, sada/transitions.py) -------------------------------------------
export const OUT_DUR = 0.45;
export const FOND_DUR = 0.8;
export const IN_START = 0.35;
export const IN_DUR = 0.7;
export const SLIDE_Y = 18;
export const SLIDE_X = 36;
export const TRANSITION_TOTAL = Math.max(OUT_DUR, FOND_DUR, IN_START + IN_DUR);
/** The incoming scene's picture is awaited at most this long before the transition starts anyway (engine: 1 s). */
export const TRANSITION_WAIT_MS = 1500;

const clip = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const easeInOut = (x: number) => 0.5 - 0.5 * Math.cos(Math.PI * clip(x));
export const easeOut = (x: number) => 1 - (1 - clip(x)) ** 3;

export interface LayerFrame {
  visible: boolean;
  alpha: number;
  dx: number;
  dy: number;
}

export interface TransitionFrame {
  /** The outgoing scene's layer (not visible when it is the camera or has gone). */
  out: LayerFrame;
  /** The incoming scene's layer (not visible when it is the camera). */
  in: LayerFrame;
  done: boolean;
}

export const newTransitionFrame = (): TransitionFrame => ({
  out: { visible: false, alpha: 0, dx: 0, dy: 0 },
  in: { visible: false, alpha: 0, dx: 0, dy: 0 },
  done: false,
});

function setLayer(l: LayerFrame, visible: boolean, alpha = 0, dx = 0, dy = 0): void {
  l.visible = visible;
  l.alpha = alpha;
  l.dx = dx;
  l.dy = dy;
}

const tenth = (v: number) => Math.round(v * 10) / 10;

/**
 * Layer parameters `tau` seconds into a transition from a scene of kind `from` to one of kind `to`, written into
 * `into` (reused from frame to frame: nothing is allocated while drawing).
 * The engine fades content layers over a fixed full-screen background; here a full screen is one opaque picture
 * (background included), so: full → full keeps the old one under while the new one comes in (fade + 18 px rise);
 * camera/banner ↔ full fades the full screen over 0.8 s (the engine's background fade); a banner fades out in
 * 0.45 s and comes in from the left (36 px) between 0.35 and 1.05 s. `scale`: output height / 720.
 */
export function transitionFrame(from: SceneKind, to: SceneKind, tau: number, mode: TransitionMode, scale = 1, into: TransitionFrame = newTransitionFrame()): TransitionFrame {
  if (mode === "cut" || tau >= TRANSITION_TOTAL) {
    setLayer(into.out, false);
    setLayer(into.in, to !== "camera", 1);
    into.done = true;
    return into;
  }
  into.done = false;
  if (from === "full") setLayer(into.out, true, to === "full" ? 1 : 1 - easeInOut(tau / FOND_DUR));
  else if (from === "banner") setLayer(into.out, true, 1 - easeInOut(tau / OUT_DUR));
  else setLayer(into.out, false);
  if (to === "full") {
    if (from === "full") {
      const k = easeOut((tau - IN_START) / IN_DUR);
      setLayer(into.in, true, k, 0, tenth(SLIDE_Y * scale * (1 - k)));
    } else {
      setLayer(into.in, true, easeInOut(tau / FOND_DUR));
    }
  } else if (to === "banner") {
    const k = easeOut((tau - IN_START) / IN_DUR);
    setLayer(into.in, true, k, tenth(-SLIDE_X * scale * (1 - k)));
  } else {
    setLayer(into.in, false);
  }
  return into;
}

/** A scene change is animated only when something visible changes (camera → camera is not a transition). */
export function needsTransition(from: SceneKind, to: SceneKind, mode: TransitionMode): boolean {
  return mode !== "cut" && !(from === "camera" && to === "camera");
}
