/** Decisions of the scene compositor, kept pure (no DOM) so they can be tested. */

/** What is on screen that the raw camera stream cannot carry. */
export interface CompositorDemand {
  /** A web source is added, loaded and shown. */
  browserVisible: boolean;
  /** The programme is the shared screen or window. */
  screenActive: boolean;
  /** The studio composes the programme and something is drawn over or instead of the camera (scene, overlay, fade). */
  program?: boolean;
}

export type OutputMode = "raw" | "canvas";

/** Canvas (drawn, re-captured) only when something has to be composited; otherwise the source stream goes out untouched. */
export function chooseOutput(d: CompositorDemand): OutputMode {
  return d.browserVisible || d.screenActive || d.program === true ? "canvas" : "raw";
}

/** New canvas size when the video's real resolution differs from it, null when nothing has to change (a resize clears the canvas). */
export function nextCanvasSize(
  canvas: { width: number; height: number },
  video: { videoWidth: number; videoHeight: number } | null,
): { width: number; height: number } | null {
  if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) return null;
  if (canvas.width === video.videoWidth && canvas.height === video.videoHeight) return null;
  return { width: video.videoWidth, height: video.videoHeight };
}

/** Identity of the tracks a stream carries: two streams with the same key send the same media. */
export function streamKey(s: MediaStream | null): string {
  return s ? s.getTracks().map((t) => t.id).join("|") : "";
}
