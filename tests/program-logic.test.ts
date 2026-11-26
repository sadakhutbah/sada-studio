import { describe, expect, it } from "vitest";
import type { LiveOverlays } from "../src/core/api/types";
import {
  hasVisibleOverlay,
  layerOrder,
  localCompositing,
  needsTransition,
  programNeedsCanvas,
  programSceneKind,
  transitionFrame,
  TRANSITION_TOTAL,
} from "../src/core/program/logic";
import type { ProgramView } from "../src/core/program/types";
import { chooseOutput } from "../src/core/sources/compositor-logic";

const off: LiveOverlays = {
  qr: { visible: false, url: "", label: "", corner: "tr" },
  banner: { visible: false, title: "", subtitle: "" },
  logo: { visible: false },
};
const view = (over: Partial<ProgramView> = {}): ProgramView => ({
  scene: "khutba",
  sceneKind: "camera",
  scenes: [],
  overlays: off,
  micMuted: false,
  compositing: "studio",
  ...over,
});

describe("who composes", () => {
  it("composes locally when the studio is the publisher, or always in setup mode", () => {
    expect(localCompositing(view(), false)).toBe(true);
    expect(localCompositing(view({ compositing: "server" }), false)).toBe(false);
    expect(localCompositing(view({ compositing: "server" }), true)).toBe(true);
    expect(localCompositing(null, true)).toBe(false);
  });

  it("needs the canvas for a visible overlay, a non-camera scene or a running transition", () => {
    expect(programNeedsCanvas(view(), false)).toBe(false);
    expect(programNeedsCanvas(view({ overlays: { ...off, logo: { visible: true } } }), false)).toBe(true);
    expect(programNeedsCanvas(view({ sceneKind: "full" }), false)).toBe(true);
    expect(programNeedsCanvas(view({ sceneKind: "banner" }), false)).toBe(true);
    expect(programNeedsCanvas(view(), false, true)).toBe(true);
    // The server composes: the camera goes out untouched, whatever is shown.
    expect(programNeedsCanvas(view({ compositing: "server", sceneKind: "full" }), false)).toBe(false);
  });

  it("counts an overlay only when the engine would draw it", () => {
    expect(hasVisibleOverlay({ ...off, qr: { visible: true, url: "", label: "x", corner: "tr" } })).toBe(false);
    expect(hasVisibleOverlay({ ...off, banner: { visible: true, title: " ", subtitle: "x" } })).toBe(false);
    expect(hasVisibleOverlay({ ...off, banner: { visible: true, title: "Annonce", subtitle: "" } })).toBe(true);
  });

  it("reads the scene kind from scene_kind, else from the older kind", () => {
    expect(programSceneKind({ id: "priere", kind: "slate", label: "", scene_kind: "full" })).toBe("full");
    expect(programSceneKind({ id: "x", kind: "camera", label: "" })).toBe("camera");
    expect(programSceneKind({ id: "khutba", kind: "slate", label: "" })).toBe("banner");
    expect(programSceneKind({ id: "priere", kind: "slate", label: "" })).toBe("full");
    expect(programSceneKind(undefined)).toBe("camera");
  });
});

describe("chooseOutput", () => {
  it("goes to the canvas for the programme too", () => {
    expect(chooseOutput({ browserVisible: false, screenActive: false, program: false })).toBe("raw");
    expect(chooseOutput({ browserVisible: false, screenActive: false, program: true })).toBe("canvas");
    expect(chooseOutput({ browserVisible: false, screenActive: false })).toBe("raw");
  });
});

describe("layer order", () => {
  const base = { local: true, browser: "none" as const, sceneIn: "camera" as const, sceneOut: null, sceneInOpaque: false, overlays: false };
  it("camera, scene, web source, overlays — bottom to top", () => {
    expect(layerOrder({ ...base, sceneIn: "banner", browser: "overlay", overlays: true })).toEqual(["camera", "scene-in", "browser", "overlays"]);
  });
  it("a steady opaque full screen hides the camera (not drawn)", () => {
    expect(layerOrder({ ...base, sceneIn: "full", sceneInOpaque: true })).toEqual(["scene-in"]);
    expect(layerOrder({ ...base, sceneIn: "full", sceneInOpaque: false })).toEqual(["camera", "scene-in"]);
  });
  it("draws the outgoing scene under the incoming one during a transition", () => {
    expect(layerOrder({ ...base, sceneIn: "full", sceneOut: "banner", sceneInOpaque: true })).toEqual(["camera", "scene-out", "scene-in"]);
  });
  it("a fullscreen web source covers camera and scene, overlays stay on top", () => {
    expect(layerOrder({ ...base, sceneIn: "full", browser: "fullscreen", overlays: true })).toEqual(["browser", "overlays"]);
  });
  it("when the server composes, only the camera and the web source", () => {
    expect(layerOrder({ ...base, local: false, sceneIn: "full", overlays: true, browser: "overlay" })).toEqual(["camera", "browser"]);
  });
});

describe("transitions (sada/transitions.py timing)", () => {
  it("fade lasts 1.05 s, cut is immediate", () => {
    expect(TRANSITION_TOTAL).toBeCloseTo(1.05);
    expect(transitionFrame("camera", "full", 0, "cut")).toMatchObject({ done: true, in: { visible: true, alpha: 1 }, out: { visible: false } });
    expect(transitionFrame("camera", "full", 1.05, "fade").done).toBe(true);
    expect(needsTransition("camera", "camera", "fade")).toBe(false);
    expect(needsTransition("camera", "full", "cut")).toBe(false);
  });

  it("camera → full screen: the full screen fades in over 0.8 s (the engine's background fade)", () => {
    expect(transitionFrame("camera", "full", 0, "fade").in.alpha).toBeCloseTo(0);
    expect(transitionFrame("camera", "full", 0.4, "fade").in.alpha).toBeCloseTo(0.5);
    expect(transitionFrame("camera", "full", 0.8, "fade").in.alpha).toBeCloseTo(1);
    expect(transitionFrame("camera", "full", 0.4, "fade").out.visible).toBe(false);
  });

  it("full → full: the old one stays under, the new one comes in (0.35 → 1.05 s) rising 18 px", () => {
    const start = transitionFrame("full", "full", 0.35, "fade", 1);
    expect(start.out).toMatchObject({ visible: true, alpha: 1 });
    expect(start.in).toMatchObject({ alpha: 0, dy: 18 });
    const later = transitionFrame("full", "full", 0.7, "fade", 1.5);
    expect(later.in.alpha).toBeCloseTo(1 - 0.5 ** 3);
    expect(later.in.dy).toBeCloseTo(Math.round(18 * 1.5 * 0.125 * 10) / 10);
  });

  it("banner out in 0.45 s, banner in from the left (36 px)", () => {
    expect(transitionFrame("banner", "camera", 0.225, "fade").out.alpha).toBeCloseTo(0.5);
    expect(transitionFrame("banner", "camera", 0.45, "fade").out.alpha).toBeCloseTo(0);
    const f = transitionFrame("camera", "banner", 0.35, "fade");
    expect(f.in).toMatchObject({ alpha: 0, dx: -36 });
  });

  it("reuses the frame object it is given (no allocation per frame)", () => {
    const into = transitionFrame("camera", "full", 0, "fade");
    expect(transitionFrame("full", "camera", 0.2, "fade", 1, into)).toBe(into);
    expect(into.in.visible).toBe(false);
    expect(into.out.visible).toBe(true);
  });
});
