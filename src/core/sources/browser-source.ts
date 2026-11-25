import type {
  BrowserSourceConfig,
  BrowserSourceCorner,
  BrowserSourceLayout,
  BrowserSourceMode,
  BrowserSourceSize,
} from "./types";

export const MAX_BROWSER_SOURCE_URL_LENGTH = 2048;

export const DEFAULT_BROWSER_SOURCE: BrowserSourceConfig = {
  url: "",
  visible: false,
  mode: "overlay",
  corner: "br",
  size: "md",
};

export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SIZE_WIDTH_RATIO: Record<BrowserSourceSize, number> = {
  sm: 0.26,
  md: 0.38,
  lg: 0.54,
};

/**
 * Validates and normalizes a Browser Source URL.
 * Only http:// and https:// URLs are allowed (blocks file://, javascript:, data:, etc.).
 */
export function validateBrowserSourceUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Veuillez saisir une URL pour la source web.");
  }
  if (trimmed.length > MAX_BROWSER_SOURCE_URL_LENGTH) {
    throw new Error("L'URL de la source web est trop longue.");
  }
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("URL invalide pour la source web.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Seules les URL http:// et https:// sont autorisées.");
  }
  return parsed.toString();
}

/**
 * Computes the destination rectangle of the browser source on the output canvas.
 */
export function computeBrowserSourceRect(
  canvasWidth: number,
  canvasHeight: number,
  layout: BrowserSourceLayout,
  sourceAspect = 16 / 9,
): OverlayRect {
  const w = Math.max(1, Math.round(canvasWidth));
  const h = Math.max(1, Math.round(canvasHeight));
  if (layout.mode === "fullscreen") {
    return { x: 0, y: 0, width: w, height: h };
  }

  const ratio = SIZE_WIDTH_RATIO[layout.size] ?? SIZE_WIDTH_RATIO.md;
  const safeAspect = sourceAspect > 0.1 && sourceAspect < 10 ? sourceAspect : 16 / 9;
  const margin = Math.round(Math.min(w, h) * 0.03);
  const maxW = Math.max(1, w - margin * 2);
  const maxH = Math.max(1, h - margin * 2);

  let boxW = Math.min(maxW, Math.round(w * ratio));
  let boxH = Math.round(boxW / safeAspect);
  if (boxH > maxH) {
    boxH = maxH;
    boxW = Math.min(maxW, Math.round(boxH * safeAspect));
  }

  const isRight = layout.corner === "tr" || layout.corner === "br";
  const isBottom = layout.corner === "bl" || layout.corner === "br";
  const x = isRight ? w - margin - boxW : margin;
  const y = isBottom ? h - margin - boxH : margin;
  return { x, y, width: boxW, height: boxH };
}

export function normalizeBrowserSourceConfig(input: Partial<BrowserSourceConfig> | null | undefined): BrowserSourceConfig {
  const mode: BrowserSourceMode = input?.mode === "fullscreen" ? "fullscreen" : "overlay";
  const corner: BrowserSourceCorner =
    input?.corner === "tl" || input?.corner === "tr" || input?.corner === "bl" || input?.corner === "br"
      ? input.corner
      : DEFAULT_BROWSER_SOURCE.corner;
  const size: BrowserSourceSize =
    input?.size === "sm" || input?.size === "md" || input?.size === "lg" ? input.size : DEFAULT_BROWSER_SOURCE.size;
  return {
    url: typeof input?.url === "string" ? input.url : "",
    visible: Boolean(input?.visible),
    mode,
    corner,
    size,
  };
}
