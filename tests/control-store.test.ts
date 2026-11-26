import { describe, expect, it, vi } from "vitest";
import type { LiveStatus, RegieScene } from "../src/core/api/types";
import { InputAudioMixer } from "../src/core/audio/mixer";
import { MuteSync } from "../src/core/audio/mute-sync";
import { selectView } from "../src/core/regie/state";
import { createRegieStore } from "../src/core/regie/store";
import { loadRegie, type RegieApi } from "../src/core/regie/thunks";
import { runControlAction, type ControlContext } from "../src/renderer/src/control-actions";
import { storeControl } from "../src/renderer/src/store/control";

const SCENES: RegieScene[] = [
  { id: "khutba", kind: "camera", label: "Live" },
  { id: "avant", kind: "slate", label: "Before" },
  { id: "termine", kind: "slate", label: "End" },
];

function setup(command: RegieApi["command"] = async (_c, arg) => ({ scene: arg, override: true, rev: 2 }), push: (m: boolean) => Promise<unknown> = async () => ({})) {
  const api: RegieApi = {
    get: async () => ({ status: { reachable: true, scene: "khutba", rev: 1 }, scenes: SCENES }),
    status: async () => ({ scene: "khutba", rev: 1 }),
    command: vi.fn(command),
    setTransition: async (mode) => ({ ok: true, transition: mode }),
    setOverlay: async () => ({ ok: true, overlays: { qr: { visible: false, url: "", label: "", corner: "tr" }, banner: { visible: false, title: "", subtitle: "" }, logo: { visible: false } } }),
  };
  const mixer = new InputAudioMixer();
  const mute = new MuteSync(mixer, push, { sleep: async () => undefined, delay: () => 0, attempts: 0 });
  const store = createRegieStore({ api, mute });
  const ctx: ControlContext = {
    ...storeControl(store),
    browser: { state: () => "none", setVisible: () => undefined },
    screen: { on: () => false, hasSource: () => false, set: async () => null },
  };
  return { api, mixer, store, ctx };
}

describe("shortcuts and local API through the Régie store", () => {
  it("asks the main process to take the scene while the Régie is not loaded", async () => {
    const { ctx } = setup();
    expect(await runControlAction({ action: "scene.next" }, ctx)).toMatchObject({ ok: false, code: "ui_unavailable" });
  });

  it("takes the next and previous scene, shown in the panel at once", async () => {
    const pending: Array<(s: LiveStatus) => void> = [];
    const { store, ctx, api } = setup((_c, arg) => new Promise((r) => pending.push(() => r({ scene: arg, override: true, rev: 2 }))));
    await store.dispatch(loadRegie());
    const next = runControlAction({ action: "scene.next" }, ctx);
    expect(selectView(store.getState()).scene).toBe("avant"); // same optimistic state as a click
    pending[0]!({});
    expect(await next).toEqual({ ok: true, state: { scene: "avant" } });
    expect(api.command).toHaveBeenCalledWith("scene", "avant", "fade");
  });

  it("refuses an unknown scene and stops at the ends", async () => {
    const { store, ctx } = setup();
    await store.dispatch(loadRegie());
    expect(await runControlAction({ action: "scene.set", scene: "nope" }, ctx)).toMatchObject({ ok: false, code: "unknown_scene" });
    expect(await runControlAction({ action: "scene.previous" }, ctx)).toMatchObject({ ok: false, code: "no_scene" });
    expect(await runControlAction({ action: "scene.set", scene: "termine" }, ctx)).toEqual({ ok: true, state: { scene: "termine" } });
  });

  it("reports a refused scene with the scene still shown", async () => {
    const { store, ctx } = setup(async () => {
      throw new Error("refused");
    });
    await store.dispatch(loadRegie());
    expect(await runControlAction({ action: "scene.set", scene: "avant" }, ctx)).toEqual({ ok: false, code: "failed", message: "refused", state: { scene: "khutba" } });
  });

  it("mutes and restores at once through the store, the server down only adds a warning", async () => {
    const { store, mixer, ctx } = setup(undefined, async () => {
      throw new Error("down");
    });
    const r = await runControlAction({ action: "mic.toggle" }, ctx);
    expect(r).toMatchObject({ ok: true, state: { micMuted: true } });
    expect(r.message).toContain("down");
    expect(mixer.isMuted()).toBe(true);
    expect(store.getState().regie.mic).toMatchObject({ muted: true, synced: false, warning: "down" });
    expect(await runControlAction({ action: "mic.unmute" }, ctx)).toMatchObject({ ok: true, state: { micMuted: false } });
    expect(mixer.isMuted()).toBe(false);
    expect(store.getState().regie.mic.muted).toBe(false);
  });
});
