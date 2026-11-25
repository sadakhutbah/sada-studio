import { describe, expect, it } from "vitest";
import type { LiveOverlays, RegieScene } from "../src/core/api/types";
import { buildPreview } from "../src/renderer/src/regie-preview";

const scenes: RegieScene[] = [
  { id: "khutba", kind: "camera", label: "Direct" },
  { id: "priere", kind: "slate", label: "Prière" },
];
const off: LiveOverlays = {
  qr: { visible: false, url: "", label: "", corner: "tr" },
  banner: { visible: false, title: "", subtitle: "" },
  logo: { visible: false },
};

describe("buildPreview", () => {
  it("returns null without state", () => {
    expect(buildPreview(null)).toBeNull();
  });
  it("keeps the camera visible on a camera scene", () => {
    const m = buildPreview({ scene: "khutba", scenes, overlays: off });
    expect(m).toMatchObject({ sceneLabel: "Direct", covered: false, qr: null, banner: null, logo: false });
  });
  it("covers the picture on a slate scene", () => {
    expect(buildPreview({ scene: "priere", scenes, overlays: off })?.covered).toBe(true);
  });
  it("does not cover on an unknown scene", () => {
    expect(buildPreview({ scene: "", scenes, overlays: off })).toMatchObject({ sceneLabel: "", covered: false });
  });
  it("shows only visible overlays that have content", () => {
    const m = buildPreview({
      scene: "khutba",
      scenes,
      overlays: {
        qr: { visible: true, url: " https://x.fr ", label: " Don ", corner: "bl" },
        banner: { visible: true, title: "", subtitle: "" },
        logo: { visible: true },
      },
    });
    expect(m?.qr).toEqual({ url: "https://x.fr", label: "Don", corner: "bl" });
    expect(m?.banner).toBeNull();
    expect(m?.logo).toBe(true);
  });
});
