import { describe, expect, it, vi } from "vitest";
import { SourceRegistry } from "./registry";
import { RoutingSource } from "./routing";
import { ScreenSource } from "./screen";
import { DEFAULT_AUDIO } from "./types";

function makeTrack(kind: "video" | "audio") {
  const listeners = new Map<string, Set<() => void>>();
  return {
    id: `${kind}-${Math.random().toString(36).slice(2)}`,
    kind,
    readyState: "live",
    stop: vi.fn(function (this: { readyState: string }) {
      this.readyState = "ended";
    }),
    addEventListener: vi.fn((event: string, cb: () => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(cb);
      listeners.set(event, set);
    }),
    emit(event: string) {
      for (const cb of listeners.get(event) ?? []) cb();
    },
  };
}

function makeStream(tracks: ReturnType<typeof makeTrack>[]) {
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
  } as unknown as MediaStream;
}

describe("ScreenSource", () => {
  it("registers under id 'screen' and routes through RoutingSource", async () => {
    const videoTrack = makeTrack("video");
    const audioTrack = makeTrack("audio");
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(makeStream([videoTrack]))
      .mockResolvedValueOnce(makeStream([audioTrack]));

    const registry = new SourceRegistry();
    const screen = new ScreenSource({ getUserMedia });
    registry.register("screen", () => screen);
    const routing = new RoutingSource({ screen: registry.create("screen") }, "screen");

    const stream = await routing.acquire({
      sourceKind: "screen",
      screen: { sourceId: "screen:0:0", includeMic: true },
      audioDeviceId: "mic-1",
      audio: DEFAULT_AUDIO,
    });

    expect(screen.id).toBe("screen");
    expect(stream).toBeDefined();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia.mock.calls[0][0]).toEqual({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: "screen:0:0",
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: 30,
        },
      },
    });

    // Cached for identical options
    const same = await routing.acquire({
      sourceKind: "screen",
      screen: { sourceId: "screen:0:0", includeMic: true },
      audioDeviceId: "mic-1",
      audio: DEFAULT_AUDIO,
    });
    expect(same).toBe(stream);
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    // Notifies when the screen video track ends
    const onEnded = vi.fn();
    routing.onEnded(onEnded);
    videoTrack.emit("ended");
    expect(onEnded).toHaveBeenCalledTimes(1);

    routing.release();
    expect(videoTrack.stop).toHaveBeenCalledTimes(1);
    expect(audioTrack.stop).toHaveBeenCalledTimes(1);
  });

  it("rejects when no desktop sourceId is provided", async () => {
    const screen = new ScreenSource({ getUserMedia: vi.fn() });
    await expect(
      screen.acquire({ sourceKind: "screen", audio: DEFAULT_AUDIO }),
    ).rejects.toThrow(/source/);
  });

  it("continues with video-only when microphone capture fails", async () => {
    const videoTrack = makeTrack("video");
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(makeStream([videoTrack]))
      .mockRejectedValueOnce(new Error("No mic"));

    const screen = new ScreenSource({ getUserMedia });
    const stream = await screen.acquire({
      sourceKind: "screen",
      screen: { sourceId: "window:42:0" },
      audio: DEFAULT_AUDIO,
    });
    expect(stream.getVideoTracks()).toHaveLength(1);
    screen.release();
  });
});
