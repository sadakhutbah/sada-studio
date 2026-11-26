import type { ControlRequest, ControlResult } from "@core/control/actions";
import { pickScene } from "@core/control/scenes";
import { t } from "@core/messages";

/** What the window can do for an action asked from outside (global shortcut, local API). */
export interface ControlContext {
  mic: {
    muted(): boolean;
    /**
     * Mutes or restores the microphone at once (and tells the server in the background). `error`: the change did not
     * happen; `warning`: it did, but the server could not be told yet.
     */
    set(muted: boolean): Promise<{ error: string | null; warning?: string | null }>;
  };
  /**
   * The Régie scenes, through the same store as the panel (optimistic, rev-filtered). Absent or not `ready()` (Régie
   * not loaded): the action answers `ui_unavailable` and the main process changes the scene by itself.
   */
  scene?: {
    ready(): boolean;
    ids(): string[];
    current(): string | undefined;
    take(sceneId: string): Promise<string | null>;
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
      const { error, warning } = await ctx.mic.set(target);
      const state = { micMuted: ctx.mic.muted() };
      if (error) return { ok: false, code: "failed", message: error, state };
      return warning ? { ok: true, message: warning, state } : { ok: true, state };
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
    case "scene.next":
    case "scene.previous":
    case "scene.set": {
      const sc = ctx.scene;
      if (!sc?.ready()) return failed("ui_unavailable", t("control.uiUnavailable"));
      const ids = sc.ids();
      let target: string | null;
      if (request.action === "scene.set") {
        target = request.scene && ids.includes(request.scene) ? request.scene : null;
        if (!target) return failed("unknown_scene", t("control.unknownScene", { scene: request.scene ?? "" }));
      } else {
        const direction = request.action === "scene.next" ? "next" : "previous";
        target = pickScene(ids, sc.current() || undefined, direction);
        if (!target) return failed("no_scene", t(direction === "next" ? "control.noNextScene" : "control.noPreviousScene"));
      }
      const error = await sc.take(target);
      const scene = sc.current();
      return error ? { ok: false, code: "failed", message: error, state: scene ? { scene } : {} } : { ok: true, state: { scene: scene || target } };
    }
    default:
      return failed("unsupported", request.action);
  }
}
