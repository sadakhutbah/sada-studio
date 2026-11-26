import { describe, expect, it } from "vitest";
import type { LiveOverlays } from "../src/core/api/types";
import { ellipsize, fitFont, layoutOverlays, medallionLayout, palette, pyRound, scaleFor, type Measure } from "../src/core/program/overlay-layout";

/** Deterministic text width: half the font size per character. */
const measure: Measure = (text, font) => Array.from(text).length * font.size * 0.5;
const qr25 = () => 25; // version 2

const ov = (over: Partial<LiveOverlays> = {}): LiveOverlays => ({
  qr: { visible: false, url: "", label: "", corner: "tr" },
  banner: { visible: false, title: "", subtitle: "" },
  logo: { visible: false },
  ...over,
});

// Expected values computed with the formulas of sada/scenes.py (render_overlays, _overlay_banner, _qr_card, medallion).
describe("overlay geometry (same numbers as scenes.py)", () => {
  it("rounds like Python (half to even)", () => {
    expect([pyRound(0.5), pyRound(1.5), pyRound(2.5), pyRound(2.25), pyRound(3.5)]).toEqual([0, 2, 2, 2, 4]);
    expect(scaleFor(1280, 720).px(1.5)).toBe(2);
    expect(scaleFor(1920, 1080).px(1.5)).toBe(2); // round(2.25)
  });

  it("derives the panel colour from the mosque green", () => {
    expect(palette("#1E7A3C").panel).toEqual([17, 65, 34]);
    expect(palette(undefined).panel).toEqual([17, 65, 34]);
  });

  it("medallion: d 74, ring 2 → 86 px picture, shadow margin 6, 66 px logo", () => {
    expect(medallionLayout(74, 2)).toMatchObject({ size: 86, margin: 6, pad: 2, inner: 66, shadowDy: 1, shadowBlur: 3 });
  });

  it("logo top-left at (40, 30), top-right when the QR takes the top-left corner", () => {
    expect(layoutOverlays(ov({ logo: { visible: true } }), 1280, 720, measure, qr25).logo).toMatchObject({ x: 40, y: 30, size: 86 });
    const l = layoutOverlays(ov({ logo: { visible: true }, qr: { visible: true, url: "https://x.fr", label: "", corner: "tl" } }), 1280, 720, measure, qr25);
    expect(l.logo).toMatchObject({ x: 1280 - 40 - 86, y: 30 });
    expect(l.qr).toMatchObject({ x: 40, y: 40 });
  });

  it("QR card: 5 px cells, 145 px code, 10 px padding, label strip of 30 px, 40 px from the corner", () => {
    const l = layoutOverlays(ov({ qr: { visible: true, url: "https://x.fr", label: " Don ", corner: "br" } }), 1280, 720, measure, qr25);
    expect(l.qr).toMatchObject({ cell: 5, quiet: 2, qrPx: 145, pad: 10, w: 165, h: 195, radius: 10, border: 2, innerRadius: 6 });
    expect(l.qr).toMatchObject({ x: 1280 - 40 - 165, y: 720 - 40 - 195 });
    expect(l.qr!.label).toMatchObject({ text: "Don", x: 82.5, y: 172, anchor: "mm" });
    const noLabel = layoutOverlays(ov({ qr: { visible: true, url: "https://x.fr", label: "", corner: "tr" } }), 1280, 720, measure, qr25);
    expect(noLabel.qr).toMatchObject({ h: 165, x: 1075, y: 40, label: null });
  });

  it("no QR without a URL, no banner without a title (as the engine)", () => {
    const l = layoutOverlays(ov({ qr: { visible: true, url: "", label: "x", corner: "tr" }, banner: { visible: true, title: "  ", subtitle: "s" } }), 1280, 720, measure, qr25);
    expect(l.qr).toBeNull();
    expect(l.banner).toBeNull();
  });

  it("banner with a subtitle: 106 px high, 46 px from the bottom, text at x 83, baselines 48 and 84", () => {
    const b = layoutOverlays(ov({ banner: { visible: true, title: "Collecte", subtitle: "Après la prière" } }), 1280, 720, measure, qr25).banner!;
    expect(b).toMatchObject({ x0: 56, y0: 568, y1: 674, radius: 6, bar: 5, shadowDy: 4, shadowBlur: 10 });
    expect(b.title).toMatchObject({ text: "Collecte", x: 83, y: 616, anchor: "ls", font: { family: "serif", weight: 600, size: 40 } });
    expect(b.sub).toMatchObject({ text: "Après la prière", x: 83, y: 652, font: { family: "sans", weight: 600, size: 24 } });
    // x1 = int(min(max_x1, tx + w_text + 28)): title 8 × 20 = 160, subtitle 15 × 12 = 180.
    expect(b.x1).toBe(83 + 180 + 28);
  });

  it("banner without a subtitle: 74 px, title vertically centred (lm anchor)", () => {
    const b = layoutOverlays(ov({ banner: { visible: true, title: "Collecte", subtitle: "" } }), 1280, 720, measure, qr25).banner!;
    expect(b).toMatchObject({ y0: 600, y1: 674, sub: null });
    expect(b.title).toMatchObject({ y: 600 + 37 + 2, anchor: "lm" });
  });

  it("banner narrowed when the QR sits bottom-right, title shrunk by 2 px steps to fit", () => {
    const long = "T".repeat(60); // 60 × 20 = 1200 px at 40 px
    const b = layoutOverlays(ov({ banner: { visible: true, title: long, subtitle: "" }, qr: { visible: true, url: "u", label: "", corner: "br" } }), 1280, 720, measure, qr25).banner!;
    const maxX1 = 1280 - 40 - 165 - 24;
    const maxText = maxX1 - 24 - 83;
    expect(b.title.font.size % 2).toBe(0);
    expect(measure(long, b.title.font)).toBeLessThanOrEqual(maxText);
    expect(measure(long, { ...b.title.font, size: b.title.font.size + 2 })).toBeGreaterThan(maxText);
    expect(b.x1).toBe(Math.min(maxX1, 83 + measure(long, b.title.font) + 28));
  });

  it("ellipsizes the subtitle and the QR label like _ellipsize", () => {
    const font = { family: "sans", weight: 600, size: 10 } as const;
    expect(ellipsize(measure, "abcdefghij", font, 50)).toBe("abcdefghij");
    expect(ellipsize(measure, "abc efghij", font, 25)).toBe("abc…"); // trailing space dropped (rstrip)
    expect(fitFont(measure, "x".repeat(100), "serif", 600, 40, 10).size).toBe(12);
  });

  it("scales everything by height / 720 (1080p)", () => {
    const l = layoutOverlays(ov({ logo: { visible: true }, qr: { visible: true, url: "u", label: "", corner: "tr" } }), 1920, 1080, measure, qr25);
    expect(l.logo).toMatchObject({ x: 60, y: 45, d: 111, ring: 2, size: 111 + 18 });
    expect(l.qr).toMatchObject({ cell: 7, qrPx: 203, pad: 15, w: 233, x: 1920 - 60 - 233, y: 60 });
  });
});
