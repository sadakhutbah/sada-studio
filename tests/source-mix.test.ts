import { describe, expect, it, vi } from "vitest";
import {
  AudioSourceMix,
  clampVolume,
  DEFAULT_MIX,
  MAX_VOLUME,
  normalizeMixSettings,
  planMix,
  type MixAudioContext,
  type MixAudioNode,
  type MixGainNode,
} from "../src/core/audio/source-mix";
import { CompositedSource, type OutputCompositor } from "../src/core/sources/compositor";
import { RoutingSource } from "../src/core/sources/routing";
import { screenAudioSupport } from "../src/core/sources/screen-audio";
import { ScreenSource } from "../src/core/sources/screen";
import { DEFAULT_AUDIO, type MediaSourceStrategy } from "../src/core/sources/types";

const track = (id: string, kind: "video" | "audio") => ({ id, kind, readyState: "live", stop: vi.fn(), addEventListener: vi.fn() }) as unknown as MediaStreamTrack;
const stream = (...tracks: MediaStreamTrack[]) =>
  ({
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
  }) as unknown as MediaStream;

/** Records the Web Audio graph: which stream feeds which gain, and the gain values. */
function fakeContext() {
  const mixTrack = track("mix", "audio");
  const sources: { stream: MediaStream; gain: MixGainNode | null; disconnected: boolean }[] = [];
  const gains: MixGainNode[] = [];
  let destinationConnections = 0;
  const destination = { stream: stream(mixTrack), connect: vi.fn(), disconnect: vi.fn() };
  const ctx: MixAudioContext = {
    createMediaStreamSource(s) {
      const entry = { stream: s, gain: null as MixGainNode | null, disconnected: false };
      sources.push(entry);
      const node: MixAudioNode = {
        connect: (to) => void (entry.gain = to as MixGainNode),
        disconnect: () => void (entry.disconnected = true),
      };
      return node;
    },
    createGain() {
      const g: MixGainNode = {
        gain: { value: 1 },
        connect: (to) => {
          if (to === (destination as unknown)) destinationConnections++;
        },
        disconnect: vi.fn(),
      };
      gains.push(g);
      return g;
    },
    createMediaStreamDestination: () => destination as unknown as MixAudioNode & { stream: MediaStream },
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  return { ctx, sources, gains, mixTrack, destination, connections: () => destinationConnections };
}

const MIC = stream(track("cam", "video"), track("mic", "audio"));
const SCREEN_SOUND = stream(track("loopback", "audio"));
const PAGE_SOUND = stream(track("page", "audio"));

describe("planMix", () => {
  it("is inactive while only the microphone is there", () => {
    expect(planMix({ screen: false, browser: false }, DEFAULT_MIX)).toEqual({ gains: { screen: 0, browser: 0 }, active: false });
  });

  it("counts a source only when it has sound, is on and is above zero", () => {
    expect(planMix({ screen: true, browser: false }, DEFAULT_MIX).gains).toEqual({ screen: 1, browser: 0 });
    const off = { ...DEFAULT_MIX, screen: { enabled: false, volume: 1 } };
    expect(planMix({ screen: true, browser: false }, off).active).toBe(false);
    const silent = { ...DEFAULT_MIX, browser: { enabled: true, volume: 0 } };
    expect(planMix({ screen: false, browser: true }, silent).active).toBe(false);
  });

  it("applies each source's volume on its own", () => {
    const s = { screen: { enabled: true, volume: 0.5 }, browser: { enabled: true, volume: 1.5 } };
    expect(planMix({ screen: true, browser: true }, s)).toEqual({ gains: { screen: 0.5, browser: 1.5 }, active: true });
  });
});

describe("mix settings", () => {
  it("bounds the volume", () => {
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(99)).toBe(MAX_VOLUME);
    expect(clampVolume("loud")).toBe(1);
    expect(clampVolume(Number.NaN)).toBe(1);
  });

  it("falls back to the defaults for anything unusable", () => {
    expect(normalizeMixSettings(null)).toEqual(DEFAULT_MIX);
    expect(normalizeMixSettings({ screen: { enabled: "yes", volume: 0.3 }, browser: 5 })).toEqual({ screen: { enabled: true, volume: 0.3 }, browser: { enabled: true, volume: 1 } });
  });
});

describe("AudioSourceMix graph", () => {
  it("does not create any audio context while only the microphone is there", () => {
    const f = fakeContext();
    const create = vi.fn(() => f.ctx);
    const mix = new AudioSourceMix(create);
    mix.setMic(MIC);
    expect(mix.active).toBe(false);
    expect(mix.track).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("mixes the microphone with the screen sound once it arrives, with a stable output track, and says so", () => {
    const f = fakeContext();
    const mix = new AudioSourceMix(() => f.ctx);
    const changes = vi.fn();
    mix.onActiveChange(changes);
    mix.setMic(MIC);
    mix.setInput("screen", SCREEN_SOUND);
    expect(mix.active).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(f.sources.map((s) => s.stream)).toEqual([MIC, SCREEN_SOUND]);
    expect(f.connections()).toBe(2); // both gains feed the destination
    expect(f.gains.map((g) => g.gain.value)).toEqual([1, 1]);
    expect(mix.track).toBe(f.mixTrack);
    // Another change of volume does not announce anything: still active, same track.
    mix.configure({ ...DEFAULT_MIX, screen: { enabled: true, volume: 0.4 } });
    expect(f.gains[1]!.gain.value).toBe(0.4);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(mix.track).toBe(f.mixTrack);
  });

  it("mixes the page sound too, each at its own volume", () => {
    const f = fakeContext();
    const mix = new AudioSourceMix(() => f.ctx);
    mix.configure({ screen: { enabled: true, volume: 0.5 }, browser: { enabled: true, volume: 1.5 } });
    mix.setMic(MIC);
    mix.setInput("screen", SCREEN_SOUND);
    mix.setInput("browser", PAGE_SOUND);
    expect(f.gains.map((g) => g.gain.value)).toEqual([1, 0.5, 1.5]);
  });

  it("goes inactive when the sound is switched off, silences the source, and comes back", () => {
    const f = fakeContext();
    const mix = new AudioSourceMix(() => f.ctx);
    const changes = vi.fn();
    mix.setMic(MIC);
    mix.setInput("browser", PAGE_SOUND);
    mix.onActiveChange(changes);
    mix.configure({ ...DEFAULT_MIX, browser: { enabled: false, volume: 1 } });
    expect(mix.active).toBe(false);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(f.gains[1]!.gain.value).toBe(0);
    mix.configure(DEFAULT_MIX);
    expect(mix.active).toBe(true);
    expect(changes).toHaveBeenCalledTimes(2);
    expect(mix.track).toBe(f.mixTrack);
  });

  it("rewires a source whose stream changed and drops one that went away", () => {
    const f = fakeContext();
    const mix = new AudioSourceMix(() => f.ctx);
    mix.setMic(MIC);
    mix.setInput("screen", SCREEN_SOUND);
    const newMic = stream(track("mic2", "audio"));
    mix.setMic(newMic);
    expect(f.sources[0]!.disconnected).toBe(true);
    expect(f.sources.at(-1)!.stream).toBe(newMic);
    mix.setInput("screen", null);
    expect(mix.active).toBe(false);
    expect(f.sources.find((s) => s.stream === SCREEN_SOUND)!.disconnected).toBe(true);
  });

  it("ignores a stream without audio", () => {
    const f = fakeContext();
    const mix = new AudioSourceMix(() => f.ctx);
    mix.setInput("screen", stream(track("v", "video")));
    expect(mix.active).toBe(false);
  });

  it("stays inactive where Web Audio is missing", () => {
    const mix = new AudioSourceMix(() => null);
    mix.setMic(MIC);
    mix.setInput("screen", SCREEN_SOUND);
    expect(mix.track).toBeNull();
    expect(mix.active).toBe(true); // wanted, but it cannot be built: CompositedSource then keeps the microphone
  });
});

describe("CompositedSource with the audio mix", () => {
  class FakeMediaStream {
    private readonly tracks: MediaStreamTrack[];
    constructor(tracks: MediaStreamTrack[] = []) {
      this.tracks = tracks;
    }
    getTracks = () => this.tracks;
    getVideoTracks = () => this.tracks.filter((t) => t.kind === "video");
    getAudioTracks = () => this.tracks.filter((t) => t.kind === "audio");
  }

  function setup() {
    vi.stubGlobal("MediaStream", FakeMediaStream);
    const camera = track("cam", "video");
    const raw = stream(camera, track("mic", "audio"));
    const inner: MediaSourceStrategy = { id: "inner", acquire: vi.fn(async () => raw), release: vi.fn(), onEnded: () => () => undefined, systemAudio: vi.fn(() => null) };
    const compositor: OutputCompositor = { compose: vi.fn(() => stream(track("canvas", "video"))), setRunning: vi.fn(), dispose: vi.fn() };
    const f = fakeContext();
    const mix = new AudioSourceMix(() => f.ctx);
    const src = new CompositedSource(inner, compositor, { canvasAvailable: true, audioMix: mix });
    const seen: MediaStream[] = [];
    src.onStreamChange((s) => seen.push(s));
    return { inner, raw, camera, src, mix, f, seen };
  }

  it("keeps the raw stream while nothing but the microphone is audible", async () => {
    const { src, raw } = setup();
    expect(await src.acquire({ audio: DEFAULT_AUDIO })).toBe(raw);
    vi.unstubAllGlobals();
  });

  it("swaps the audio to the mix, without reacquiring, when the page sound comes in, and back when it goes", async () => {
    const { src, inner, mix, f, camera, seen } = setup();
    await src.acquire({ audio: DEFAULT_AUDIO });
    mix.setInput("browser", PAGE_SOUND);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.getVideoTracks()).toEqual([camera]);
    expect(seen[0]!.getAudioTracks()).toEqual([f.mixTrack]);
    mix.setInput("browser", null);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.getAudioTracks().map((t) => t.id)).toEqual(["mic"]);
    expect(inner.acquire).toHaveBeenCalledTimes(1);
    expect(inner.release).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("puts the canvas picture and the mixed sound together", async () => {
    const { src, mix, f, seen } = setup();
    await src.acquire({ audio: DEFAULT_AUDIO });
    src.setDemand({ browserVisible: true, screenActive: false });
    mix.setInput("browser", PAGE_SOUND);
    const out = seen.at(-1)!;
    expect(out.getVideoTracks().map((t) => t.id)).toEqual(["canvas"]);
    expect(out.getAudioTracks()).toEqual([f.mixTrack]);
    vi.unstubAllGlobals();
  });

  it("takes the screen's system sound from the source at acquisition and hands it back on release", async () => {
    const { src, inner, mix } = setup();
    (inner.systemAudio as ReturnType<typeof vi.fn>).mockReturnValue(SCREEN_SOUND);
    const out = await src.acquire({ audio: DEFAULT_AUDIO });
    expect(mix.active).toBe(true);
    expect(out.getAudioTracks().map((t) => t.id)).toEqual(["mix"]);
    src.release();
    expect(mix.active).toBe(false);
    vi.unstubAllGlobals();
  });

  it("exposes the microphone stream the mute acts on", async () => {
    const { src, raw } = setup();
    await src.acquire({ audio: DEFAULT_AUDIO });
    expect(src.rawStream).toBe(raw);
    vi.unstubAllGlobals();
  });
});

describe("ScreenSource system sound", () => {
  it("asks for the loopback sound only when told to, and keeps it apart from the stream sent", async () => {
    vi.stubGlobal("MediaStream", class {
      constructor(private readonly tracks: MediaStreamTrack[]) {}
      getTracks() { return this.tracks; }
      getVideoTracks() { return this.tracks.filter((t) => t.kind === "video"); }
      getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio"); }
    });
    const display = stream(track("screen", "video"), track("loopback", "audio"));
    const getDisplayMedia = vi.fn(async () => display);
    const getUserMedia = vi.fn(async () => stream(track("mic", "audio")));
    const source = new ScreenSource({ getUserMedia, getDisplayMedia });
    const routing = new RoutingSource({ screen: source }, "screen");
    const out = await routing.acquire({ sourceKind: "screen", screen: { sourceId: "screen:0:0", includeMic: true, systemAudio: true }, audio: DEFAULT_AUDIO });
    expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: true }));
    expect(out.getAudioTracks().map((t) => t.id)).toEqual(["mic"]);
    expect(routing.systemAudio()?.getAudioTracks().map((t) => t.id)).toEqual(["loopback"]);
    routing.release();
    expect(routing.systemAudio()).toBeNull();

    await routing.acquire({ sourceKind: "screen", screen: { sourceId: "screen:0:0", includeMic: true }, audio: DEFAULT_AUDIO });
    expect(getDisplayMedia).toHaveBeenLastCalledWith(expect.objectContaining({ audio: false }));
    vi.unstubAllGlobals();
  });
});

describe("screenAudioSupport", () => {
  it("is available on Windows only, with a clear reason elsewhere", () => {
    expect(screenAudioSupport("win32")).toEqual({ supported: true, reason: null });
    const mac = screenAudioSupport("darwin");
    expect(mac.supported).toBe(false);
    expect(mac.reason).toMatch(/macOS/);
    expect(screenAudioSupport("linux").reason).toMatch(/not available/);
  });
});
