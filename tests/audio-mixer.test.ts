import { afterEach, describe, expect, it, vi } from "vitest";
import { InputAudioMixer } from "../src/core/audio/mixer";

// Minimal fakes of the MediaStream objects (the tests run in node).
class FakeTrack {
  enabled = true;
  constructor(public kind: "audio" | "video") {}
}
class FakeStream {
  constructor(private tracks: FakeTrack[] = []) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
}

const streamOf = (...tracks: FakeTrack[]) => new FakeStream(tracks) as unknown as MediaStream;

describe("InputAudioMixer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes the single input through and leaves tracks enabled while unmuted", () => {
    const mix = new InputAudioMixer();
    const mic = new FakeTrack("audio");
    const input = streamOf(new FakeTrack("video"), mic);
    expect(mix.mix([input])).toBe(input);
    expect(mix.isMuted()).toBe(false);
    expect(mic.enabled).toBe(true);
  });

  it("mutes and unmutes the registered incoming audio tracks live", () => {
    const mix = new InputAudioMixer();
    const mic = new FakeTrack("audio");
    mix.mix([streamOf(new FakeTrack("video"), mic)]);

    expect(mix.setMuted(true)).toBe(true);
    expect(mix.isMuted()).toBe(true);
    expect(mic.enabled).toBe(false);

    expect(mix.toggleMute()).toBe(false);
    expect(mic.enabled).toBe(true);
  });

  it("applies the mute to tracks registered after the mute", () => {
    const mix = new InputAudioMixer();
    mix.setMuted(true);
    const mic = new FakeTrack("audio");
    mix.mix([streamOf(mic)]);
    expect(mic.enabled).toBe(false);
  });

  it("notifies the subscribers and stops after unsubscribe", () => {
    const mix = new InputAudioMixer();
    const seen: boolean[] = [];
    const off = mix.subscribe((m) => seen.push(m));
    mix.setMuted(true);
    mix.setMuted(false);
    off();
    mix.setMuted(true);
    expect(seen).toEqual([true, false]);
  });

  it("combines several inputs into one stream of the primary video plus every audio track", () => {
    vi.stubGlobal("MediaStream", FakeStream);
    const mix = new InputAudioMixer();
    const cam = new FakeTrack("video");
    const micA = new FakeTrack("audio");
    const micB = new FakeTrack("audio");
    const out = mix.mix([streamOf(cam, micA), streamOf(new FakeTrack("video"), micB)]);
    expect(out.getVideoTracks()).toEqual([cam]);
    expect(out.getAudioTracks()).toEqual([micA, micB]);
  });

  it("rejects an empty input list and clears everything on dispose", () => {
    const mix = new InputAudioMixer();
    expect(() => mix.mix([])).toThrow(/No input MediaStream/);
    const cb = vi.fn();
    mix.subscribe(cb);
    mix.mix([streamOf(new FakeTrack("audio"))]);
    mix.dispose();
    mix.setMuted(true);
    expect(cb).not.toHaveBeenCalled();
  });
});
