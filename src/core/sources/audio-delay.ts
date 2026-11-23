import { AUDIO_DELAY_MAX_MS, normalizeDelay } from "../capture/types";

/**
 * Delays the microphone of a webcam stream (Web Audio `DelayNode` between the microphone and the track handed to
 * WHIP). The delay changes live, without restarting the capture. `analyser` listens BEFORE the delay: calibration
 * measures the raw gap, whatever delay is currently applied.
 */
export class AudioDelay {
  /** Video tracks of the input + the delayed audio track (the input itself when it has no audio). */
  readonly output: MediaStream;
  /** Microphone as captured, before the delay. */
  readonly analyser: AnalyserNode | null = null;
  private readonly node: DelayNode | null = null;
  private delayMs = 0;

  constructor(
    private readonly input: MediaStream,
    delayMs: number,
    private readonly ctx: AudioContext = new AudioContext({ latencyHint: "interactive" }),
  ) {
    if (input.getAudioTracks().length === 0) {
      this.output = input;
      return;
    }
    const source = ctx.createMediaStreamSource(new MediaStream(input.getAudioTracks()));
    this.node = ctx.createDelay(AUDIO_DELAY_MAX_MS / 1000);
    const dest = ctx.createMediaStreamDestination();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    source.connect(this.analyser);
    source.connect(this.node);
    this.node.connect(dest);
    this.output = new MediaStream([...input.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    this.setDelayMs(delayMs);
    void ctx.resume().catch(() => undefined);
  }

  get currentMs(): number {
    return this.delayMs;
  }

  setDelayMs(ms: number): void {
    this.delayMs = normalizeDelay(ms);
    if (this.node) this.node.delayTime.value = this.delayMs / 1000;
  }

  /** Latency announced by the microphone track, seconds (0 when unknown). */
  get inputLatencyS(): number {
    const l = (this.input.getAudioTracks()[0]?.getSettings() as { latency?: number } | undefined)?.latency;
    return typeof l === "number" && Number.isFinite(l) ? l : 0;
  }

  close(): void {
    void this.ctx.close().catch(() => undefined);
  }
}
