import { describe, expect, it, vi } from "vitest";
import { InputAudioMixer } from "../src/core/audio/mixer";
import { CONTROL_TIMEOUT_MS, MUTE_PUSH_TIMEOUT_MS, MuteSync } from "../src/core/audio/mute-sync";
import { RendererLink } from "../src/core/control/renderer-link";

const down = async () => {
  throw new Error("orchestrator unreachable");
};
const instant = { sleep: async () => undefined, delay: () => 0 };

describe("MuteSync: muting", () => {
  it("mutes locally and tells the server", async () => {
    const m = new InputAudioMixer();
    const pushed: boolean[] = [];
    const sync = new MuteSync(m, async (v) => void pushed.push(v), instant);
    expect(await sync.set(true)).toEqual({ error: null, warning: null });
    expect(m.isMuted()).toBe(true);
    expect(pushed).toEqual([true]);
  });

  it("keeps the microphone muted when the server is unreachable, with a warning and no error", async () => {
    const m = new InputAudioMixer();
    const seen: boolean[] = [];
    m.subscribe((v) => seen.push(v));
    const out = await new MuteSync(m, down, { ...instant, attempts: 0 }).toggle();
    expect(out.error).toBeNull();
    expect(out.warning?.message).toBe("orchestrator unreachable");
    expect(m.isMuted()).toBe(true);
    expect(seen).toEqual([true]); // never flips back
  });

  it("retries in the background until the server answers", async () => {
    const m = new InputAudioMixer();
    const push = vi.fn().mockRejectedValueOnce(new Error("down")).mockRejectedValueOnce(new Error("down")).mockResolvedValue({});
    const synced = new Promise<void>((resolve) => void new MuteSync(m, push, { ...instant, onSynced: resolve }).set(true));
    await synced;
    expect(push).toHaveBeenCalledTimes(3);
    expect(push).toHaveBeenLastCalledWith(true);
    expect(m.isMuted()).toBe(true);
  });

  it("stops retrying once a newer request replaced the mute", async () => {
    const m = new InputAudioMixer();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const push = vi.fn(async (v: boolean) => {
      calls++;
      if (v && calls === 1) throw new Error("down");
      return {};
    });
    const sync = new MuteSync(m, push, { sleep: () => gate, delay: () => 0, attempts: 3 });
    await sync.set(true);
    await sync.set(false); // restore confirmed
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(push.mock.calls.map((c) => c[0])).toEqual([true, false]); // no retry of the stale mute
    expect(m.isMuted()).toBe(false);
  });
});

describe("MuteSync: restoring", () => {
  it("opens the microphone only after the server confirmed", async () => {
    const m = new InputAudioMixer();
    m.setMuted(true);
    let during: boolean | null = null;
    const sync = new MuteSync(m, async () => void (during = m.isMuted()), instant);
    expect(await sync.set(false)).toEqual({ error: null, warning: null });
    expect(during).toBe(true); // still muted while the server was being asked
    expect(m.isMuted()).toBe(false);
  });

  it("leaves the microphone muted and reports the error when the server does not confirm", async () => {
    const m = new InputAudioMixer();
    m.setMuted(true);
    const out = await new MuteSync(m, down, instant).set(false);
    expect(out.error?.message).toBe("orchestrator unreachable");
    expect(m.isMuted()).toBe(true);
  });

  it("does not open the microphone behind a mute asked while the restore was in flight", async () => {
    const m = new InputAudioMixer();
    m.setMuted(true);
    let finish!: () => void;
    const sync = new MuteSync(m, (v) => (v ? Promise.resolve() : new Promise<void>((r) => (finish = r))), instant);
    const restoring = sync.set(false);
    await sync.set(true);
    finish();
    await restoring;
    expect(m.isMuted()).toBe(true);
  });
});

describe("timeouts", () => {
  it("lets the window outlast a server attempt, so the real error reaches the caller", () => {
    expect(CONTROL_TIMEOUT_MS).toBeGreaterThan(MUTE_PUSH_TIMEOUT_MS);
    const link = new RendererLink(() => true) as unknown as { timeoutMs: number };
    expect(link.timeoutMs).toBe(CONTROL_TIMEOUT_MS);
  });
});
