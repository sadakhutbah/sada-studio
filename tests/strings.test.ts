import { describe, expect, it } from "vitest";
import { fr } from "../src/renderer/src/strings";

describe("settings labels", () => {
  it("provides the labels used by the settings menu", () => {
    expect(fr.settings.button).not.toBe("");
    expect(fr.settings.title).not.toBe("");
    expect(fr.settings.close).not.toBe("");
    for (const k of ["echoCancellation", "noiseSuppression", "autoGainControl"] as const) expect(fr.audio[k]).not.toBe("");
  });
});
