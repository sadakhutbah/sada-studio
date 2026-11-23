import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calibrateClap } from "../../src/core/capture/calibrator";
import { detectEvents, parseMetadataSeries } from "../../src/core/capture/calibration";
import { CaptureController, type ProcessSpawner } from "../../src/core/capture/controller";
import { IpCameraLocalAudioSource } from "../../src/core/capture/ip-camera-source";
import type { IpCameraConfig } from "../../src/core/capture/types";
import { nodeCalibrationIo, spawnFfmpeg } from "../../src/main/ffmpeg-io";

/**
 * Real end-to-end run: simulated IP camera (mediamtx + ffmpeg testsrc, RTSP/TCP), simulated sound card (TCP feeder
 * paced on the wall clock), real ffmpeg. Opt in with SADA_E2E=1; needs `ffmpeg` and `mediamtx` (or SADA_MEDIAMTX=/path).
 */
const enabled = process.env.SADA_E2E === "1";
const run = promisify(execFile);
const root = resolve(__dirname, "../..");
const PORT_RTSP = 18554;
const PORT_AUDIO = 18999;
const RTSP = `rtsp://127.0.0.1:${PORT_RTSP}/cam`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const config: IpCameraConfig = { rtspUrl: RTSP, audioDevice: `tcp://127.0.0.1:${PORT_AUDIO}`, audioBackend: "pcm", outputArgs: [] };

describe.skipIf(!enabled)("IP camera + local audio, real ffmpeg", () => {
  let mtx: ChildProcess;
  let camera: ChildProcess | null = null;
  let feeder: ChildProcess;
  const startCamera = () => (camera = spawn(join(root, "scripts/test-camera.sh"), [RTSP], { stdio: "ignore" }));

  beforeAll(async () => {
    mtx = spawn(process.env.SADA_MEDIAMTX ?? "mediamtx", [join(root, "tests/e2e/mediamtx.yml")], { stdio: "ignore" });
    await sleep(1500);
    startCamera();
    feeder = spawn(process.execPath, [join(root, "scripts/test-audio-feeder.mjs"), String(PORT_AUDIO), "2000"], { stdio: "ignore" });
    await sleep(3000);
  }, 20_000);

  afterAll(() => {
    feeder?.kill();
    camera?.kill();
    mtx?.kill();
  });

  it("calibrates a stable offset with the clap detector, on the shared wall clock", async () => {
    const source = new IpCameraLocalAudioSource();
    const a = await calibrateClap(source, config, nodeCalibrationIo(), 9);
    const b = await calibrateClap(source, config, nodeCalibrationIo(), 9);
    console.log("calibration runs", a, b);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // Camera and feeder keep running between the runs: the gap repeats (modulo the 2 s clap period) within jitter.
    const d = Math.abs(a.gapMs - b.gapMs) % 2000;
    expect(Math.min(d, 2000 - d)).toBeLessThan(200);
  }, 60_000);

  it("keeps audio and video aligned in the output once the calibrated delay is applied", async () => {
    const source = new IpCameraLocalAudioSource();
    const cal = await calibrateClap(source, config, nodeCalibrationIo(), 9);
    expect(cal.ok).toBe(true);
    if (!cal.ok) return;
    const dir = mkdtempSync(join(tmpdir(), "sada-e2e-"));
    const out = join(dir, "out.mkv");
    const store = new Map<string, number>();
    const ctl = new CaptureController({
      source,
      spawn: spawnFfmpeg(),
      getConfig: () => ({ ...config, outputArgs: ["-f", "matroska", out] }),
      offsets: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) },
    });
    ctl.setAudioDelay(cal.delayMs);
    ctl.start();
    await sleep(16_000);
    await ctl.stop();
    expect(existsSync(out)).toBe(true);

    // Sync measured in the output file itself: leading edge of each flash vs each beep, on the file's own timeline.
    const measure = async (args: string[]) => run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", out, ...args], { maxBuffer: 1 << 26 });
    const vf = join(dir, "v.txt");
    const af = join(dir, "a.txt");
    await measure(["-map", "0:v", "-vf", `scale=64:36,format=gray,tblend=all_mode=difference,signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=${vf}`, "-fps_mode", "passthrough", "-f", "null", "-"]);
    await measure(["-map", "0:a", "-af", `aresample=48000,asetnsamples=n=480:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=${af}`, "-f", "null", "-"]);
    const settled = (t: number) => t > 5; // the first seconds are unreliable (inputs opening, buffered audio)
    const flashes = detectEvents(parseMetadataSeries(readFileSync(vf, "utf8"))).events.map((e) => e.t).filter(settled);
    const beeps = detectEvents(parseMetadataSeries(readFileSync(af, "utf8"))).events.map((e) => e.t).filter(settled);
    const nearest = flashes.map((f) => beeps.reduce((best, b) => (Math.abs(b - f) < Math.abs(best) ? b - f : best), 99));
    console.log("calibration", cal, "flashes", flashes, "beeps", beeps, "beep-flash (s)", nearest);
    expect(flashes.length).toBeGreaterThanOrEqual(2);
    expect(beeps.length).toBeGreaterThanOrEqual(2);
    // aligned to within ~2 video frames + audio block (the file was encoded with the calibrated delay)
    for (const d of nearest) expect(Math.abs(d)).toBeLessThan(0.12);
  }, 120_000);

  it("reconnects by itself when the camera disappears, keeping the saved delay", async () => {
    const source = new IpCameraLocalAudioSource();
    const launches: string[][] = [];
    const real = spawnFfmpeg();
    const spy: ProcessSpawner = (args) => (launches.push(args), real(args));
    const store = new Map<string, number>([["pcm:" + config.audioDevice, 250]]);
    const alerts: boolean[] = [];
    const ctl = new CaptureController({
      source,
      spawn: spy,
      getConfig: () => ({ ...config, outputArgs: ["-f", "null", "-"] }),
      offsets: { get: (k) => store.get(k), set: (k, v) => void store.set(k, v) },
      onAlert: (a) => alerts.push(a.down),
      outageAlertMs: 4000,
      stallMs: 6000,
      watchdogMs: 500,
    });
    ctl.start();
    await waitFor(() => ctl.state.status === "running", 20_000);
    camera?.kill();
    await waitFor(() => ctl.state.status !== "running", 20_000);
    await sleep(6000); // outage longer than the alert threshold
    startCamera();
    await waitFor(() => ctl.state.status === "running", 40_000);
    await ctl.stop();
    expect(launches.length).toBeGreaterThanOrEqual(2);
    for (const args of launches) expect(args.join(" ")).toContain("adelay=delays=250:all=1");
    expect(alerts).toEqual([true, false]);
  }, 120_000);
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await sleep(250);
  }
}
