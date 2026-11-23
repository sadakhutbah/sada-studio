import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calibrateClap, type CalibrationIo } from "../src/core/capture/calibrator";
import { computeClapOffset, detectEvents, parseMetadataSeries, type Sample } from "../src/core/capture/calibration";
import { CaptureController, deviceKey, type RunningProcess } from "../src/core/capture/controller";
import { dshowListArgs, parseDshowAudioDevices } from "../src/core/capture/devices";
import { IP_CAMERA_SOURCE_ID, IpCameraLocalAudioSource, audioFilter, defaultCaptureSources } from "../src/core/capture/ip-camera-source";
import { INITIAL_CAPTURE_STATE, isProlongedOutage, transition } from "../src/core/capture/machine";
import { normalizeDelay, type IpCameraConfig } from "../src/core/capture/types";

const config: IpCameraConfig = { rtspUrl: "rtsp://u:p@10.0.0.5:554/s1", audioDevice: "Mixer (USB Audio)", audioBackend: "dshow", outputArgs: ["-f", "null", "-"] };

describe("ffmpeg command line", () => {
  const args = new IpCameraLocalAudioSource().buildCaptureArgs(config, 150, 1_000_000);
  const at = (flag: string) => args.indexOf(flag);

  it("one process, two inputs: RTSP over TCP then the DirectShow device, both on the wall clock", () => {
    expect(args.filter((a) => a === "-i")).toHaveLength(2);
    expect(args.filter((a) => a === "-use_wallclock_as_timestamps")).toHaveLength(2);
    expect(args).toContain("tcp");
    expect(args[args.indexOf("rtsp://u:p@10.0.0.5:554/s1") - 1]).toBe("-i");
    expect(args).toContain("audio=Mixer (USB Audio)");
    expect(args[at("-f") + 1]).toBe("dshow");
    expect(args).toContain("-copyts");
  });

  it("delays the audio with adelay and corrects drift with aresample async=1", () => {
    const af = args[at("-af") + 1]!;
    expect(af).toContain("adelay=delays=150:all=1");
    expect(af).toContain("aresample=async=1");
    expect(af.indexOf("adelay")).toBeLessThan(af.indexOf("aresample"));
    expect(af).toContain("asetpts=PTS-1000000/TB");
    expect(args[at("-vf") + 1]).toBe("setpts=PTS-1000000/TB");
  });

  it("no adelay at 0 ms; delay quantized to 50 ms and bounded", () => {
    expect(audioFilter(0)).not.toContain("adelay");
    expect(normalizeDelay(124)).toBe(100);
    expect(normalizeDelay(126)).toBe(150);
    expect(normalizeDelay(-30)).toBe(0);
    expect(normalizeDelay(99_999)).toBe(5000);
    expect(audioFilter(126)).toContain("delays=150");
  });

  it("output arguments of the configuration end the command line", () => {
    expect(args.slice(-3)).toEqual(["-f", "null", "-"]);
  });

  it("the calibration run applies no delay and reads both inputs for a bounded time", () => {
    const c = new IpCameraLocalAudioSource().buildCalibrationArgs(config, 8, { audioLevels: "C:\\t\\a.txt", videoMotion: "/t/v.txt" });
    expect(c.join(" ")).not.toContain("adelay");
    expect(c.filter((a) => a === "-t")).toHaveLength(2);
    expect(c.join(" ")).toContain("file=C\\:/t/a.txt");
  });

  it("registry picks the strategy by id", () => {
    const reg = defaultCaptureSources();
    expect(reg.ids()).toEqual([IP_CAMERA_SOURCE_ID]);
    expect(reg.create(IP_CAMERA_SOURCE_ID)).toBeInstanceOf(IpCameraLocalAudioSource);
    expect(() => reg.create("nope")).toThrow();
  });

  it("alsa / avfoundation / pcm backends", () => {
    const s = new IpCameraLocalAudioSource();
    expect(s.buildCaptureArgs({ ...config, audioBackend: "alsa", audioDevice: "hw:1" }, 0, 1).join(" ")).toContain("-f alsa -i hw:1");
    expect(s.buildCaptureArgs({ ...config, audioBackend: "avfoundation", audioDevice: "0" }, 0, 1).join(" ")).toContain("-i :0");
    expect(s.buildCaptureArgs({ ...config, audioBackend: "pcm", audioDevice: "tcp://x:1" }, 0, 1).join(" ")).toContain("-f s16le");
  });
});

/** Synthetic series: flat background plus one transient. */
const series = (n: number, step: number, base: number, peaks: Array<[number, number]>): Sample[] =>
  Array.from({ length: n }, (_, i) => ({ t: 100 + i * step, value: peaks.find(([t]) => Math.abs(100 + i * step - t) < step / 2)?.[1] ?? base }));

describe("clap calibration on synthetic signals", () => {
  it("audio clap at t=102.000, picture moves at 102.320 → audio delayed by 300 ms (quantized from 320)", () => {
    const audio = series(800, 0.01, -80, [[102.0, -6]]);
    const video = series(200, 0.04, 0.2, [[102.32, 40]]);
    const r = computeClapOffset(audio, video);
    expect(r).toMatchObject({ ok: true, gapMs: 320, delayMs: 300, audioBehind: false });
  });

  it("rounds to the nearest 50 ms step", () => {
    const r = computeClapOffset(series(800, 0.01, -80, [[102.0, -6]]), series(200, 0.04, 0.2, [[102.28, 40]]));
    expect(r).toMatchObject({ ok: true, gapMs: 280, delayMs: 300 });
  });

  it("picture before sound cannot be fixed by adelay: delay 0 and a flag", () => {
    const r = computeClapOffset(series(800, 0.01, -80, [[102.5, -6]]), series(200, 0.04, 0.2, [[102.2, 40]]));
    expect(r).toMatchObject({ ok: true, gapMs: -300, delayMs: 0, audioBehind: true });
  });

  it("a periodic signal pairs each sound with the closest picture event", () => {
    const audio = series(1000, 0.01, -80, [[101, -6], [103, -6], [105, -6], [107, -6]]);
    const video = series(250, 0.04, 0.2, [[101.4, 40], [103.4, 40], [105.4, 40], [107.4, 40]]);
    expect(computeClapOffset(audio, video)).toMatchObject({ ok: true, delayMs: 400 });
  });

  it("a two-edge flash counts as one event at its onset", () => {
    const video = series(200, 0.04, 0.2, [[102.2, 40], [102.32, 40]]);
    expect(detectEvents(video).events).toHaveLength(1);
    expect(detectEvents(video).events[0]!.t).toBeCloseTo(102.2, 2);
  });

  it("no clap: noise only", () => {
    expect(computeClapOffset(series(800, 0.01, -60, []), series(200, 0.04, 0.2, []))).toEqual({ ok: false, reason: "no-clap" });
    expect(computeClapOffset([], series(10, 0.04, 0, []))).toEqual({ ok: false, reason: "no-audio" });
    expect(computeClapOffset(series(10, 0.01, 0, []), [])).toEqual({ ok: false, reason: "no-video" });
  });

  it("parses ffmpeg metadata print output, -inf as floor", () => {
    const txt = "frame:0    pts:1 pts_time:1795419083.890167\nlavfi.astats.Overall.RMS_level=-inf\nframe:1    pts:2 pts_time:1795419083.9\nlavfi.astats.Overall.RMS_level=-3.5\n";
    expect(parseMetadataSeries(txt)).toEqual([
      { t: 1795419083.890167, value: -120 },
      { t: 1795419083.9, value: -3.5 },
    ]);
  });

  it("calibrateClap runs ffmpeg, parses both files, cleans up", async () => {
    const fmt = (s: Sample[], key: string) => s.map((x, i) => `frame:${i} pts:0 pts_time:${x.t}\n${key}=${x.value}\n`).join("");
    let disposed = false;
    const io: CalibrationIo = {
      runFfmpeg: async () => ({ code: 0, stderr: "" }),
      tempFiles: async () => ({ audioLevels: "a", videoMotion: "v", dispose: async () => void (disposed = true) }),
      readText: async (p) => (p === "a" ? fmt(series(900, 0.01, -80, [[104, -6]]), "lavfi.astats.Overall.RMS_level") : fmt(series(250, 0.04, 0.2, [[104.2, 40]]), "lavfi.signalstats.YAVG")),
    };
    const r = await calibrateClap(new IpCameraLocalAudioSource(), config, io, 8);
    expect(r).toMatchObject({ ok: true, delayMs: 200 });
    expect(disposed).toBe(true);
    const failing = await calibrateClap(new IpCameraLocalAudioSource(), config, { ...io, runFfmpeg: async () => ({ code: 1, stderr: "boom\nConnection refused" }) }, 8);
    expect(failing).toEqual({ ok: false, reason: "ffmpeg", detail: "Connection refused" });
  });
});

describe("capture state machine", () => {
  it("start → flowing → lost → retry → flowing, keeping when the outage began", () => {
    let s = transition(INITIAL_CAPTURE_STATE, { type: "START", at: 1000 });
    expect(s.status).toBe("starting");
    s = transition(s, { type: "FLOWING", at: 2000 });
    expect(s).toMatchObject({ status: "running", downSince: null });
    s = transition(s, { type: "EXITED", at: 5000, reason: "rtsp" });
    expect(s).toMatchObject({ status: "reconnecting", attempt: 1, downSince: 5000 });
    s = transition(s, { type: "RETRY" });
    s = transition(s, { type: "EXITED", at: 7000, reason: "rtsp" });
    expect(s).toMatchObject({ status: "reconnecting", attempt: 2, downSince: 5000 });
    expect(isProlongedOutage(s, 5000 + 119_000, 120_000)).toBe(false);
    expect(isProlongedOutage(s, 5000 + 121_000, 120_000)).toBe(true);
    s = transition(transition(s, { type: "RETRY" }), { type: "FLOWING", at: 9000 });
    expect(s).toMatchObject({ status: "running", attempt: 0, downSince: null });
  });
  it("stop and ignored events", () => {
    const s = transition(INITIAL_CAPTURE_STATE, { type: "START", at: 0 });
    const stopping = transition(s, { type: "STOP" });
    expect(stopping.status).toBe("stopping");
    expect(transition(stopping, { type: "FLOWING", at: 1 })).toBe(stopping);
    expect(transition(stopping, { type: "STOPPED" })).toBe(INITIAL_CAPTURE_STATE);
    expect(transition(INITIAL_CAPTURE_STATE, { type: "FLOWING", at: 1 })).toBe(INITIAL_CAPTURE_STATE);
  });
});

class FakeProc implements RunningProcess {
  lineCb: (l: string, s: "out" | "err") => void = () => undefined;
  exitCb: (c: number | null) => void = () => undefined;
  killed = false;
  onLine(cb: FakeProc["lineCb"]) { this.lineCb = cb; }
  onExit(cb: FakeProc["exitCb"]) { this.exitCb = cb; }
  kill() { this.killed = true; queueMicrotask(() => this.exitCb(null)); }
  frame(n: number) { this.lineCb(`frame=${n}`, "err"); }
}

describe("capture controller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const procs: FakeProc[] = [];
    const launches: string[][] = [];
    const store = new Map<string, number>();
    const alerts: Array<{ down: boolean; message: string }> = [];
    const ctl = new CaptureController({
      source: new IpCameraLocalAudioSource(),
      spawn: (args) => {
        launches.push(args);
        const p = new FakeProc();
        procs.push(p);
        return p;
      },
      getConfig: () => config,
      offsets: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) },
      onAlert: (a) => alerts.push(a),
      now: () => Date.now(),
      outageAlertMs: 60_000,
    });
    return { ctl, procs, launches, store, alerts };
  };

  it("reconnects after the process dies, with the same saved delay, and alerts after a prolonged outage", async () => {
    const { ctl, procs, launches, store, alerts } = setup();
    store.set(deviceKey(config), 250);
    ctl.start();
    procs[0]!.frame(1);
    expect(ctl.state.status).toBe("running");
    expect(ctl.healthCheck().ok).toBe(true);

    procs[0]!.exitCb(1); // camera gone
    expect(ctl.state.status).toBe("reconnecting");
    // retries keep failing for over a minute
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(16_000);
      procs.at(-1)!.exitCb(1);
    }
    expect(alerts.filter((a) => a.down)).toHaveLength(1);
    expect(ctl.healthCheck()).toMatchObject({ id: "capture", ok: false });
    expect(launches.length).toBeGreaterThan(5);
    for (const l of launches) expect(l.join(" ")).toContain("adelay=delays=250:all=1");

    await vi.advanceTimersByTimeAsync(16_000);
    procs.at(-1)!.frame(1);
    expect(ctl.state.status).toBe("running");
    expect(alerts.map((a) => a.down)).toEqual([true, false]);
    expect(ctl.healthCheck().ok).toBe(true);
  });

  it("restarts a frozen stream (no new frame) and keeps retry delays bounded", async () => {
    const { ctl, procs } = setup();
    ctl.start();
    procs[0]!.frame(1);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(procs[0]!.killed).toBe(true);
    expect(ctl.state.status).toBe("reconnecting");
  });

  it("changing the delay saves it per device and restarts the capture without counting a failure", async () => {
    const { ctl, procs, launches, store } = setup();
    ctl.start();
    procs[0]!.frame(1);
    expect(ctl.setAudioDelay(333)).toBe(350);
    expect(store.get(deviceKey(config))).toBe(350);
    await vi.advanceTimersByTimeAsync(10);
    expect(launches).toHaveLength(2);
    expect(launches[1]!.join(" ")).toContain("delays=350");
    expect(ctl.state.attempt).toBe(0);
  });

  it("stop resolves when the process is gone", async () => {
    const { ctl, procs } = setup();
    ctl.start();
    procs[0]!.frame(1);
    await ctl.stop();
    expect(ctl.state.status).toBe("idle");
    expect(procs[0]!.killed).toBe(true);
  });
});

describe("DirectShow device listing", () => {
  it("parses typed and sectioned ffmpeg output", () => {
    const typed = '[dshow @ 0x1] "Integrated Camera" (video)\n[dshow @ 0x1]   Alternative name "@device_pnp_x"\n[dshow @ 0x1] "Mixer (USB Audio)" (audio)\n[dshow @ 0x1]   Alternative name "@device_cm_y"\n';
    expect(parseDshowAudioDevices(typed)).toEqual(["Mixer (USB Audio)"]);
    const old = '[dshow @ 0x1] DirectShow video devices\n[dshow @ 0x1]  "Cam"\n[dshow @ 0x1] DirectShow audio devices\n[dshow @ 0x1]  "Line In"\n';
    expect(parseDshowAudioDevices(old)).toEqual(["Line In"]);
    expect(dshowListArgs()).toContain("dshow");
  });
});
