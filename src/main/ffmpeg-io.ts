import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { CalibrationIo } from "../core/capture/calibrator";
import type { ProcessSpawner } from "../core/capture/controller";
import { dshowListArgs, parseDshowAudioDevices } from "../core/capture/devices";

/** Node-only (no Electron import) so that the integration tests use the exact same code as the application. */

export const spawnFfmpeg =
  (ffmpegPath = "ffmpeg"): ProcessSpawner =>
  (args) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    return {
      onLine(cb) {
        createInterface({ input: child.stdout }).on("line", (l) => cb(l, "out"));
        createInterface({ input: child.stderr }).on("line", (l) => cb(l, "err"));
      },
      onExit(cb) {
        child.once("close", (code) => cb(code));
        child.once("error", () => cb(null));
      },
      kill() {
        child.kill();
      },
    };
  };

/** Hard cap on a calibration run, on top of the per-input duration limit. */
const CALIBRATION_GRACE_MS = 20_000;

export const nodeCalibrationIo = (ffmpegPath = "ffmpeg"): CalibrationIo => ({
  runFfmpeg: (args) =>
    new Promise((resolve) => {
      const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
      const timer = setTimeout(() => child.kill(), CALIBRATION_GRACE_MS + 10_000);
      child.once("error", (e) => resolve({ code: null, stderr: e.message }));
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stderr });
      });
    }),
  async tempFiles() {
    const dir = await mkdtemp(join(tmpdir(), "sada-calib-"));
    return { audioLevels: join(dir, "audio.txt"), videoMotion: join(dir, "video.txt"), dispose: () => rm(dir, { recursive: true, force: true }) };
  },
  readText: (p) => readFile(p, "utf8"),
});

/** DirectShow audio inputs of this PC (Windows); empty elsewhere or when ffmpeg is missing. */
export function listDshowAudioDevices(ffmpegPath = "ffmpeg"): Promise<string[]> {
  return new Promise((resolve) => {
    // ffmpeg exits non-zero after listing: the list is on stderr whatever the code.
    execFile(ffmpegPath, dshowListArgs(), { windowsHide: true, timeout: 10_000 }, (_e, _out, stderr) => resolve(parseDshowAudioDevices(String(stderr))));
  });
}
