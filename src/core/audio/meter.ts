/** Level in dBFS (−100 = silence) of a block of float samples [-1, 1]. */
export function levelDb(samples: ArrayLike<number>): { rms: number; peak: number } {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    sum += v * v;
    if (v > peak) peak = v;
  }
  const db = (x: number) => (x <= 1e-5 ? -100 : 20 * Math.log10(x));
  return { rms: db(Math.sqrt(sum / Math.max(1, samples.length))), peak: db(peak) };
}

/** Position 0..1 of a dB level on the meter (−60 dB → 0, 0 dB → 1). */
export const meterPosition = (db: number, floor = -60) => Math.min(1, Math.max(0, (db - floor) / -floor));

export interface LevelMeter {
  /** Current levels in dBFS. */
  read(): { rms: number; peak: number };
  dispose(): void;
}

/** Level meter attached to the audio track of a stream (AnalyserNode). */
export function createLevelMeter(stream: MediaStream, ctx: AudioContext = new AudioContext()): LevelMeter {
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  return {
    read() {
      analyser.getFloatTimeDomainData(buf);
      return levelDb(buf);
    },
    dispose() {
      source.disconnect();
      void ctx.close();
    },
  };
}
