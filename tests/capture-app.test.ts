import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunningProcess } from "../src/core/capture/controller";
import { Mp4Splitter } from "../src/core/capture/mp4-boxes";
import { DEFAULT_CAPTURE_SETTINGS, isComplete, isRtspUrl, MSE_OUTPUT_ARGS, parseSettings, redactUrl, toIpCameraConfig } from "../src/core/capture/settings";
import { IpCameraSource, type CapturePlayer } from "../src/core/sources/ip-camera";
import { RoutingSource } from "../src/core/sources/routing";
import type { MediaSourceStrategy, SourceOptions } from "../src/core/sources/types";
import { FileAudioOffsetStore, FileCaptureSettingsStore } from "../src/main/capture-files";
import { CaptureService } from "../src/main/capture-service";
import { resolveFfmpeg } from "../src/main/ffmpeg-io";

const box = (type: string, size: number) => {
  const b = new Uint8Array(size);
  new DataView(b.buffer).setUint32(0, size);
  b.set([...type].map((c) => c.charCodeAt(0)), 4);
  return b;
};
const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));

describe("Mp4Splitter", () => {
  const stream = cat(box("ftyp", 24), box("moov", 100), box("moof", 40), box("mdat", 500), box("free", 16), box("moof", 40), box("mdat", 300));

  it("emits the init segment once, then one unit per moof+mdat, whatever the chunking", () => {
    for (const step of [1, 7, 64, stream.length]) {
      const s = new Mp4Splitter();
      const out = [];
      for (let i = 0; i < stream.length; i += step) out.push(...s.push(stream.subarray(i, i + step)));
      expect(out.map((c) => [c.init, c.data.length])).toEqual([
        [true, 124],
        [false, 540],
        [false, 340],
      ]);
    }
  });

  it("rejects a broken box size instead of looping", () => {
    const bad = new Uint8Array(8);
    new DataView(bad.buffer).setUint32(0, 3);
    expect(() => new Mp4Splitter().push(bad)).toThrow();
  });
});

describe("capture settings", () => {
  it("validates RTSP addresses and redacts the password", () => {
    expect(isRtspUrl("rtsp://u:p@192.168.1.20:554/stream1")).toBe(true);
    expect(isRtspUrl("http://x/y")).toBe(false);
    expect(isRtspUrl("rtsp://")).toBe(false);
    expect(redactUrl("rtsp://admin:s3cret@10.0.0.2/live")).toBe("rtsp://admin:***@10.0.0.2/live");
    expect(redactUrl("ffmpeg: rtsp://a:b@h/x: Connection refused")).not.toContain(":b@");
  });

  it("parses untrusted input: unknown kind falls back to the camera, a bad address is refused", () => {
    expect(parseSettings({ sourceKind: "ip-camera", rtspUrl: " rtsp://h/x ", audioDevice: " Mic " })).toEqual({ sourceKind: "ip-camera", rtspUrl: "rtsp://h/x", audioDevice: "Mic" });
    expect(parseSettings({ sourceKind: "weird" })?.sourceKind).toBe("camera");
    expect(parseSettings({ sourceKind: "ip-camera", rtspUrl: "file:///etc/passwd" })).toBeNull();
    expect(parseSettings(null)).toBeNull();
    expect(isComplete({ sourceKind: "ip-camera", rtspUrl: "rtsp://h/x", audioDevice: "" })).toBe(false);
  });

  it("the application output is a fragmented MP4 on stdout", () => {
    const c = toIpCameraConfig({ sourceKind: "ip-camera", rtspUrl: "rtsp://h/x", audioDevice: "Mic" }, "dshow");
    expect(c.outputArgs).toBe(MSE_OUTPUT_ARGS);
    expect(c.outputArgs.at(-1)).toBe("pipe:1");
    expect(c.outputArgs.join(" ")).toContain("frag_keyframe+empty_moov");
  });
});

describe("persistence per device", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "sada-cap-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("audio delays survive a restart, are quantized and kept per sound card", () => {
    const a = new FileAudioOffsetStore(dir);
    expect(a.get("dshow:Mic A")).toBeUndefined();
    a.set("dshow:Mic A", 333);
    a.set("dshow:Mic B", 100);
    const b = new FileAudioOffsetStore(dir);
    expect(b.get("dshow:Mic A")).toBe(350);
    expect(b.get("dshow:Mic B")).toBe(100);
  });

  it("settings round-trip; a corrupt or hostile file gives the defaults", () => {
    const s = new FileCaptureSettingsStore(dir);
    expect(s.load()).toEqual(DEFAULT_CAPTURE_SETTINGS);
    s.save({ sourceKind: "ip-camera", rtspUrl: "rtsp://h/x", audioDevice: "Mic" });
    expect(new FileCaptureSettingsStore(dir).load()).toMatchObject({ sourceKind: "ip-camera", audioDevice: "Mic" });
    writeFileSync(join(dir, "capture-settings.json"), "{not json");
    expect(s.load()).toEqual(DEFAULT_CAPTURE_SETTINGS);
    writeFileSync(join(dir, "audio-offsets.json"), JSON.stringify({ "x": "bad", "y": 99999 }));
    const o = new FileAudioOffsetStore(dir);
    expect(o.get("x")).toBeUndefined();
    expect(o.get("y")).toBe(5000);
  });
});

class FakeFfmpeg implements RunningProcess {
  lineCb: (l: string, s: "out" | "err") => void = () => undefined;
  dataCb: (b: Uint8Array) => void = () => undefined;
  exitCb: (c: number | null) => void = () => undefined;
  killed = false;
  onLine(cb: FakeFfmpeg["lineCb"]) { this.lineCb = cb; }
  onData(cb: FakeFfmpeg["dataCb"]) { this.dataCb = cb; }
  onExit(cb: FakeFfmpeg["exitCb"]) { this.exitCb = cb; }
  kill() { this.killed = true; queueMicrotask(() => this.exitCb(null)); }
}

describe("CaptureService", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sada-svc-"));
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  const make = (settings = { sourceKind: "ip-camera" as const, rtspUrl: "rtsp://u:pw@10.0.0.5/s", audioDevice: "Mixer" }) => {
    const store = new FileCaptureSettingsStore(dir);
    store.save(settings);
    const procs: FakeFfmpeg[] = [];
    const launches: string[][] = [];
    const media: Array<{ init: boolean; len: number }> = [];
    const views: string[] = [];
    const svc = new CaptureService({
      settings: store,
      offsets: new FileAudioOffsetStore(dir),
      ffmpegPath: "ffmpeg",
      audioBackend: "dshow",
      spawn: (args) => {
        launches.push(args);
        const p = new FakeFfmpeg();
        procs.push(p);
        return p;
      },
      onView: (v) => views.push(v.state.status),
      onMedia: (m) => media.push({ init: m.init, len: m.data.length }),
      log: () => undefined,
    });
    return { svc, procs, launches, media, views, store };
  };

  it("acquire starts one ffmpeg that writes fragmented MP4 on stdout; media is forwarded and the init is replayed", async () => {
    const { svc, procs, launches, media } = make();
    await svc.acquire();
    expect(launches).toHaveLength(1);
    expect(launches[0]!.at(-1)).toBe("pipe:1");
    expect(launches[0]!).toContain("audio=Mixer");
    procs[0]!.dataCb(cat(box("ftyp", 24), box("moov", 100)));
    procs[0]!.dataCb(cat(box("moof", 40), box("mdat", 60)));
    procs[0]!.lineCb("frame=1", "err");
    expect(media).toEqual([{ init: true, len: 124 }, { init: false, len: 100 }]);
    expect(svc.view.state.status).toBe("running");
    await svc.acquire(); // a second window asks again: no second process, init sent again
    expect(launches).toHaveLength(1);
    expect(media.at(-1)).toEqual({ init: true, len: 124 });
    await svc.release();
    expect(procs[0]!.killed).toBe(true);
  });

  it("never exposes the password in the status line or the capture errors", async () => {
    const { svc, procs } = make();
    await svc.acquire();
    procs[0]!.lineCb("rtsp://u:pw@10.0.0.5/s: Connection refused", "err");
    procs[0]!.exitCb(1);
    const v = svc.view;
    expect(v.rtspUrlShown).toBe("rtsp://u:***@10.0.0.5/s");
    expect(v.state.lastError).not.toContain(":pw@");
    await svc.release();
  });

  it("a delay is saved at once per sound card, shown, and applied by one restart once the clicks stop", async () => {
    const { svc, procs, launches } = make();
    await svc.acquire();
    procs[0]!.lineCb("frame=1", "err");
    svc.stepDelay(1);
    svc.stepDelay(1);
    svc.stepDelay(1);
    expect(svc.view.delayMs).toBe(150);
    expect(new FileAudioOffsetStore(dir).get("dshow:Mixer")).toBe(150);
    expect(launches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(launches).toHaveLength(2);
    expect(launches[1]!.join(" ")).toContain("adelay=delays=150");
    expect(svc.stepDelay(-1).delayMs).toBe(100);
    expect(svc.setDelay(-500).delayMs).toBe(0);
    await svc.release();
  });

  it("refuses to start without an address or sound card, and rejects an invalid address", async () => {
    const { svc, launches } = make({ sourceKind: "ip-camera", rtspUrl: "", audioDevice: "" });
    await expect(svc.acquire()).rejects.toThrow();
    expect(launches).toHaveLength(0);
    expect(() => svc.setSettings({ sourceKind: "ip-camera", rtspUrl: "ftp://x", audioDevice: "" })).toThrow();
  });

  it("changing the address restarts the capture; switching back to the PC camera stops it and silences the health check", async () => {
    const { svc, procs, launches } = make();
    await svc.acquire();
    procs[0]!.lineCb("frame=1", "err");
    expect(svc.healthChecks()).toEqual([expect.objectContaining({ id: "capture", ok: true })]);
    svc.setSettings({ sourceKind: "ip-camera", rtspUrl: "rtsp://other/x", audioDevice: "Mixer" });
    await vi.advanceTimersByTimeAsync(10);
    expect(launches).toHaveLength(2);
    expect(launches[1]!).toContain("rtsp://other/x");
    svc.setSettings({ sourceKind: "camera", rtspUrl: "rtsp://other/x", audioDevice: "Mixer" });
    await vi.advanceTimersByTimeAsync(10);
    expect(procs[1]!.killed).toBe(true);
    expect(svc.healthChecks()).toEqual([]);
    expect(new FileCaptureSettingsStore(dir).load().sourceKind).toBe("camera");
  });

  it("a prolonged outage turns the health check red", async () => {
    const { svc, procs } = make();
    await svc.acquire();
    procs[0]!.lineCb("frame=1", "err");
    procs[0]!.exitCb(1);
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(16_000);
      procs.at(-1)!.exitCb(1);
    }
    expect(svc.view.alert).toBe(true);
    expect(svc.healthChecks()[0]).toMatchObject({ id: "capture", ok: false });
    await svc.release();
  });
});

describe("sources", () => {
  const fakeStream = (live = true) => {
    const tracks = [{ readyState: live ? "live" : "ended", stop: vi.fn() }];
    return { getTracks: () => tracks } as unknown as MediaStream;
  };
  const opts = (rtspUrl: string): SourceOptions => ({ sourceKind: "ip-camera", ipCamera: { rtspUrl, audioDevice: "Mic" }, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });

  it("IP camera source: one open shared by simultaneous callers, reopened when the configuration changes, closed on release", async () => {
    const players: Array<CapturePlayer & { opened: number; closed: number }> = [];
    const src = new IpCameraSource(() => {
      const p = { opened: 0, closed: 0, open: async () => (p.opened++, fakeStream()), close: () => void p.closed++, onEnded: () => () => undefined };
      players.push(p);
      return p;
    });
    const [a, b] = await Promise.all([src.acquire(opts("rtsp://a/x")), src.acquire(opts("rtsp://a/x"))]);
    expect(a).toBe(b);
    expect(players).toHaveLength(1);
    expect(await src.acquire(opts("rtsp://a/x"))).toBe(a);
    await src.acquire(opts("rtsp://b/x"));
    expect(players).toHaveLength(2);
    expect(players[0]!.closed).toBe(1);
    src.release();
    expect(players[1]!.closed).toBe(1);
  });

  it("IP camera source: a failed opening releases the player and the next call retries", async () => {
    let n = 0;
    const closed: number[] = [];
    const src = new IpCameraSource(() => {
      const id = ++n;
      return { open: async () => { if (id === 1) throw new Error("no picture"); return fakeStream(); }, close: () => void closed.push(id), onEnded: () => () => undefined };
    });
    await expect(src.acquire(opts("rtsp://a/x"))).rejects.toThrow("no picture");
    expect(closed).toEqual([1]);
    await expect(src.acquire(opts("rtsp://a/x"))).resolves.toBeDefined();
  });

  it("routing source picks the source from the options and releases the previous one when switching", async () => {
    const mk = (name: string): MediaSourceStrategy & { released: number } => ({
      id: name,
      released: 0,
      acquire: async () => fakeStream(),
      release() { this.released++; },
      onEnded: () => () => undefined,
    });
    const camera = mk("camera");
    const ip = mk("ip-camera");
    const r = new RoutingSource({ camera, "ip-camera": ip }, "camera");
    const audio = opts("rtsp://a/x").audio;
    await r.acquire({ audio });
    expect(camera.released + ip.released).toBe(0);
    await r.acquire(opts("rtsp://a/x"));
    expect(camera.released).toBe(1);
    await r.acquire({ audio, sourceKind: "camera" });
    expect(ip.released).toBe(1);
    r.release();
    expect(camera.released).toBe(2);
  });
});

describe("ffmpeg location", () => {
  it("prefers SADA_FFMPEG, then the copy shipped with the installer, then the PATH", () => {
    expect(resolveFfmpeg(null, "win32", { SADA_FFMPEG: "C:\\x\\ffmpeg.exe" })).toBe("C:\\x\\ffmpeg.exe");
    const dir = mkdtempSync(join(tmpdir(), "sada-res-"));
    try {
      expect(resolveFfmpeg(dir, "linux", {})).toBe("ffmpeg");
      rmSync(dir, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
