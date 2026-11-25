import type { LiveOverlays } from "../api/types";

/**
 * The local monitor shows the overlay layer the server draws (the engine's own logo, banner and QR, the very
 * pixels composited over the camera on air). It is revalidated by ETag on a short poll, and at once when the
 * overlay state known locally changes. Without the server, the monitor falls back to its own approximation.
 */
export const LAYER_POLL_MS = 3_000;
/** Pause between attempts while the server does not answer. */
export const LAYER_RETRY_MS = 8_000;
/** Consecutive failures after which the server image is no longer trusted and the approximation is shown. */
export const LAYER_FAILURES_TO_FALLBACK = 2;

/** `server`: the server image is shown. `fallback`: the local approximation. `pending`: nothing yet (first fetch). */
export type LayerMode = "server" | "fallback" | "pending";

export function layerMode(hasImage: boolean, failures: number): LayerMode {
  if (failures >= LAYER_FAILURES_TO_FALLBACK || (failures > 0 && !hasImage)) return "fallback";
  return hasImage ? "server" : "pending";
}

/** Stable key of the overlay state: when it changes, the layer is fetched again right away. */
export function overlaysKey(o: LiveOverlays | null | undefined): string {
  if (!o) return "";
  const { qr, banner, logo } = o;
  return JSON.stringify([qr.visible, qr.url, qr.label, qr.corner, banner.visible, banner.title, banner.subtitle, logo.visible]);
}
