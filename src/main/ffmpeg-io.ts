import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { CalibrationIo } from "../core/capture/calibrator";
import type { ProcessSpawner } from "../core/capture/controller";
import { avfoundationListArgs, dshowListArgs, parseAvfoundationAudioDevices, parseDshowAudioDevices } from "../core/capture/devices";
import type { AudioBackend } from "../core/capture/types";

/** Node-only (no Electron import) so that the integration tests use the exact same code as the application. */

export const spawnFfmpeg =
  (ffmpegPath = "ffmpeg"): ProcessSpawner =>
  (args) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    // stdout carries the media (when the output is `pipe:1`); it must always be drained or ffmpeg would block.
    let consumed = false;
    queueMicrotask(() => !consumed && child.stdout.resume());
    return {
      onLine(cb) {
        createInterface({ input: child.stderr }).on("line", (l) => cb(l, "err"));
      },
      onData(cb) {
        consumed = true;
        child.stdout.on("data", (d: Buffer) => cb(d));
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

/**
 * ffmpeg for this installation: SADA_FFMPEG, else the copy shipped next to the application (Windows installer, macOS
 * app), else Homebrew's on macOS (an app started from the Finder does not get the shell PATH), else the one on the PATH.
 */
export function resolveFfmpeg(resourcesDir: string | null, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (env.SADA_FFMPEG) return env.SADA_FFMPEG;
  if (resourcesDir) {
    const bundled = join(resourcesDir, "ffmpeg", platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    if (existsSync(bundled)) return bundled;
  }
  if (platform === "darwin") {
    const brew = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find((p) => existsSync(p));
    if (brew) return brew;
  }
  return "ffmpeg";
}

/** Audio inputs of this machine: DirectShow (Windows) or AVFoundation (macOS); empty elsewhere or when ffmpeg is missing. */
export function listAudioDevices(backend: AudioBackend, ffmpegPath = "ffmpeg"): Promise<string[]> {
  const kinds: Partial<Record<AudioBackend, { args: string[]; parse: (stderr: string) => string[] }>> = {
    dshow: { args: dshowListArgs(), parse: parseDshowAudioDevices },
    avfoundation: { args: avfoundationListArgs(), parse: parseAvfoundationAudioDevices },
  };
  const kind = kinds[backend];
  if (!kind) return Promise.resolve([]);
  return new Promise((resolve) => {
    // ffmpeg exits non-zero after listing: the list is on stderr whatever the code.
    execFile(ffmpegPath, kind.args, { windowsHide: true, timeout: 10_000 }, (_e, _out, stderr) => resolve(kind.parse(String(stderr))));
  });
}
