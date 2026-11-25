import { afterEach, describe, expect, it, vi } from "vitest";
import { findRemembered, normalizeRememberedScreen, rememberedFrom } from "../src/core/sources/remembered";
import type { DesktopSourceInfo } from "../src/core/sources/types";
import { loadPrefs, savePrefs } from "../src/renderer/src/prefs";

const src = (id: string, name: string, kind: "screen" | "window" = id.startsWith("screen:") ? "screen" : "window"): DesktopSourceInfo => ({ id, name, kind, thumbnailDataUrl: "" });

describe("normalizeRememberedScreen", () => {
  it("keeps a valid record and drops anything else", () => {
    expect(normalizeRememberedScreen({ id: "window:42:0", name: "Slides", kind: "window" })).toEqual({ id: "window:42:0", name: "Slides", kind: "window" });
    expect(normalizeRememberedScreen(null)).toBeNull();
    expect(normalizeRememberedScreen("screen:0:0")).toBeNull();
    expect(normalizeRememberedScreen({ id: "../etc", name: "x", kind: "window" })).toBeNull();
    expect(normalizeRememberedScreen({ id: "window:1:0", name: "x", kind: "screen" })).toBeNull();
    expect(normalizeRememberedScreen({ id: "window:1:0", name: 3, kind: "window" })).toBeNull();
  });
});

describe("findRemembered", () => {
  const list = [src("screen:0:0", "Screen 1"), src("window:100:0", "Slides"), src("window:200:0", "Notes")];

  it("finds the same id again, even when the window was renamed", () => {
    expect(findRemembered({ id: "window:100:0", name: "Old title", kind: "window" }, list)?.id).toBe("window:100:0");
  });

  it("follows a window whose id changed after a restart by its name", () => {
    expect(findRemembered({ id: "window:999:0", name: "Notes", kind: "window" }, list)?.id).toBe("window:200:0");
  });

  it("returns null when the source is gone, so the picker is shown", () => {
    expect(findRemembered({ id: "window:999:0", name: "Closed", kind: "window" }, list)).toBeNull();
    expect(findRemembered({ id: "screen:5:0", name: "Screen 3", kind: "screen" }, list)).toBeNull();
    expect(findRemembered(null, list)).toBeNull();
  });

  it("does not guess between two windows with the same name", () => {
    const twins = [src("window:1:0", "Chrome"), src("window:2:0", "Chrome")];
    expect(findRemembered({ id: "window:9:0", name: "Chrome", kind: "window" }, twins)).toBeNull();
  });

  it("never mixes a screen with a window of the same name", () => {
    expect(findRemembered({ id: "screen:7:0", name: "Slides", kind: "screen" }, list)).toBeNull();
  });
});

describe("last screen persistence", () => {
  afterEach(() => vi.unstubAllGlobals());

  function fakeStorage() {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) });
  }

  it("is saved with the preferences and restored at the next launch", () => {
    fakeStorage();
    expect(loadPrefs().lastScreen).toBeNull();
    savePrefs({ ...loadPrefs(), lastScreen: rememberedFrom(src("window:100:0", "Slides")) });
    expect(loadPrefs().lastScreen).toEqual({ id: "window:100:0", name: "Slides", kind: "window" });
  });

  it("ignores a corrupted record", () => {
    fakeStorage();
    localStorage.setItem("sada-studio.prefs", JSON.stringify({ lastScreen: { id: 5 } }));
    expect(loadPrefs().lastScreen).toBeNull();
  });
});
