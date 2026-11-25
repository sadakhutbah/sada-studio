import { describe, expect, it } from "vitest";
import { InputAudioMixer } from "../src/core/audio/mixer";
import { toggleMuteSynced } from "../src/core/audio/mute-sync";

describe("toggleMuteSynced", () => {
  it("keeps the new state when the server accepts it", async () => {
    const m = new InputAudioMixer();
    const pushed: boolean[] = [];
    expect(await toggleMuteSynced(m, async (v) => void pushed.push(v))).toBeNull();
    expect(m.isMuted()).toBe(true);
    expect(pushed).toEqual([true]);
  });

  it("rolls back and returns the error when the server refuses", async () => {
    const m = new InputAudioMixer();
    const seen: boolean[] = [];
    m.subscribe((v) => seen.push(v));
    const err = await toggleMuteSynced(m, async () => {
      throw new Error("503");
    });
    expect(err?.message).toBe("503");
    expect(m.isMuted()).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it("does not roll back over a newer toggle", async () => {
    const m = new InputAudioMixer();
    const err = await toggleMuteSynced(m, async () => {
      m.toggleMute(); // the operator toggles again while the call is in flight
      throw new Error("down");
    });
    expect(err).toBeInstanceOf(Error);
    expect(m.isMuted()).toBe(false);
  });
});
