import type { ControlRequest, ControlResult } from "@core/control/actions";
import { t } from "@core/messages";

/** What the window can do for an action asked from outside (global shortcut, local API). */
export interface ControlContext {
  mic: {
    muted(): boolean;
    /** Mutes or restores the microphone (and tells the server); the error message when it did not hold, null otherwise. */
    set(muted: boolean): Promise<string | null>;
  };
  browser: {
    state(): "none" | "shown" | "hidden";
    setVisible(visible: boolean): void;
  };
  screen: {
    on(): boolean;
    /** A screen or window is chosen: without one the share cannot be switched on. */
    hasSource(): boolean;
    /** Switches the share on or off; the error message when it could not be switched on, null otherwise. */
    set(on: boolean): Promise<string | null>;
  };
}

const failed = (code: string, message: string): ControlResult => ({ ok: false, code, message });

/**
 * Runs one action of the window. Showing or hiding never asks for confirmation (like in OBS), and there is no action
 * that removes a source: removal stays a deliberate gesture in the Régie panel.
 */
export async function runControlAction(request: ControlRequest, ctx: ControlContext): Promise<ControlResult> {
  switch (request.action) {
    case "mic.toggle":
    case "mic.mute":
    case "mic.unmute": {
      const target = request.action === "mic.toggle" ? !ctx.mic.muted() : request.action === "mic.mute";
      const error = await ctx.mic.set(target);
      const state = { micMuted: ctx.mic.muted() };
      return error ? { ok: false, code: "failed", message: error, state } : { ok: true, state };
    }
    case "browser.toggle":
    case "browser.show":
    case "browser.hide": {
      const current = ctx.browser.state();
      if (current === "none") return failed("no_browser_source", t("control.noBrowserSource"));
      const visible = request.action === "browser.toggle" ? current === "hidden" : request.action === "browser.show";
      if ((current === "shown") !== visible) ctx.browser.setVisible(visible);
      return { ok: true, state: { browser: visible ? "shown" : "hidden" } };
    }
    case "screen.toggle":
    case "screen.start":
    case "screen.stop": {
      const target = request.action === "screen.toggle" ? !ctx.screen.on() : request.action === "screen.start";
      if (target && !ctx.screen.on() && !ctx.screen.hasSource()) return failed("no_screen_source", t("control.noScreenSource"));
      if (target === ctx.screen.on()) return { ok: true, state: { screen: target ? "on" : "off" } };
      const error = await ctx.screen.set(target);
      return error ? { ok: false, code: "failed", message: error, state: { screen: ctx.screen.on() ? "on" : "off" } } : { ok: true, state: { screen: target ? "on" : "off" } };
    }
    default:
      // Scenes are changed in the main process: they never reach the window.
      return failed("unsupported", request.action);
  }
}
