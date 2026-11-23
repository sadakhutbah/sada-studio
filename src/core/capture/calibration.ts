import { AUDIO_DELAY_MAX_MS, normalizeDelay } from "./types";

export interface Sample {
  /** Seconds on the shared wall clock. */
  t: number;
  value: number;
}

/**
 * Parses ffmpeg `metadata=mode=print` output: pairs of lines
 *   frame:12   pts:123456   pts_time:4.93
 *   lavfi.signalstats.YAVG=3.2
 * `-inf` (digital silence) becomes `floor`.
 */
export function parseMetadataSeries(text: string, floor = -120): Sample[] {
  const out: Sample[] = [];
  let t: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /pts_time:(-?[\d.]+(?:e[+-]?\d+)?)/i.exec(line);
    if (m) {
      t = Number(m[1]);
      continue;
    }
    const kv = /^lavfi\.[\w.]+=(.+)$/.exec(line.trim());
    if (kv && t !== null) {
      const raw = kv[1]!.trim();
      const v = /inf/i.test(raw) ? floor : Number(raw);
      if (Number.isFinite(v)) out.push({ t, value: Math.max(floor, v) });
      t = null;
    }
  }
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

export interface ClapEvent {
  /** Onset of the event, seconds on the shared clock. */
  t: number;
  value: number;
}

export interface Events {
  events: ClapEvent[];
  /** Height of the highest sample above the median background (same unit as the series). */
  prominence: number;
}

/** Samples closer than this belong to the same event (a clap rings over several frames; a flash has two edges). */
const EVENT_GAP_S = 0.25;

/**
 * Events of a series: groups of samples above the middle between background (median) and peak. An event's time is
 * its first sample within 10 % of its own maximum, i.e. the instant of the transient rather than its tail.
 */
export function detectEvents(series: Sample[]): Events {
  if (series.length === 0) return { events: [], prominence: 0 };
  const background = median(series.map((s) => s.value));
  const max = Math.max(...series.map((s) => s.value));
  const range = max - background;
  const threshold = background + range / 2;
  const events: ClapEvent[] = [];
  let group: Sample[] = [];
  const flush = () => {
    if (!group.length) return;
    const peak = Math.max(...group.map((s) => s.value));
    const onset = group.find((s) => s.value >= peak - 0.1 * range)!;
    events.push({ t: onset.t, value: peak });
    group = [];
  };
  for (const s of series) {
    if (s.value < threshold) continue;
    if (group.length && s.t - group[group.length - 1]!.t > EVENT_GAP_S) flush();
    group.push(s);
  }
  flush();
  return { events, prominence: range };
}

export type CalibrationFailure = "no-audio" | "no-video" | "no-clap";

export interface CalibrationSuccess {
  ok: true;
  /** Raw gap, ms: positive = the picture arrives after the sound (audio must be delayed). */
  gapMs: number;
  /** Delay to apply to the audio, quantized and bounded. */
  delayMs: number;
  /** The gap was negative (audio behind the video): adelay cannot fix it, delay is 0. */
  audioBehind: boolean;
}

export type CalibrationResult = CalibrationSuccess | { ok: false; reason: CalibrationFailure };

export interface CalibrationOptions {
  /** Minimum prominence of the audio peak, dB. */
  minAudioDb: number;
  /** Minimum prominence of the motion peak, in gray levels of mean frame difference. */
  minMotion: number;
  /** A video event further than this from the audio event is not the same clap, seconds. */
  windowS: number;
}

export const DEFAULT_CALIBRATION: CalibrationOptions = { minAudioDb: 12, minMotion: 2, windowS: 3 };

/**
 * Clap calibration: the loudest sound and the strongest motion near it (same clock) are the same clap; their gap is
 * the audio delay to configure. When several events are equally strong (a periodic test signal), the closest wins.
 */
export function computeClapOffset(audio: Sample[], video: Sample[], opts: CalibrationOptions = DEFAULT_CALIBRATION): CalibrationResult {
  if (audio.length === 0) return { ok: false, reason: "no-audio" };
  if (video.length === 0) return { ok: false, reason: "no-video" };
  const a = detectEvents(audio);
  const v = detectEvents(video);
  if (a.prominence < opts.minAudioDb || v.prominence < opts.minMotion || !a.events.length || !v.events.length) return { ok: false, reason: "no-clap" };

  const strongestA = Math.max(...a.events.map((e) => e.value));
  const audioEvent = a.events.find((e) => e.value >= strongestA - 3)!; // first of the loudest (within 3 dB)
  const near = v.events.filter((e) => Math.abs(e.t - audioEvent.t) <= opts.windowS);
  if (!near.length) return { ok: false, reason: "no-clap" };
  const strongestV = Math.max(...near.map((e) => e.value));
  const candidates = near.filter((e) => e.value >= strongestV - 0.1 * v.prominence);
  const videoEvent = candidates.reduce((best, e) => (Math.abs(e.t - audioEvent.t) < Math.abs(best.t - audioEvent.t) ? e : best));

  const gapMs = Math.round((videoEvent.t - audioEvent.t) * 1000);
  const audioBehind = gapMs < 0;
  return { ok: true, gapMs, delayMs: audioBehind ? 0 : Math.min(AUDIO_DELAY_MAX_MS, normalizeDelay(gapMs)), audioBehind };
}
