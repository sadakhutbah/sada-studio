/**
 * Draws the live overlays (logo medallion, free banner, QR card) into an offscreen canvas, with the geometry of
 * `overlay-layout.ts` (the engine's). Redrawn only when the state, the logo, the size or the fonts change; the
 * compositor then lays the canvas over each frame with one `drawImage`.
 */
import type { LiveOverlays } from "../api/types";
import {
  GOLD,
  layoutOverlays,
  palette,
  PANEL_ALPHA,
  QR_DARK,
  type BannerLayout,
  type FontSpec,
  type MedallionLayout,
  type OverlayLayout,
  type QrCardLayout,
  type Rgb,
  type TextLayout,
} from "./overlay-layout";
import { encodeQr, type QrMatrix } from "./qr";

/** The application's own fonts (EB Garamond for titles, Source Sans 3 for text), as the engine's; Arabic falls back. */
export const FONT_FAMILIES: Record<FontSpec["family"], string> = {
  serif: '"EB Garamond", "Amiri", Georgia, serif',
  sans: '"Source Sans 3 Variable", "Source Sans 3", "Noto Naskh Arabic", "Segoe UI", Arial, sans-serif',
};
export const cssFont = (f: FontSpec) => `${f.weight} ${f.size}px ${FONT_FAMILIES[f.family]}`;
/** The faces to load before the first drawing (fontsource registers them lazily). */
export const OVERLAY_FONTS = [cssFont({ family: "serif", weight: 600, size: 40 }), cssFont({ family: "sans", weight: 600, size: 24 }), cssFont({ family: "sans", weight: 400, size: 24 })];

const rgba = (c: Rgb, a = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

type Ctx = CanvasRenderingContext2D;

export class OverlayPainter {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: Ctx;
  private key = "";
  private empty = true;
  private qr: { url: string; matrix: QrMatrix } | null = null;
  private emblem: HTMLCanvasElement | null = null;
  private emblemKey = "";

  constructor() {
    this.canvas = document.createElement("canvas");
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
  }

  /** True when nothing is drawn (no visible overlay). */
  get isEmpty(): boolean {
    return this.empty;
  }

  /**
   * Redraws the layer if anything changed. `logoKey` identifies the logo picture (its ETag), `epoch` anything else
   * that invalidates the drawing (fonts loaded).
   */
  update(o: LiveOverlays, W: number, H: number, logo: CanvasImageSource | null, logoKey: string, darkGreen: string | undefined, epoch: number): void {
    const key = JSON.stringify([o, W, H, logo ? logoKey : "", darkGreen ?? "", epoch]);
    if (key === this.key) return;
    this.key = key;
    const c = this.canvas;
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    } else {
      this.ctx.clearRect(0, 0, W, H);
    }
    const layout = layoutOverlays(o, W, H, (text, font) => this.measure(text, font), (url) => this.qrMatrix(url).size);
    this.empty = !layout.logo && !layout.banner && !layout.qr;
    this.paint(layout, logo, palette(darkGreen));
  }

  private measure(text: string, font: FontSpec): number {
    const f = cssFont(font);
    if (this.ctx.font !== f) this.ctx.font = f;
    return this.ctx.measureText(text).width;
  }

  private qrMatrix(url: string): QrMatrix {
    if (this.qr?.url !== url) this.qr = { url, matrix: encodeQr(url, "L") };
    return this.qr.matrix;
  }

  private paint(l: OverlayLayout, logo: CanvasImageSource | null, pal: ReturnType<typeof palette>): void {
    const ctx = this.ctx;
    // Same order as render_overlays: logo, banner, QR.
    if (l.logo) this.medallion(ctx, l.logo, logo, pal);
    if (l.banner) this.banner(ctx, l.banner, pal.panel);
    if (l.qr) this.qrCard(ctx, l.qr, this.qrMatrix(l.qr.url), pal.panel);
  }

  private medallion(ctx: Ctx, m: MedallionLayout, logo: CanvasImageSource | null, pal: ReturnType<typeof palette>): void {
    const r = m.d / 2;
    const cx = m.x + m.margin + r;
    const cy = m.y + m.margin + r;
    ctx.save();
    // Pillow's GaussianBlur(radius) is a standard deviation; the canvas blur is twice it.
    ctx.shadowColor = "rgba(0, 0, 0, 0.47)";
    ctx.shadowBlur = m.shadowBlur * 2;
    ctx.shadowOffsetY = m.shadowDy;
    ctx.fillStyle = rgba(GOLD);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(cx, cy, r - m.ring, 0, Math.PI * 2);
    ctx.fill();
    const ix = m.x + m.margin + m.ring + m.pad;
    const iy = m.y + m.margin + m.ring + m.pad;
    if (logo) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(ix + m.inner / 2, iy + m.inner / 2, m.inner / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(logo, ix, iy, m.inner, m.inner);
      ctx.restore();
    } else {
      ctx.drawImage(this.emblemOf(m.inner, pal), ix, iy);
    }
  }

  /** `_emblem`: the neutral crescent and star shown while the mosque has no logo. */
  private emblemOf(size: number, pal: ReturnType<typeof palette>): HTMLCanvasElement {
    const key = `${size}|${pal.dark.join(",")}`;
    if (this.emblem && this.emblemKey === key) return this.emblem;
    const c = (this.emblem ??= document.createElement("canvas"));
    c.width = size;
    c.height = size;
    this.emblemKey = key;
    const g = c.getContext("2d")!;
    const s = size;
    g.clearRect(0, 0, s, s);
    g.save();
    g.beginPath();
    g.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = rgba(pal.pale);
    g.fillRect(0, 0, s, s);
    // Crescent: a disc of radius 0.58 s in the mosque green, bitten by the same disc shifted up-right.
    g.fillStyle = rgba(pal.dark);
    g.beginPath();
    g.arc(s / 2, s / 2, s * 0.58, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = rgba(pal.pale);
    g.beginPath();
    g.arc(s * 0.7, s * 0.3, s * 0.58, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = rgba(GOLD);
    const sx = s * 0.66;
    const sy = s * 0.36;
    const e = s * 0.085;
    for (const pts of [
      [sx, sy - e, sx + e * 0.45, sy, sx, sy + e, sx - e * 0.45, sy],
      [sx - e * 0.8, sy, sx, sy - e * 0.42, sx + e * 0.8, sy, sx, sy + e * 0.42],
    ]) {
      g.beginPath();
      g.moveTo(pts[0]!, pts[1]!);
      for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i]!, pts[i + 1]!);
      g.closePath();
      g.fill();
    }
    g.restore();
    return c;
  }

  private banner(ctx: Ctx, b: BannerLayout, panel: Rgb): void {
    const w = b.x1 - b.x0 + 1;
    const h = b.y1 - b.y0 + 1;
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.43)";
    ctx.shadowBlur = b.shadowBlur * 2;
    ctx.shadowOffsetY = b.shadowDy;
    ctx.fillStyle = rgba(panel, PANEL_ALPHA);
    ctx.beginPath();
    ctx.roundRect(b.x0, b.y0, w, h, [0, b.radius, b.radius, 0]);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = rgba(GOLD);
    ctx.fillRect(b.x0, b.y0, b.bar, h);
    this.text(ctx, b.title);
    if (b.sub) this.text(ctx, b.sub);
  }

  private qrCard(ctx: Ctx, q: QrCardLayout, code: QrMatrix, panel: Rgb): void {
    ctx.save();
    ctx.translate(q.x, q.y);
    ctx.fillStyle = rgba(panel, PANEL_ALPHA);
    ctx.beginPath();
    ctx.roundRect(0, 0, q.w, q.h, q.radius);
    ctx.fill();
    ctx.strokeStyle = rgba(GOLD);
    ctx.lineWidth = q.border;
    ctx.beginPath();
    ctx.roundRect(q.border / 2, q.border / 2, q.w - q.border, q.h - q.border, Math.max(0, q.radius - q.border / 2));
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.roundRect(q.pad, q.pad, q.qrPx, q.qrPx, q.innerRadius);
    ctx.fill();
    ctx.fillStyle = rgba(QR_DARK);
    const n = code.size;
    for (let row = 0; row < n; row++) {
      const y = q.pad + (row + q.quiet) * q.cell;
      for (let col = 0; col < n; col++) {
        if (code.isDark(row, col)) ctx.fillRect(q.pad + (col + q.quiet) * q.cell, y, q.cell, q.cell);
      }
    }
    if (q.label) this.text(ctx, q.label);
    ctx.restore();
  }

  /** Pillow anchors: `l`/`m` horizontally, `s` (baseline) or `m` (halfway between ascender and descender). */
  private text(ctx: Ctx, t: TextLayout): void {
    ctx.font = cssFont(t.font);
    ctx.fillStyle = rgba(t.color);
    ctx.textAlign = t.anchor[0] === "m" ? "center" : "left";
    ctx.textBaseline = "alphabetic";
    let y = t.y;
    if (t.anchor[1] === "m") {
      const m = ctx.measureText(t.text);
      y += (m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2;
    }
    ctx.fillText(t.text, t.x, y);
  }
}
