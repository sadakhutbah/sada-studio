/** How long an arming stays valid: the window asks for the capture right after arming it. */
export const PAGE_AUDIO_GRANT_MS = 10_000;

/**
 * One-shot permission for the application window's next `getDisplayMedia` call to receive the web page's sound instead
 * of the shared screen. Chromium's tab capture (`getUserMedia` with `chromeMediaSource: "tab"`) is refused outright in
 * Electron, so the page's frame is handed to the display-media handler instead, and only after the window asked for it.
 */
export class PageAudioGrant {
  private armedAt: number | null = null;

  arm(now: number): void {
    this.armedAt = now;
  }

  /** True once per arming, and only while it is fresh. */
  consume(now: number): boolean {
    const at = this.armedAt;
    this.armedAt = null;
    return at !== null && now - at <= PAGE_AUDIO_GRANT_MS;
  }
}
