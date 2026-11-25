import { describe, expect, it } from "vitest";
import {
  computeBrowserSourceRect,
  DEFAULT_BROWSER_SOURCE,
  normalizeBrowserSourceConfig,
  validateBrowserSourceUrl,
} from "./browser-source";

describe("validateBrowserSourceUrl", () => {
  it("accepts http and https URLs and prefixes bare hosts with https://", () => {
    expect(validateBrowserSourceUrl("https://cagnotte.example/live")).toBe("https://cagnotte.example/live");
    expect(validateBrowserSourceUrl("http://localhost:3000/counter")).toBe("http://localhost:3000/counter");
    expect(validateBrowserSourceUrl("cagnotte.example/widget")).toBe("https://cagnotte.example/widget");
  });

  it("rejects empty, overly long, or dangerous schemes", () => {
    expect(() => validateBrowserSourceUrl("   ")).toThrow();
    expect(() => validateBrowserSourceUrl("file:///etc/passwd")).toThrow();
    expect(() => validateBrowserSourceUrl("javascript:alert(1)")).toThrow();
    expect(() => validateBrowserSourceUrl("data:text/html,<h1>hi</h1>")).toThrow();
    expect(() => validateBrowserSourceUrl(`https://example.com/${"a".repeat(2100)}`)).toThrow();
  });
});

describe("computeBrowserSourceRect", () => {
  it("covers the entire canvas in fullscreen mode", () => {
    const rect = computeBrowserSourceRect(1280, 720, { mode: "fullscreen", corner: "br", size: "md" });
    expect(rect).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
  });

  it("places overlay inside each corner with increasing size presets", () => {
    const sm = computeBrowserSourceRect(1280, 720, { mode: "overlay", corner: "tl", size: "sm" });
    const md = computeBrowserSourceRect(1280, 720, { mode: "overlay", corner: "tr", size: "md" });
    const lg = computeBrowserSourceRect(1280, 720, { mode: "overlay", corner: "br", size: "lg" });
    const bl = computeBrowserSourceRect(1280, 720, { mode: "overlay", corner: "bl", size: "md" });

    expect(sm.width).toBeLessThan(md.width);
    expect(md.width).toBeLessThan(lg.width);
    expect(sm.x).toBeGreaterThan(0);
    expect(sm.y).toBeGreaterThan(0);
    expect(md.x + md.width).toBeLessThan(1280);
    expect(lg.x + lg.width).toBeLessThan(1280);
    expect(lg.y + lg.height).toBeLessThan(720);
    expect(bl.x).toBe(sm.x);
    expect(bl.y + bl.height).toBe(lg.y + lg.height);
  });
});

describe("normalizeBrowserSourceConfig", () => {
  it("falls back to defaults for missing or invalid values", () => {
    expect(normalizeBrowserSourceConfig(undefined)).toEqual(DEFAULT_BROWSER_SOURCE);
    expect(
      normalizeBrowserSourceConfig({
        url: "https://sada.example",
        visible: true,
        mode: "fullscreen",
        corner: "tl",
        size: "lg",
      }),
    ).toEqual({
      url: "https://sada.example",
      visible: true,
      mode: "fullscreen",
      corner: "tl",
      size: "lg",
    });
  });
});
