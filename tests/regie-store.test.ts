import { describe, expect, it, vi } from "vitest";
import type { LiveStatus, RegieData, RegieScene } from "../src/core/api/types";
import { InputAudioMixer } from "../src/core/audio/mixer";
import { MuteSync } from "../src/core/audio/mute-sync";
import {
  DEFAULT_OVERLAYS,
  initialRegieState,
  regieActions as A,
  regieReducer,
  selectPending,
  selectProgramView,
  selectStale,
  selectView,
  type RegieRootState,
} from "../src/core/regie/state";
import { createRegieStore, watchProgramView } from "../src/core/regie/store";
import { loadRegie, pollStatus, setAuto, takeScene, toggleOverlay, type RegieApi } from "../src/core/regie/thunks";

const SCENES: RegieScene[] = [
  { id: "khutba", kind: "camera", label: "Live" },
  { id: "avant", kind: "slate", label: "Before", scene_kind: "full" },
  { id: "annonce", kind: "custom", label: "Notice", scene_kind: "banner" },
];

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

function fakeApi(over: Partial<RegieApi> = {}): RegieApi {
  return {
    get: async (): Promise<RegieData> => ({ status: { reachable: true, scene: "khutba", override: false, rev: 1 }, scenes: SCENES, overlays: DEFAULT_OVERLAYS }),
    status: async () => ({ reachable: true, scene: "khutba", rev: 1 }),
    command: async () => ({}),
    setTransition: async (mode) => ({ ok: true, transition: mode }),
    setOverlay: async (_kind, _p) => ({ ok: true, overlays: DEFAULT_OVERLAYS }),
    ...over,
  };
}

async function loadedStore(api: RegieApi, mute: MuteSync | null = null) {
  const store = createRegieStore({ api, mute });
  await store.dispatch(loadRegie());
  return store;
}

/** Records every scene shown, to catch a button that jumps back and forth. */
function sceneTrail(store: { getState: () => RegieRootState; subscribe: (cb: () => void) => () => void }) {
  const trail: string[] = [selectView(store.getState()).scene];
  store.subscribe(() => {
    const s = selectView(store.getState()).scene;
    if (trail[trail.length - 1] !== s) trail.push(s);
  });
  return trail;
}

const root = (regie = initialRegieState()): RegieRootState => ({ regie });
const reduce = (state: RegieRootState, action: Parameters<typeof regieReducer>[1]): RegieRootState => ({ regie: regieReducer(state.regie, action) });

describe("regie reducer: server state", () => {
  it("ignores a state whose rev is older than the last one known", () => {
    let s = reduce(root(), A.polled({ epoch: 0, status: { scene: "avant", rev: 5 }, fresh: true }));
    s = reduce(s, A.polled({ epoch: 0, status: { scene: "khutba", rev: 4 }, fresh: true }));
    expect(s.regie.server.scene).toBe("avant");
    expect(s.regie.rev).toBe(5);
    s = reduce(s, A.polled({ epoch: 0, status: { scene: "priere", rev: 6 }, fresh: false }));
    expect(s.regie.server.scene).toBe("priere"); // the rev decides, not the fence
  });

  it("falls back on the write fence without rev", () => {
    let s = reduce(root(), A.polled({ epoch: 0, status: { scene: "avant" }, fresh: false }));
    expect(s.regie.server.scene).toBe("");
    s = reduce(s, A.polled({ epoch: 0, status: { scene: "avant" }, fresh: true }));
    expect(s.regie.server.scene).toBe("avant");
  });

  it("drops answers meant for a previous session of the panel", () => {
    let s = reduce(root(), A.reset());
    s = reduce(s, A.polled({ epoch: 0, status: { scene: "avant", rev: 3 }, fresh: true }));
    expect(s.regie.server.scene).toBe("");
  });

  it("flags the data as stale after repeated poll failures", () => {
    let s = reduce(root(), A.pollFailuresChanged(1));
    expect(selectStale(s)).toBe(false);
    s = reduce(s, A.pollFailuresChanged(2));
    expect(selectStale(s)).toBe(true);
  });
});

describe("regie reducer: drafts", () => {
  const data = (title: string): RegieData => ({
    status: { scene: "khutba", rev: 1 },
    overlays: { ...DEFAULT_OVERLAYS, banner: { visible: true, title, subtitle: "" }, qr: { visible: false, url: "https://a", label: "", corner: "bl" } },
  });

  it("fills the fields on the first load only, never from a poll or a later load", () => {
    let s = reduce(root(), A.loaded({ epoch: 0, data: data("Server title"), fresh: true }));
    expect(s.regie.drafts.banner.title).toBe("Server title");
    expect(s.regie.drafts.qr).toEqual({ url: "https://a", label: "", corner: "bl" });
    s = reduce(s, A.draftChanged({ banner: { title: "Being typ" } }));
    s = reduce(s, A.polled({ epoch: 0, status: { rev: 2, overlays: data("Other").overlays }, fresh: true }));
    s = reduce(s, A.loaded({ epoch: 0, data: data("Again"), fresh: true }));
    expect(s.regie.drafts.banner.title).toBe("Being typ");
    expect(s.regie.server.overlays.banner.title).toBe("Other"); // rev 1 < 2: the second load's state is ignored
  });

  it("starts over on reset (the panel is mounted again)", () => {
    let s = reduce(root(), A.loaded({ epoch: 0, data: data("First"), fresh: true }));
    s = reduce(s, A.draftChanged({ banner: { title: "typed" } }));
    s = reduce(s, A.reset());
    s = reduce(s, A.loaded({ epoch: 1, data: data("Second"), fresh: true }));
    expect(s.regie.drafts.banner.title).toBe("Second");
  });
});

describe("regie thunks: optimistic commands", () => {
  it("shows the scene at once and keeps it while the server still reports the old one (fade)", async () => {
    const cmd = deferred<LiveStatus>();
    let polled: LiveStatus = { reachable: true, scene: "khutba", rev: 1 };
    const store = await loadedStore(fakeApi({ command: () => cmd.promise, status: async () => polled }));
    const trail = sceneTrail(store);
    const taking = store.dispatch(takeScene("avant"));
    expect(selectView(store.getState()).scene).toBe("avant");
    expect(selectPending(store.getState(), "scene")).toBe(true);
    // A poll that started before the command finished reports the previous scene: ignored by the rev, still optimistic.
    await store.dispatch(pollStatus());
    expect(selectView(store.getState()).scene).toBe("avant");
    // The answer itself, mid-fade, still says "khutba".
    cmd.resolve({ scene: "khutba", override: true, rev: 2 });
    expect(await taking).toEqual({ ok: true, error: null });
    expect(selectPending(store.getState(), "scene")).toBe(false);
    expect(selectView(store.getState()).scene).toBe("avant");
    polled = { reachable: true, scene: "avant", override: true, rev: 2 };
    await store.dispatch(pollStatus());
    expect(store.getState().regie.optimistic.scene).toBeUndefined(); // confirmed
    expect(trail).toEqual(["khutba", "avant"]); // never jumped back
  });

  it("does not read the status again when the answer carries the state", async () => {
    const status = vi.fn(async () => ({ scene: "khutba", rev: 1 }));
    const store = await loadedStore(fakeApi({ status, command: async () => ({ scene: "avant", override: true, rev: 2 }) }));
    await store.dispatch(takeScene("avant"));
    expect(status).not.toHaveBeenCalled();
    expect(store.getState().regie.server.scene).toBe("avant");
    expect(store.getState().regie.optimistic.scene).toBeUndefined();
  });

  it("reads the status once, through the filter, when the answer carries nothing (old server)", async () => {
    const status = vi.fn(async (): Promise<LiveStatus> => ({ reachable: true, scene: "avant", override: true }));
    const store = await loadedStore(fakeApi({ get: async () => ({ status: { reachable: true, scene: "khutba" }, scenes: SCENES }), status, command: async () => ({ ok: true }) }));
    await store.dispatch(takeScene("avant"));
    expect(status).toHaveBeenCalledTimes(1);
    expect(store.getState().regie.server.scene).toBe("avant");
  });

  it("a failed command goes back to the server state in one step, with an error", async () => {
    const cmd = deferred<LiveStatus>();
    const store = await loadedStore(fakeApi({ command: () => cmd.promise }));
    const trail = sceneTrail(store);
    const taking = store.dispatch(takeScene("avant"));
    cmd.reject(new Error("refused"));
    expect(await taking).toEqual({ ok: false, error: "refused" });
    expect(selectView(store.getState()).scene).toBe("khutba");
    expect(store.getState().regie.error).toBe("refused");
    expect(trail).toEqual(["khutba", "avant", "khutba"]);
  });

  it("gives up an optimistic value the server keeps contradicting", async () => {
    const store = await loadedStore(fakeApi({ command: async () => ({ scene: "khutba", rev: 2 }), status: async () => ({ scene: "khutba", rev: 2 }) }));
    await store.dispatch(takeScene("avant"));
    await store.dispatch(pollStatus());
    expect(selectView(store.getState()).scene).toBe("avant");
    await store.dispatch(pollStatus());
    expect(selectView(store.getState()).scene).toBe("khutba");
  });

  it("only the control being changed is pending, the others stay usable", async () => {
    const ov = deferred<never>();
    const store = await loadedStore(fakeApi({ setOverlay: () => ov.promise, command: async () => ({ scene: "avant", override: true, rev: 2 }) }));
    const toggling = store.dispatch(toggleOverlay("qr"));
    expect(selectPending(store.getState(), "overlay.qr")).toBe(true);
    expect(selectView(store.getState()).overlays.qr.visible).toBe(true); // the eye changes at once
    expect(selectPending(store.getState(), "scene")).toBe(false);
    await store.dispatch(takeScene("avant"));
    expect(selectView(store.getState()).scene).toBe("avant");
    expect(selectView(store.getState()).overlays.qr.visible).toBe(true); // the scene answer does not undo the eye
    ov.reject(new Error("x"));
    await toggling;
    expect(selectView(store.getState()).overlays.qr.visible).toBe(false);
  });

  it("goes back to the schedule", async () => {
    const command = vi.fn(async (): Promise<LiveStatus> => ({ scene: "avant", override: false, rev: 3 }));
    const store = await loadedStore(fakeApi({ command }));
    await store.dispatch(setAuto());
    expect(command).toHaveBeenCalledWith("auto");
    expect(selectView(store.getState())).toMatchObject({ scene: "avant", override: false });
  });

  it("sends the funeral prayer through its own command, with the transition shown", async () => {
    const command = vi.fn(async (): Promise<LiveStatus> => ({}));
    const store = await loadedStore(fakeApi({ command }));
    await store.dispatch(takeScene("janaza"));
    expect(command).toHaveBeenCalledWith("janaza", undefined, "fade");
  });
});

describe("selectProgramView", () => {
  it("gives the compositor the optimistic scene, its kind, overlays, mute and compositing", async () => {
    const m = new InputAudioMixer();
    const mute = new MuteSync(m, async () => ({}));
    const store = await loadedStore(
      fakeApi({
        get: async () => ({ status: { reachable: true, scene: "khutba", rev: 1, compositing: "studio" }, scenes: SCENES }),
        command: () => new Promise<LiveStatus>(() => undefined),
      }),
      mute,
    );
    const seen: string[] = [];
    const stop = watchProgramView(store, (v) => seen.push(`${v.scene}:${v.sceneKind}:${v.micMuted}`));
    void store.dispatch(takeScene("annonce"));
    await mute.set(true);
    const v = selectProgramView(store.getState());
    expect(v).toMatchObject({ scene: "annonce", sceneKind: "banner", micMuted: true, compositing: "studio" });
    expect(v.scenes.map((s) => s.scene_kind)).toEqual(["camera", "full", "banner"]);
    expect(v.overlays).toEqual(DEFAULT_OVERLAYS);
    expect(seen).toEqual(["khutba:camera:false", "annonce:banner:false", "annonce:banner:true"]);
    // Unrelated changes keep the same object (no redraw).
    const before = selectProgramView(store.getState());
    store.dispatch(A.draftChanged({ banner: { title: "x" } }));
    expect(selectProgramView(store.getState())).toBe(before);
    stop();
  });

  it("falls back to the default scenes and the camera kind", () => {
    const fallback: RegieScene[] = [{ id: "khutba", kind: "camera", label: "L" }, { id: "avant", kind: "slate", label: "B" }];
    const v = selectProgramView(root(initialRegieState(fallback)));
    expect(v.scenes.map((s) => s.scene_kind)).toEqual(["camera", "full"]);
    expect(v).toMatchObject({ scene: "", sceneKind: "camera", compositing: "server", micMuted: false });
  });
});

describe("regie store and the microphone", () => {
  it("mirrors the local microphone and applies a newer mute from the web Régie", async () => {
    const m = new InputAudioMixer();
    const mute = new MuteSync(m, async () => ({ ok: true, rev: 4 }));
    let polled: LiveStatus = { scene: "khutba", mic_muted: false, rev: 4 };
    const store = await loadedStore(fakeApi({ status: async () => polled }), mute);
    await mute.set(false);
    await store.dispatch(pollStatus());
    expect(store.getState().regie.mic.muted).toBe(false);
    polled = { scene: "khutba", mic_muted: true, rev: 5 };
    await store.dispatch(pollStatus());
    expect(m.isMuted()).toBe(true);
    expect(store.getState().regie.mic.muted).toBe(true);
    expect(selectProgramView(store.getState()).micMuted).toBe(true);
  });
});
