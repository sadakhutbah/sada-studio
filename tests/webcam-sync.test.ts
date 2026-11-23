import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sample } from "../src/core/capture/calibration";
import { AudioDelay } from "../src/core/sources/audio-delay";
import { CameraSource } from "../src/core/sources/camera";
import { calibrateWebcam, levelDb, motionBetween, type SeriesRecorder } from "../src/core/sources/webcam-calibration";
import { RoutingSource } from "../src/core/sources/routing";
import { DEFAULT_AUDIO } from "../src/core/sources/types";

/** Series at 10 ms (audio) / 40 ms (picture): one clap at `audioAt`, the picture reacting `gap` seconds later. */
function series(audioAt: number, gap: number): { audio: Sample[]; video: Sample[] } {
  const audio: Sample[] = [];
  const video: Sample[] = [];
  for (let t = 0; t < 10; t += 0.01) audio.push({ t, value: t >= audioAt && t < audioAt + 0.15 ? -10 : -70 });
  for (let t = 0; t < 10; t += 0.04) video.push({ t, value: t >= audioAt + gap && t < audioAt + gap + 0.16 ? 25 : 0.3 });
  return { audio, video };
}
const scripted = (s: { audio: Sample[]; video: Sample[] }): SeriesRecorder => ({ record: async () => s });

describe("webcam calibration (same analysis as the IP camera)", () => {
  it("finds the delay to apply when the picture is late", async () => {
    const r = await calibrateWebcam(scripted(series(4, 0.25)));
    expect(r).toMatchObject({ ok: true, delayMs: 250, audioBehind: false });
  });

  it("quantizes to the 50 ms step", async () => {
    const r = await calibrateWebcam(scripted(series(4, 0.12)));
    expect(r.ok && r.delayMs).toBe(100);
  });

  it("does not delay when the sound is already behind the picture", async () => {
    const r = await calibrateWebcam(scripted(series(4, -0.2)));
    expect(r).toMatchObject({ ok: true, delayMs: 0, audioBehind: true });
  });

  it("fails cleanly without a clap, without sound, or when recording throws", async () => {
    const flat = { audio: series(4, 0).audio.map((s) => ({ ...s, value: -70 })), video: series(4, 0).video };
    expect(await calibrateWebcam(scripted(flat))).toEqual({ ok: false, reason: "no-clap" });
    expect(await calibrateWebcam(scripted({ audio: [], video: series(4, 0).video }))).toEqual({ ok: false, reason: "no-audio" });
    const broken: SeriesRecorder = { record: () => Promise.reject(new Error("canvas indisponible")) };
    expect(await calibrateWebcam(broken)).toEqual({ ok: false, reason: "ffmpeg", detail: "canvas indisponible" });
  });
});

describe("measures", () => {
  it("levelDb: full scale square wave is 0 dB, silence is the floor", () => {
    expect(levelDb(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(0);
    expect(levelDb(new Float32Array([0.1, -0.1]))).toBeCloseTo(-20);
    expect(levelDb(new Float32Array(8))).toBe(-120);
  });
  it("motionBetween: mean luma difference", () => {
    const a = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
    const b = new Uint8ClampedArray([100, 100, 100, 255, 0, 0, 0, 255]);
    expect(motionBetween(a, a)).toBe(0);
    expect(motionBetween(a, b)).toBeCloseTo(50);
  });
});

// Minimal fakes of the Web Audio / MediaStream objects (the tests run in node).
class FakeTrack {
  readyState = "live";
  stopped = false;
  constructor(public kind: "audio" | "video") {}
  stop() {
    this.stopped = true;
    this.readyState = "ended";
  }
  addEventListener() {}
  getSettings() {
    return { latency: 0.03 };
  }
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
const param = () => ({ value: 0 });
function fakeContext() {
  const delay = { delayTime: param(), connect: vi.fn() };
  const ctx = {
    delay,
    closed: false,
    createMediaStreamSource: () => ({ connect: vi.fn() }),
    createDelay: vi.fn((max: number) => Object.assign(delay, { max })),
    createMediaStreamDestination: () => ({ stream: new FakeStream([new FakeTrack("audio")]) }),
    createAnalyser: () => ({ fftSize: 0 }),
    resume: () => Promise.resolve(),
    close() {
      ctx.closed = true;
      return Promise.resolve();
    },
  };
  return ctx;
}

describe("AudioDelay", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("delays only the microphone, keeps the picture track, changes live and is bounded to 50 ms steps", () => {
    vi.stubGlobal("MediaStream", FakeStream);
    const ctx = fakeContext();
    const cam = new FakeTrack("video");
    const d = new AudioDelay(new FakeStream([cam, new FakeTrack("audio")]) as unknown as MediaStream, 120, ctx as unknown as AudioContext);
    expect(ctx.createDelay).toHaveBeenCalledWith(5);
    expect(ctx.delay.delayTime.value).toBeCloseTo(0.1); // 120 → 100 ms
    expect(d.currentMs).toBe(100);
    d.setDelayMs(2000);
    expect(ctx.delay.delayTime.value).toBeCloseTo(2);
    d.setDelayMs(99999);
    expect(d.currentMs).toBe(5000);
    d.setDelayMs(-30);
    expect(d.currentMs).toBe(0);
    const out = d.output.getTracks();
    expect(out).toContain(cam);
    expect(out).toHaveLength(2);
    expect(d.inputLatencyS).toBe(0.03);
    d.close();
    expect(ctx.closed).toBe(true);
  });

  it("passes a stream without microphone through", () => {
    vi.stubGlobal("MediaStream", FakeStream);
    const input = new FakeStream([new FakeTrack("video")]) as unknown as MediaStream;
    const d = new AudioDelay(input, 100, fakeContext() as unknown as AudioContext);
    expect(d.output).toBe(input);
    expect(d.analyser).toBeNull();
  });
});

describe("CameraSource with the delay stage", () => {
  const mk = () => {
    const raw = new FakeStream([new FakeTrack("video"), new FakeTrack("audio")]);
    const out = new FakeStream([new FakeTrack("video"), new FakeTrack("audio")]);
    const devices = { getUserMedia: vi.fn(async () => raw as unknown as MediaStream) };
    const stage = { output: out, setDelayMs: vi.fn(), close: vi.fn(), analyser: null, inputLatencyS: 0 };
    const create = vi.fn((_r: MediaStream, _ms: number) => stage as unknown as AudioDelay);
    return { raw, out, devices, stage, create, source: new CameraSource(devices, create) };
  };
  const opts = { audio: DEFAULT_AUDIO };

  it("returns the delayed stream, and a delay change does not reopen the camera", async () => {
    const { out, devices, stage, create, source } = mk();
    const s1 = await source.acquire({ ...opts, audioDelayMs: 100 });
    expect(s1).toBe(out);
    expect(create).toHaveBeenCalledWith(expect.anything(), 100);
    const s2 = await source.acquire({ ...opts, audioDelayMs: 300 });
    expect(s2).toBe(s1);
    expect(devices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(stage.setDelayMs).toHaveBeenCalledWith(300);
    source.sync.setAudioDelay(450);
    expect(stage.setDelayMs).toHaveBeenLastCalledWith(450);
  });

  it("reopens when the camera or microphone changes; release stops everything", async () => {
    const { raw, devices, stage, source } = mk();
    await source.acquire({ ...opts, videoDeviceId: "a" });
    await source.acquire({ ...opts, videoDeviceId: "b" });
    expect(devices.getUserMedia).toHaveBeenCalledTimes(2);
    source.release();
    expect(raw.getTracks().every((t) => t.stopped)).toBe(true);
    expect(stage.close).toHaveBeenCalled();
  });

  it("falls back to the raw stream when Web Audio is unavailable", async () => {
    const raw = new FakeStream([new FakeTrack("video"), new FakeTrack("audio")]);
    const source = new CameraSource({ getUserMedia: async () => raw as unknown as MediaStream }, () => null);
    expect(await source.acquire(opts)).toBe(raw);
    expect(await source.calibrate()).toMatchObject({ ok: false });
  });

  it("is reachable through the routing source", () => {
    const { source } = mk();
    const routing = new RoutingSource({ camera: source }, "camera");
    expect(routing.syncOf("camera")).toBe(source.sync);
    expect(routing.syncOf("ip-camera")).toBeUndefined();
  });
});
