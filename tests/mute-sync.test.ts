import { describe, expect, it, vi } from "vitest";
import { InputAudioMixer } from "../src/core/audio/mixer";
import { CONTROL_TIMEOUT_MS, MUTE_PUSH_TIMEOUT_MS, MuteSync, type MuteSyncState } from "../src/core/audio/mute-sync";
import { RendererLink } from "../src/core/control/renderer-link";

const down = async () => {
  throw new Error("orchestrator unreachable");
};
const instant = { sleep: async () => undefined, delay: () => 0 };
const flush = () => new Promise((r) => setTimeout(r, 0));

function track(m: InputAudioMixer) {
  const seen: boolean[] = [];
  m.subscribe((v) => seen.push(v));
  return seen;
}

describe("MuteSync: applied locally at once", () => {
  it("mutes locally and tells the server", async () => {
    const m = new InputAudioMixer();
    const pushed: boolean[] = [];
    const sync = new MuteSync(m, async (v) => void pushed.push(v), instant);
    expect(await sync.set(true)).toEqual({ warning: null });
    expect(m.isMuted()).toBe(true);
    expect(pushed).toEqual([true]);
    expect(sync.state()).toEqual({ muted: true, pending: false, synced: true, warning: null });
  });

  it("restores the microphone before the server answers (no wait, no rollback)", async () => {
    const m = new InputAudioMixer();
    m.setMuted(true);
    const seen = track(m);
    let answer!: () => void;
    const sync = new MuteSync(m, () => new Promise<void>((r) => (answer = r)), instant);
    const restoring = sync.set(false);
    expect(m.isMuted()).toBe(false); // open right away
    expect(sync.state().pending).toBe(true);
    answer();
    await restoring;
    expect(seen).toEqual([false]);
    expect(sync.state()).toMatchObject({ muted: false, pending: false, synced: true });
  });

  it("keeps a restore when the server is unreachable: a warning, never a step back", async () => {
    const m = new InputAudioMixer();
    m.setMuted(true);
    const seen = track(m);
    const sync = new MuteSync(m, down, { ...instant, attempts: 0 });
    const out = await sync.set(false);
    expect(out.warning?.message).toBe("orchestrator unreachable");
    expect(m.isMuted()).toBe(false);
    expect(seen).toEqual([false]);
    expect(sync.state()).toMatchObject({ synced: false, warning: "orchestrator unreachable" });
  });

  it("keeps a mute when the server is unreachable, with a warning", async () => {
    const m = new InputAudioMixer();
    const seen = track(m);
    const out = await new MuteSync(m, down, { ...instant, attempts: 0 }).toggle();
    expect(out.warning?.message).toBe("orchestrator unreachable");
    expect(m.isMuted()).toBe(true);
    expect(seen).toEqual([true]);
  });
});

describe("MuteSync: background retries", () => {
  it("retries until the server answers, then clears the warning", async () => {
    const m = new InputAudioMixer();
    const push = vi.fn().mockRejectedValueOnce(new Error("down")).mockRejectedValueOnce(new Error("down")).mockResolvedValue({});
    const sync = new MuteSync(m, push, instant);
    const states: MuteSyncState[] = [];
    sync.subscribe((s) => states.push(s));
    await sync.set(false);
    await flush();
    expect(push).toHaveBeenCalledTimes(3);
    expect(push.mock.calls.every((c) => c[0] === false)).toBe(true);
    expect(sync.state()).toEqual({ muted: false, pending: false, synced: true, warning: null });
    expect(states.some((s) => s.warning === "down")).toBe(true);
  });

  it("the last write wins: a newer request stops the retries of the previous one", async () => {
    const m = new InputAudioMixer();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const push = vi.fn(async (v: boolean) => {
      if (v) throw new Error("down");
      return {};
    });
    const sync = new MuteSync(m, push, { sleep: () => gate, delay: () => 0, attempts: 3 });
    await sync.set(true); // fails, retry waiting on the gate
    await sync.set(false);
    release();
    await flush();
    expect(push.mock.calls.map((c) => c[0])).toEqual([true, false]);
    expect(m.isMuted()).toBe(false);
  });

  it("an answer to an older write does not mark the newer one synced", async () => {
    const m = new InputAudioMixer();
    const answers: Array<() => void> = [];
    const sync = new MuteSync(m, () => new Promise<void>((r) => answers.push(r)), instant);
    const first = sync.set(true);
    void sync.set(false);
    answers[0]!();
    await first;
    expect(sync.state()).toMatchObject({ muted: false, pending: true, synced: false });
    answers[1]!();
    await flush();
    expect(sync.state()).toMatchObject({ muted: false, pending: false, synced: true });
  });
});

describe("MuteSync: changes made on the server (web Régie)", () => {
  it("applies a server mute newer than our last write", async () => {
    const m = new InputAudioMixer();
    const sync = new MuteSync(m, async () => ({ ok: true, rev: 10 }), instant);
    await sync.set(false);
    expect(sync.remote(true, 11)).toBe(true);
    expect(m.isMuted()).toBe(true);
  });

  it("ignores a stale poll (rev not newer than our write)", async () => {
    const m = new InputAudioMixer();
    const sync = new MuteSync(m, async () => ({ ok: true, rev: 10 }), instant);
    await sync.set(true);
    expect(sync.remote(false, 9)).toBe(false);
    expect(sync.remote(false, 10)).toBe(false);
    expect(m.isMuted()).toBe(true);
  });

  it("never applies the server value while our own write is still on its way", async () => {
    const m = new InputAudioMixer();
    const sync = new MuteSync(m, () => new Promise<void>(() => undefined), instant);
    void sync.set(true);
    expect(sync.remote(false, 99)).toBe(false);
    expect(m.isMuted()).toBe(true);
  });

  it("never undoes an unsynchronised local change, but notices when the server caught up", async () => {
    const m = new InputAudioMixer();
    const sync = new MuteSync(m, down, { ...instant, attempts: 0 });
    await sync.set(true);
    expect(sync.remote(false, 5)).toBe(false);
    expect(m.isMuted()).toBe(true);
    expect(sync.remote(true, 6)).toBe(false);
    expect(sync.state()).toMatchObject({ synced: true, warning: null });
    expect(sync.remote(false, 7)).toBe(true); // now a real remote change
    expect(m.isMuted()).toBe(false);
  });

  it("keeps the local value without a rev (old server)", () => {
    const m = new InputAudioMixer();
    const sync = new MuteSync(m, async () => ({}), instant);
    expect(sync.remote(true, undefined)).toBe(false);
    expect(m.isMuted()).toBe(false);
  });
});

describe("timeouts", () => {
  it("lets the window outlast a server attempt, so the real error reaches the caller", () => {
    expect(CONTROL_TIMEOUT_MS).toBeGreaterThan(MUTE_PUSH_TIMEOUT_MS);
    const link = new RendererLink(() => true) as unknown as { timeoutMs: number };
    expect(link.timeoutMs).toBe(CONTROL_TIMEOUT_MS);
  });
});
