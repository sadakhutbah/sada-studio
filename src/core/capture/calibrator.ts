import { computeClapOffset, parseMetadataSeries, type CalibrationResult, type Sample } from "./calibration";
import type { CalibrationFiles, CaptureSourceStrategy, IpCameraConfig } from "./types";

/** I/O boundary of a calibration run, injected so the sequence is testable without ffmpeg. */
export interface CalibrationIo {
  /** Runs ffmpeg to completion; resolves with its exit code and the end of stderr. */
  runFfmpeg(args: string[]): Promise<{ code: number | null; stderr: string }>;
  /** Fresh output files plus their cleanup. */
  tempFiles(): Promise<CalibrationFiles & { dispose(): Promise<void> }>;
  readText(path: string): Promise<string>;
}

export type CalibrationOutcome = CalibrationResult | { ok: false; reason: "ffmpeg"; detail: string };

/**
 * The first moments of a run are unreliable: inputs open one after the other and buffered audio is stamped when it
 * is read, not when it was captured. Only what comes `settleS` after BOTH series have started is analysed.
 */
export function afterSettling(series: Sample[], settleS: number, other: Sample[]): Sample[] {
  if (!series.length || !other.length) return series;
  const from = Math.max(series[0]!.t, other[0]!.t) + settleS;
  return series.filter((s) => s.t >= from);
}

/**
 * Assisted clap calibration. The operator claps in front of the camera while ffmpeg records, for `seconds`,
 * the motion of the picture and the level of the sound on the same wall clock (no delay applied).
 * Returns the delay to store; the caller saves it per audio device.
 */
export async function calibrateClap(
  source: CaptureSourceStrategy,
  config: IpCameraConfig,
  io: CalibrationIo,
  seconds = 8,
  settleS = 2,
): Promise<CalibrationOutcome> {
  const files = await io.tempFiles();
  try {
    const r = await io.runFfmpeg(source.buildCalibrationArgs(config, seconds, files));
    if (r.code !== 0) return { ok: false, reason: "ffmpeg", detail: r.stderr.trim().split(/\r?\n/).at(-1) ?? "" };
    const [audio, video] = await Promise.all([io.readText(files.audioLevels), io.readText(files.videoMotion)]);
    const a = parseMetadataSeries(audio);
    const v = parseMetadataSeries(video);
    return computeClapOffset(afterSettling(a, settleS, v), afterSettling(v, settleS, a));
  } finally {
    await files.dispose();
  }
}
