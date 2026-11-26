import { describe, expect, it, vi } from "vitest";
import { WhipTransport } from "../src/core/transport/whip";
import { FakePeer } from "./helpers";

const track = (id: string, kind: "video" | "audio") => ({ id, kind }) as unknown as MediaStreamTrack;
const stream = (...tracks: MediaStreamTrack[]) =>
  ({
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
  }) as unknown as MediaStream;

describe("WhipTransport.replaceTracks", () => {
  it("replaces each sender's track by kind on the open connection, and skips the unchanged ones", async () => {
    const cam = track("cam", "video");
    const mic = track("mic", "audio");
    const senders = [
      { track: cam, replaceTrack: vi.fn(async () => undefined) },
      { track: mic, replaceTrack: vi.fn(async () => undefined) },
    ];
    const peer = new FakePeer();
    peer.getSenders = () => senders as never;
    const signaling = { offer: async () => ({ answer: "v=0\r\nanswer\r\n", resource: "/api/v1/live/studio/whip/s1" }), patchIce: async () => undefined, close: vi.fn(async () => undefined) };
    const transport = new WhipTransport({ signaling, createPeer: () => peer as unknown as RTCPeerConnection });
    await transport.connect(stream(cam, mic));

    const canvas = track("canvas", "video");
    await transport.replaceTracks(stream(canvas, mic));

    expect(senders[0]!.replaceTrack).toHaveBeenCalledWith(canvas);
    expect(senders[1]!.replaceTrack).not.toHaveBeenCalled(); // same microphone track
    expect(signaling.close).not.toHaveBeenCalled();
    expect(peer.closed).toBe(false);
  });
});

describe("WhipTransport.replaceTracks overlapping swaps", () => {
  it("ends on the latest stream when a swap away and back overlap (screen sound switched off and on at once)", async () => {
    const cam = track("cam", "video");
    const mic = track("mic", "audio");
    const mix = track("mix", "audio");
    const pending: (() => void)[] = [];
    const sender = {
      track: mix as MediaStreamTrack,
      // Like WebRTC: `sender.track` only changes once replaceTrack settles.
      replaceTrack: vi.fn((t: MediaStreamTrack) => new Promise<void>((res) => pending.push(() => { sender.track = t; res(); }))),
    };
    const video = { track: cam, replaceTrack: vi.fn(async () => undefined) };
    const peer = new FakePeer();
    peer.getSenders = () => [video, sender] as never;
    const signaling = { offer: async () => ({ answer: "v=0\r\nanswer\r\n", resource: "/api/v1/live/studio/whip/s1" }), patchIce: async () => undefined, close: vi.fn(async () => undefined) };
    const transport = new WhipTransport({ signaling, createPeer: () => peer as unknown as RTCPeerConnection });
    await transport.connect(stream(cam, mix));

    const off = transport.replaceTracks(stream(cam, mic)); // mix -> microphone, still in flight
    const on = transport.replaceTracks(stream(cam, mix)); // back to the mix before the first settled
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      pending.shift()?.();
    }
    await Promise.all([off, on]);
    expect(sender.track).toBe(mix);
  });
});
