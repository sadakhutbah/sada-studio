import type { Sample } from "../capture/calibration";
import { calibrateSeries, type CalibrationOutcome } from "../capture/calibrator";

/** Where the series of a webcam run come from (browser: analyser + canvas; tests: scripted). */
export interface SeriesRecorder {
  /** Records the microphone level (dB) and picture motion for `seconds`, on one clock (seconds). */
  record(seconds: number): Promise<{ audio: Sample[]; video: Sample[] }>;
}

/** dBFS of a block of float samples; digital silence is the floor. */
export function levelDb(block: Float32Array, floor = -120): number {
  if (block.length === 0) return floor;
  let sum = 0;
  for (const x of block) sum += x * x;
  const rms = Math.sqrt(sum / block.length);
  return rms > 0 ? Math.max(floor, 20 * Math.log10(rms)) : floor;
}

/** Mean absolute luma difference between two RGBA frames of the same size (gray levels). */
export function motionBetween(prev: Uint8ClampedArray, cur: Uint8ClampedArray): number {
  const n = Math.min(prev.length, cur.length) >> 2;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const o = i << 2;
    const a = 0.299 * prev[o]! + 0.587 * prev[o + 1]! + 0.114 * prev[o + 2]!;
    const b = 0.299 * cur[o]! + 0.587 * cur[o + 1]! + 0.114 * cur[o + 2]!;
    sum += Math.abs(a - b);
  }
  return sum / n;
}

/**
 * Webcam strategy of the clap calibration: same analysis as the IP camera (`calibrateSeries`), the series being
 * recorded in the renderer instead of by ffmpeg.
 */
export async function calibrateWebcam(recorder: SeriesRecorder, seconds = 10, settleS = 1): Promise<CalibrationOutcome> {
  try {
    const { audio, video } = await recorder.record(seconds);
    return calibrateSeries(audio, video, settleS);
  } catch (e) {
    return { ok: false, reason: "ffmpeg", detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Browser recorder: analyser of the microphone (before the delay) and a 64×36 copy of the picture. */
export class BrowserSeriesRecorder implements SeriesRecorder {
  constructor(
    private readonly videoStream: MediaStream,
    private readonly analyser: AnalyserNode,
    /** Latency of the microphone path, seconds: the sound happened this long before it is read. */
    private readonly audioLatencyS = 0,
  ) {}

  async record(seconds: number): Promise<{ audio: Sample[]; video: Sample[] }> {
    const clock = () => performance.now() / 1000;
    const audio: Sample[] = [];
    const video: Sample[] = [];
    const el = document.createElement("video");
    el.muted = true;
    el.playsInline = true;
    el.srcObject = new MediaStream(this.videoStream.getVideoTracks());
    await el.play();
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 36;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    if (!g) throw new Error("canvas unavailable");
    let prev: Uint8ClampedArray | null = null;
    const block = new Float32Array(this.analyser.fftSize);
    const sampleVideo = (t: number) => {
      g.drawImage(el, 0, 0, canvas.width, canvas.height);
      const cur = g.getImageData(0, 0, canvas.width, canvas.height).data;
      if (prev) video.push({ t, value: motionBetween(prev, cur) });
      prev = cur;
    };
    const timer = setInterval(() => {
      this.analyser.getFloatTimeDomainData(block);
      audio.push({ t: clock() - this.audioLatencyS, value: levelDb(block.subarray(block.length >> 1)) });
    }, 10);
    let stopped = false;
    const onFrame = (_now: number, meta?: { captureTime?: number }) => {
      if (stopped) return;
      sampleVideo(meta?.captureTime !== undefined ? meta.captureTime / 1000 : clock());
      el.requestVideoFrameCallback(onFrame);
    };
    el.requestVideoFrameCallback(onFrame);
    try {
      await new Promise((r) => setTimeout(r, seconds * 1000));
    } finally {
      stopped = true;
      clearInterval(timer);
      el.pause();
      el.srcObject = null;
    }
    return { audio, video };
  }
}
