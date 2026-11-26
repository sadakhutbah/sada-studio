/**
 * Broadcast quality chosen for the mosque in the Sada back office (Settings → Live → Quality).
 * The server sends it in every heartbeat (`config.stream`); an older server sends nothing and the 720p profile
 * applies, which is what the application always did.
 */
export interface StreamProfile {
  width: number;
  height: number;
  /** Images per second captured and sent. */
  fps: number;
  /** Video bit rate the server encodes for the platforms, kbit/s (informative here). */
  videoKbps: number;
  /** Ceiling of the video bit rate sent to the server, kbit/s. */
  uplinkKbps: number;
}

export const DEFAULT_PROFILE: StreamProfile = { width: 1280, height: 720, fps: 30, videoKbps: 2500, uplinkKbps: 4500 };

const HEIGHTS: Record<number, number> = { 720: 1280, 1080: 1920 };

const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);

/** The profile the server announced, or null when absent or out of what the application supports. */
export function parseProfile(raw: unknown): StreamProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const height = int(r.height);
  const fps = int(r.fps);
  if (height === null || fps === null || !HEIGHTS[height] || fps < 10 || fps > 60) return null;
  const videoKbps = int(r.video_kbps) ?? DEFAULT_PROFILE.videoKbps;
  const uplink = int(r.uplink_kbps) ?? DEFAULT_PROFILE.uplinkKbps;
  return {
    width: HEIGHTS[height],
    height,
    fps,
    videoKbps,
    uplinkKbps: Math.min(20_000, Math.max(DEFAULT_PROFILE.uplinkKbps, uplink)),
  };
}
