import { describe, expect, it, vi } from "vitest";
import { runControlAction, type ControlContext } from "../src/renderer/src/control-actions";

function context(init: { muted?: boolean; browser?: "none" | "shown" | "hidden"; screenOn?: boolean; source?: boolean; micError?: string; micWarning?: string; screenError?: string } = {}) {
  const s = { muted: init.muted ?? false, browser: init.browser ?? "hidden", screenOn: init.screenOn ?? false };
  const setVisible = vi.fn((v: boolean) => void (s.browser = v ? "shown" : "hidden"));
  const micSet = vi.fn(async (m: boolean) => {
    if (init.micError) return { error: init.micError };
    s.muted = m;
    return { error: null, ...(init.micWarning ? { warning: init.micWarning } : {}) };
  });
  const screenSet = vi.fn(async (on: boolean) => {
    if (init.screenError) return init.screenError;
    s.screenOn = on;
    return null;
  });
  const ctx: ControlContext = {
    mic: { muted: () => s.muted, set: micSet },
    browser: { state: () => s.browser, setVisible },
    screen: { on: () => s.screenOn, hasSource: () => init.source ?? true, set: screenSet },
  };
  return { ctx, setVisible, micSet, screenSet };
}

describe("runControlAction: microphone", () => {
  it("mutes and restores", async () => {
    const { ctx } = context();
    expect(await runControlAction({ action: "mic.toggle" }, ctx)).toEqual({ ok: true, state: { micMuted: true } });
    expect(await runControlAction({ action: "mic.toggle" }, ctx)).toEqual({ ok: true, state: { micMuted: false } });
  });

  it("is idempotent for the explicit variants", async () => {
    const { ctx, micSet } = context({ muted: true });
    expect(await runControlAction({ action: "mic.mute" }, ctx)).toMatchObject({ ok: true, state: { micMuted: true } });
    expect(micSet).toHaveBeenCalledWith(true);
    expect(await runControlAction({ action: "mic.unmute" }, ctx)).toMatchObject({ ok: true, state: { micMuted: false } });
  });

  it("reports a refused change with the state that holds", async () => {
    const { ctx } = context({ micError: "server down" });
    expect(await runControlAction({ action: "mic.mute" }, ctx)).toEqual({ ok: false, code: "failed", message: "server down", state: { micMuted: false } });
  });

  it("answers ok with the warning when the mic is muted but the server was not told", async () => {
    const { ctx } = context({ micWarning: "orchestrator unreachable" });
    expect(await runControlAction({ action: "mic.mute" }, ctx)).toEqual({ ok: true, message: "orchestrator unreachable", state: { micMuted: true } });
  });
});

describe("runControlAction: web source", () => {
  it("shows and hides without any confirmation", async () => {
    const { ctx, setVisible } = context({ browser: "hidden" });
    expect(await runControlAction({ action: "browser.toggle" }, ctx)).toEqual({ ok: true, state: { browser: "shown" } });
    expect(await runControlAction({ action: "browser.toggle" }, ctx)).toEqual({ ok: true, state: { browser: "hidden" } });
    expect(setVisible.mock.calls).toEqual([[true], [false]]);
  });

  it("does nothing when it is already in the wanted state", async () => {
    const { ctx, setVisible } = context({ browser: "shown" });
    expect(await runControlAction({ action: "browser.show" }, ctx)).toEqual({ ok: true, state: { browser: "shown" } });
    expect(setVisible).not.toHaveBeenCalled();
  });

  it("says so when no web source has been added", async () => {
    const { ctx } = context({ browser: "none" });
    expect(await runControlAction({ action: "browser.show" }, ctx)).toMatchObject({ ok: false, code: "no_browser_source" });
  });
});

describe("runControlAction: screen share", () => {
  it("switches on and off", async () => {
    const { ctx, screenSet } = context();
    expect(await runControlAction({ action: "screen.toggle" }, ctx)).toEqual({ ok: true, state: { screen: "on" } });
    expect(await runControlAction({ action: "screen.stop" }, ctx)).toEqual({ ok: true, state: { screen: "off" } });
    expect(screenSet.mock.calls).toEqual([[true], [false]]);
  });

  it("refuses to start without a chosen screen or window", async () => {
    const { ctx, screenSet } = context({ source: false });
    expect(await runControlAction({ action: "screen.start" }, ctx)).toMatchObject({ ok: false, code: "no_screen_source" });
    expect(screenSet).not.toHaveBeenCalled();
    // Stopping needs no source.
    expect(await runControlAction({ action: "screen.stop" }, ctx)).toMatchObject({ ok: true, state: { screen: "off" } });
  });

  it("reports a share the system refused", async () => {
    const { ctx } = context({ screenError: "denied" });
    expect(await runControlAction({ action: "screen.start" }, ctx)).toMatchObject({ ok: false, message: "denied", state: { screen: "off" } });
  });
});

describe("runControlAction: scope", () => {
  it("never handles scenes (main process) and has no way to remove a source", async () => {
    const { ctx } = context();
    expect((await runControlAction({ action: "scene.next" }, ctx)).ok).toBe(false);
    const actions = await import("../src/core/control/actions");
    expect(actions.CONTROL_ACTIONS.some((a) => /remove|delete|stop-source/.test(a))).toBe(false);
  });
});
