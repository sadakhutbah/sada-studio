import type { LiveOverlays, RegieScene } from "../../core/api/types";

/** What the Régie panel tells the monitor: the scene and overlays currently requested on the server. */
export interface RegieLiveView {
  scene: string;
  scenes: RegieScene[];
  overlays: LiveOverlays;
}

export interface PreviewModel {
  /** Label of the active scene (empty when unknown). */
  sceneLabel: string;
  /** Non-camera scene (slate, custom): the monitor covers the camera with a card instead of the picture. */
  covered: boolean;
  qr: { url: string; label: string; corner: string } | null;
  banner: { title: string; subtitle: string } | null;
  logo: boolean;
}

/**
 * Pure projection of the scene and overlay state onto what the monitor draws. The server composites the real
 * broadcast; this lets the operator see scene/overlay changes right away, from the state already known locally.
 */
export function buildPreview(view: RegieLiveView | null): PreviewModel | null {
  if (!view) return null;
  const sc = view.scenes.find((s) => s.id === view.scene);
  const { qr, banner, logo } = view.overlays;
  return {
    sceneLabel: sc?.label ?? "",
    covered: Boolean(sc) && sc?.kind !== "camera",
    qr: qr.visible && qr.url.trim() ? { url: qr.url.trim(), label: qr.label.trim(), corner: qr.corner } : null,
    banner: banner.visible && (banner.title.trim() || banner.subtitle.trim()) ? { title: banner.title.trim(), subtitle: banner.subtitle.trim() } : null,
    logo: logo.visible,
  };
}
