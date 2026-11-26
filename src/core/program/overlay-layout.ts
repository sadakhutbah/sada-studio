/**
 * Geometry of the live overlays (logo, free banner, QR card), the same numbers as the engine's
 * `sada/scenes.py::SceneRenderer.render_overlays`, `_overlay_banner`, `_qr_card` and `medallion` (1280×720 mockup,
 * scaled by height/720, Python rounding). Pure: text widths come from an injected `measure`, the QR size from the
 * caller, so the numbers can be checked against the server's without a canvas.
 */
import type { LiveOverlays, OverlayCorner } from "../api/types";
import { visibleOverlays } from "./logic";

export const BASE_HEIGHT = 720;
export const DEFAULT_DARK_GREEN = "#1E7A3C";

export type Rgb = readonly [number, number, number];
export const IVORY: Rgb = [244, 240, 230];
export const IVORY_DIM: Rgb = [214, 210, 198];
export const GOLD: Rgb = [200, 169, 106];
export const QR_DARK: Rgb = [14, 24, 19];
/** Alpha of the overlay panels (`_alpha(self.panel, 244)`). */
export const PANEL_ALPHA = 244 / 255;

/** Python's `round()` (half to even), so `px(1.5)` is 2 and `px(2.5)` is 2, as on the server. */
export function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

const floorDiv = (a: number, b: number) => Math.floor(a / b);

export function parseHex(c: string | undefined): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec((c ?? "").trim());
  const h = m ? m[1]! : DEFAULT_DARK_GREEN.slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** `_mix`: channel-wise linear mix, Python-rounded. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [0, 1, 2].map((i) => pyRound(a[i]! + (b[i]! - a[i]!) * t)) as unknown as Rgb;
}

/** The colours the engine derives from the mosque green (`SceneRenderer.__init__`, `_emblem`). */
export function palette(darkGreen?: string) {
  const dark = parseHex(darkGreen);
  return {
    dark,
    panel: mix(dark, [6, 18, 12], 0.55),
    deep: mix(dark, [6, 18, 12], 0.62),
    deepTop: mix(dark, [4, 12, 8], 0.74),
    pale: mix(dark, [255, 255, 255], 0.86),
  };
}

export interface Scale {
  W: number;
  H: number;
  s: number;
  px(v: number): number;
}

export function scaleFor(W: number, H: number): Scale {
  const s = H / BASE_HEIGHT;
  return { W, H, s, px: (v) => pyRound(v * s) };
}

/** SERIF = EB Garamond SemiBold, SANS_SB = Source Sans 3 Semibold, SANS = Source Sans 3 Regular. */
export interface FontSpec {
  family: "serif" | "sans";
  weight: 400 | 600;
  size: number;
}
export type Measure = (text: string, font: FontSpec) => number;

/** `_fit`: shrinks by 2 px while the text overflows, down to 12 px. */
export function fitFont(measure: Measure, text: string, family: FontSpec["family"], weight: FontSpec["weight"], size: number, maxW: number): FontSpec {
  let f: FontSpec = { family, weight, size };
  while (f.size > 12 && measure(text, f) > maxW) f = { family, weight, size: f.size - 2 };
  return f;
}

/** `_ellipsize`: drops characters until "text…" fits (code points, as Python slices). */
export function ellipsize(measure: Measure, text: string, font: FontSpec, maxW: number): string {
  if (measure(text, font) <= maxW) return text;
  const chars = Array.from(text);
  while (chars.length && measure(chars.join("") + "…", font) > maxW) chars.pop();
  return chars.join("").trimEnd() + "…";
}

export interface MedallionLayout {
  /** Top-left of the medallion picture, shadow margin included. */
  x: number;
  y: number;
  /** Side of the picture (`d + 2 * margin`). */
  size: number;
  d: number;
  ring: number;
  pad: number;
  margin: number;
  /** Side of the logo disc inside the ring. */
  inner: number;
  shadowDy: number;
  /** Gaussian blur radius (Pillow) of the shadow. */
  shadowBlur: number;
}

/** `medallion(d, ring, pad)`: white disc + logo + gold ring, with a soft shadow. */
export function medallionLayout(d: number, ring: number, pad?: number): MedallionLayout {
  const p = pad ?? Math.max(2, floorDiv(d, 30));
  const m = Math.max(6, floorDiv(d, 12));
  return {
    x: 0,
    y: 0,
    size: d + 2 * m,
    d,
    ring,
    pad: p,
    margin: m,
    inner: d - 2 * ring - 2 * p,
    shadowDy: Math.max(1, floorDiv(d, 40)),
    shadowBlur: m / 2,
  };
}

export interface TextLayout {
  text: string;
  font: FontSpec;
  x: number;
  y: number;
  /** Pillow anchor: `ls` left/baseline, `lm` left/middle, `mm` centre/middle. */
  anchor: "ls" | "lm" | "mm";
  color: Rgb;
}

export interface QrCardLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
  border: number;
  pad: number;
  cell: number;
  quiet: number;
  qrPx: number;
  innerRadius: number;
  modules: number;
  label: TextLayout | null;
}

/** `_qr_card`: QR (`modules` per side) on a white rounded box, panel with a gold rim, optional label. */
export function qrCardLayout(sc: Scale, modules: number, rawLabel: string, measure: Measure): QrCardLayout {
  const { px } = sc;
  const quiet = 2;
  const target = px(152);
  const cell = Math.max(2, floorDiv(target, modules + 2 * quiet));
  const qrPx = cell * (modules + 2 * quiet);
  const pad = px(10);
  const label = rawLabel.trim();
  const fLbl: FontSpec = { family: "sans", weight: 600, size: px(18) };
  const w = qrPx + 2 * pad;
  const lblH = label ? px(30) : 0;
  const h = qrPx + 2 * pad + lblH;
  return {
    x: 0,
    y: 0,
    w,
    h,
    radius: px(10),
    border: Math.max(1, px(1.5)),
    pad,
    cell,
    quiet,
    qrPx,
    innerRadius: px(6),
    modules,
    label: label
      ? { text: ellipsize(measure, label, fLbl, w - 2 * pad), font: fLbl, x: w / 2, y: pad + qrPx + lblH / 2 + px(2), anchor: "mm", color: IVORY }
      : null,
  };
}

export interface BannerLayout {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  radius: number;
  bar: number;
  shadowDy: number;
  shadowBlur: number;
  title: TextLayout;
  sub: TextLayout | null;
}

/** `_overlay_banner`: free lower-third (only the right corners rounded, gold rule on the left). */
export function bannerLayout(sc: Scale, title: string, subtitle: string, maxRight: number, measure: Measure): BannerLayout {
  const { px, H } = sc;
  const hasSub = subtitle.trim() !== "";
  const h = hasSub ? px(106) : px(74);
  const x0 = px(56);
  const y1 = H - px(46);
  const y0 = y1 - h;
  const tx = x0 + px(5) + px(22);
  const maxX1 = Math.max(tx + px(180), maxRight);
  const maxText = maxX1 - px(24) - tx;
  const fT = fitFont(measure, title, "serif", 600, px(40), maxText);
  const fS: FontSpec = { family: "sans", weight: 600, size: px(24) };
  const sub = hasSub ? ellipsize(measure, subtitle.trim(), fS, maxText) : "";
  const wText = Math.max(measure(title, fT), sub ? measure(sub, fS) : 0);
  const x1 = Math.trunc(Math.min(maxX1, tx + wText + px(28)));
  return {
    x0,
    y0,
    x1,
    y1,
    radius: px(6),
    bar: px(5),
    shadowDy: px(4),
    shadowBlur: px(10),
    title: hasSub
      ? { text: title, font: fT, x: tx, y: y0 + px(48), anchor: "ls", color: IVORY }
      : { text: title, font: fT, x: tx, y: y0 + h / 2 + px(2), anchor: "lm", color: IVORY },
    sub: hasSub ? { text: sub, font: fS, x: tx, y: y0 + px(84), anchor: "ls", color: IVORY_DIM } : null,
  };
}

export interface OverlayLayout {
  logo: MedallionLayout | null;
  banner: BannerLayout | null;
  qr: (QrCardLayout & { url: string; corner: OverlayCorner }) | null;
}

/**
 * `render_overlays`: logo top-left (top-right when the QR takes the top-left corner), banner at the bottom left
 * (narrowed when the QR sits bottom-right), QR card in its corner, 40 px from the edges.
 * `qrModules(url)`: modules per side of the code for that URL.
 */
export function layoutOverlays(o: LiveOverlays, W: number, H: number, measure: Measure, qrModules: (url: string) => number): OverlayLayout {
  const sc = scaleFor(W, H);
  const { px } = sc;
  const vis = visibleOverlays(o);
  const corner: OverlayCorner = o.qr.corner || "tr";
  const margin = px(40);
  let qr: OverlayLayout["qr"] = null;
  if (vis.qr) {
    const card = qrCardLayout(sc, qrModules(o.qr.url), String(o.qr.label ?? ""), measure);
    const x = corner === "tl" || corner === "bl" ? margin : W - margin - card.w;
    const y = corner === "tl" || corner === "tr" ? margin : H - margin - card.h;
    qr = { ...card, x, y, url: o.qr.url, corner };
  }
  let logo: MedallionLayout | null = null;
  if (vis.logo) {
    const med = medallionLayout(px(74), Math.max(1, px(1.5)));
    const x = vis.qr && corner === "tl" ? W - margin - med.size : margin;
    logo = { ...med, x, y: px(30) };
  }
  let banner: BannerLayout | null = null;
  if (vis.banner) {
    let maxRight = W - px(56);
    if (qr && corner === "br") maxRight = W - margin - qr.w - px(24);
    banner = bannerLayout(sc, o.banner.title.trim(), String(o.banner.subtitle ?? ""), maxRight, measure);
  }
  return { logo, banner, qr };
}
