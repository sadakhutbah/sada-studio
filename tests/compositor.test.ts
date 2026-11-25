import { describe, expect, it, vi } from "vitest";
import { BroadcastSession } from "../src/core/session/broadcast-session";
import { CompositedSource, type OutputCompositor } from "../src/core/sources/compositor";
import { chooseOutput, nextCanvasSize } from "../src/core/sources/compositor-logic";
import { RoutingSource } from "../src/core/sources/routing";
import { DEFAULT_AUDIO, type MediaSourceStrategy } from "../src/core/sources/types";
import type { Transport } from "../src/core/transport/types";

const track = (id: string, kind: "video" | "audio") => ({ id, kind }) as unknown as MediaStreamTrack;
const stream = (...tracks: MediaStreamTrack[]) =>
  ({
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
  }) as unknown as MediaStream;

const mic = track("mic", "audio");
const RAW = stream(track("cam", "video"), mic);
const CANVAS = stream(track("canvas", "video"), mic);

function fakeInner(raw: MediaStream = RAW) {
  return { id: "inner", acquire: vi.fn(async () => raw), release: vi.fn(), onEnded: () => () => undefined } satisfies MediaSourceStrategy;
}
function fakeCompositor(out: MediaStream = CANVAS) {
  return { compose: vi.fn(() => out), setRunning: vi.fn(), dispose: vi.fn() } satisfies OutputCompositor;
}

describe("chooseOutput", () => {
  it("sends the raw stream unless a web source or the screen is shown", () => {
    expect(chooseOutput({ browserVisible: false, screenActive: false })).toBe("raw");
    expect(chooseOutput({ browserVisible: true, screenActive: false })).toBe("canvas");
    expect(chooseOutput({ browserVisible: false, screenActive: true })).toBe("canvas");
    expect(chooseOutput({ browserVisible: true, screenActive: true })).toBe("canvas");
  });
});

describe("nextCanvasSize", () => {
  it("resizes only when the real resolution changed", () => {
    expect(nextCanvasSize({ width: 1280, height: 720 }, { videoWidth: 1280, videoHeight: 720 })).toBeNull();
    expect(nextCanvasSize({ width: 1280, height: 720 }, { videoWidth: 1920, videoHeight: 1080 })).toEqual({ width: 1920, height: 1080 });
    // A video that has no picture yet must not shrink the canvas to 0x0.
    expect(nextCanvasSize({ width: 1280, height: 720 }, { videoWidth: 0, videoHeight: 0 })).toBeNull();
    expect(nextCanvasSize({ width: 1280, height: 720 }, null)).toBeNull();
  });
});

describe("CompositedSource", () => {
  it("never touches the canvas while nothing is shown: the camera stream goes out as is", async () => {
    const compositor = fakeCompositor();
    const src = new CompositedSource(fakeInner(), compositor, { canvasAvailable: true });
    expect(await src.acquire({ audio: DEFAULT_AUDIO })).toBe(RAW);
    src.setDemand({ browserVisible: false, screenActive: false });
    expect(compositor.compose).not.toHaveBeenCalled();
    expect(src.outputMode).toBe("raw");
  });

  it("switches to the canvas when a web source is shown and back, announcing each stream, without releasing the source", async () => {
    const inner = fakeInner();
    const compositor = fakeCompositor();
    const src = new CompositedSource(inner, compositor, { canvasAvailable: true });
    const seen: MediaStream[] = [];
    src.onStreamChange((s) => seen.push(s));
    await src.acquire({ audio: DEFAULT_AUDIO });

    src.setDemand({ browserVisible: true, screenActive: false });
    expect(src.outputMode).toBe("canvas");
    expect(seen).toEqual([CANVAS]);
    expect(compositor.compose).toHaveBeenCalledWith([RAW]);

    src.setDemand({ browserVisible: true, screenActive: false }); // unchanged: no event
    expect(seen).toHaveLength(1);

    src.setDemand({ browserVisible: false, screenActive: false });
    expect(seen).toEqual([CANVAS, RAW]);
    expect(compositor.setRunning).toHaveBeenLastCalledWith(false);
    expect(inner.release).not.toHaveBeenCalled();
    expect(compositor.dispose).not.toHaveBeenCalled();
  });

  it("hands out the canvas straight away when it is already wanted at acquisition", async () => {
    const src = new CompositedSource(fakeInner(), fakeCompositor(), { canvasAvailable: true });
    src.setDemand({ browserVisible: false, screenActive: true });
    expect(await src.acquire({ audio: DEFAULT_AUDIO })).toBe(CANVAS);
  });

  it("always sends the raw stream where there is no DOM", async () => {
    const compositor = fakeCompositor();
    const src = new CompositedSource(fakeInner(), compositor, { canvasAvailable: false });
    src.setDemand({ browserVisible: true, screenActive: true });
    expect(await src.acquire({ audio: DEFAULT_AUDIO })).toBe(RAW);
    expect(compositor.compose).not.toHaveBeenCalled();
  });

  it("releases the source and the compositor together", async () => {
    const inner = fakeInner();
    const compositor = fakeCompositor();
    const src = new CompositedSource(inner, compositor, { canvasAvailable: true });
    await src.acquire({ audio: DEFAULT_AUDIO });
    src.release();
    expect(inner.release).toHaveBeenCalledTimes(1);
    expect(compositor.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("live switch without cutting the connection", () => {
  class ReplacingTransport implements Transport {
    readonly kind = "fake";
    closed = 0;
    connected: MediaStream[] = [];
    replaced: MediaStream[] = [];
    async connect(s: MediaStream) {
      this.connected.push(s);
    }
    onLost() {}
    async getStats() {
      return { bytesSent: 0 };
    }
    async replaceTracks(s: MediaStream) {
      this.replaced.push(s);
    }
    async close() {
      this.closed++;
    }
  }

  it("swaps the senders' tracks on a raw <-> canvas change and on a source change, keeping one transport", async () => {
    const screenStream = stream(track("screen", "video"), track("mic2", "audio"));
    const camera = fakeInner(RAW);
    const screen = fakeInner(screenStream);
    const routing = new RoutingSource({ camera, screen }, "camera", new Set(["screen"]));
    const compositor = fakeCompositor();
    const composited = new CompositedSource(routing, compositor, { canvasAvailable: true });
    const transports: ReplacingTransport[] = [];
    const session = new BroadcastSession({
      source: composited,
      transportFactory: () => {
        const t = new ReplacingTransport();
        transports.push(t);
        return t;
      },
    });

    await session.start({ audio: DEFAULT_AUDIO });
    expect(session.snapshot.state.status).toBe("live");
    expect(transports[0]!.connected).toEqual([RAW]);

    // Web source shown: the canvas replaces the camera track.
    composited.setDemand({ browserVisible: true, screenActive: false });
    await Promise.resolve();
    expect(transports[0]!.replaced).toEqual([CANVAS]);

    // Screen share on: acquired again (different source), then composited.
    await session.swapSource({ sourceKind: "screen", screen: { sourceId: "screen:0:0" }, audio: DEFAULT_AUDIO });
    composited.setDemand({ browserVisible: true, screenActive: true });
    expect(screen.acquire).toHaveBeenCalledTimes(1);
    expect(transports[0]!.replaced.at(-1)).toBe(CANVAS);

    // Everything off: the raw stream of the source goes out again.
    await session.swapSource({ audio: DEFAULT_AUDIO });
    composited.setDemand({ browserVisible: false, screenActive: false });
    await Promise.resolve();
    expect(transports[0]!.replaced.at(-1)).toBe(RAW);

    expect(transports).toHaveLength(1);
    expect(transports[0]!.closed).toBe(0);
    expect(session.snapshot.state.status).toBe("live");
    await session.stop();
  });

  it("does nothing when swapping while not live", async () => {
    const inner = fakeInner();
    const session = new BroadcastSession({ source: inner, transportFactory: () => new ReplacingTransport() });
    await session.swapSource({ audio: DEFAULT_AUDIO });
    expect(inner.acquire).not.toHaveBeenCalled();
  });
});

describe("RoutingSource recoverable kinds", () => {
  it("reports the loss of a shared screen to the UI, not as a failure of the live", async () => {
    let endScreen = () => {};
    const screen: MediaSourceStrategy = {
      id: "screen",
      acquire: async () => RAW,
      release: () => undefined,
      onEnded: (cb) => {
        endScreen = cb;
        return () => undefined;
      },
    };
    const routing = new RoutingSource({ camera: fakeInner(), screen }, "camera", new Set(["screen"]));
    const hard = vi.fn();
    const soft = vi.fn();
    routing.onEnded(hard);
    routing.onRecoverableEnded(soft);
    await routing.acquire({ sourceKind: "screen", audio: DEFAULT_AUDIO });
    endScreen();
    expect(soft).toHaveBeenCalledTimes(1);
    expect(hard).not.toHaveBeenCalled();
  });
});
