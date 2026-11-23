import type { HealthCheck } from "../api/types";
import { Backoff } from "../kiosk/backoff";
import { t } from "../messages";
import { CaptureMachine, isProlongedOutage, type CaptureState } from "./machine";
import { normalizeDelay, type AudioOffsetStore, type CaptureSourceStrategy, type IpCameraConfig } from "./types";

/** A running ffmpeg. Lines are the `-progress` key=value lines (stdout) and the warnings (stderr). */
export interface RunningProcess {
  onLine(cb: (line: string, stream: "out" | "err") => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(): void;
}

/** Process boundary (node:child_process in production, a fake in tests). */
export type ProcessSpawner = (args: string[]) => RunningProcess;

export interface CaptureControllerOptions {
  source: CaptureSourceStrategy;
  spawn: ProcessSpawner;
  getConfig: () => IpCameraConfig;
  offsets: AudioOffsetStore;
  /** Called when a prolonged outage starts (`down: true`) and when the media flows again (`down: false`). */
  onAlert?: (a: { down: boolean; message: string }) => void;
  now?: () => number;
  /** Outage length that warns the operator. Default 2 min. */
  outageAlertMs?: number;
  /** No progress for this long while running = frozen stream, process is restarted. Default 10 s. */
  stallMs?: number;
  /** Time a new process may take to produce its first frame. Default 20 s. */
  startTimeoutMs?: number;
  /** Time of continuous flow after which the retry backoff starts over. Default 30 s. */
  stableMs?: number;
  watchdogMs?: number;
  backoff?: Backoff;
}

/** Key under which an audio device's calibrated delay is stored. */
export const deviceKey = (c: Pick<IpCameraConfig, "audioBackend" | "audioDevice">) => `${c.audioBackend}:${c.audioDevice}`;

/**
 * Drives the ffmpeg capture of a source strategy: start, watchdog, automatic reconnection with backoff,
 * operator alert on a prolonged outage. The audio delay is read from the per-device store at *every* (re)start,
 * so a reconnection keeps the calibration.
 */
export class CaptureController {
  readonly machine = new CaptureMachine();
  private proc: RunningProcess | null = null;
  private lastProgressAt = 0;
  private flowingSince = 0;
  private lastFrame = 0;
  private stopWaiters: Array<() => void> = [];
  private restartRequested = false;
  private alerted = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private errTail: string[] = [];

  private readonly now: () => number;
  private readonly backoff: Backoff;
  private readonly o: Required<Pick<CaptureControllerOptions, "outageAlertMs" | "stallMs" | "startTimeoutMs" | "stableMs" | "watchdogMs">>;

  constructor(private readonly opts: CaptureControllerOptions) {
    this.now = opts.now ?? Date.now;
    this.backoff = opts.backoff ?? new Backoff({ baseMs: 1_000, maxMs: 15_000, jitter: 0.2 });
    this.o = {
      outageAlertMs: opts.outageAlertMs ?? 120_000,
      stallMs: opts.stallMs ?? 10_000,
      startTimeoutMs: opts.startTimeoutMs ?? 20_000,
      stableMs: opts.stableMs ?? 30_000,
      watchdogMs: opts.watchdogMs ?? 2_000,
    };
  }

  get state(): CaptureState {
    return this.machine.state;
  }

  /** Delay currently applied to the audio of the configured device. */
  get audioDelayMs(): number {
    return this.opts.offsets.get(deviceKey(this.opts.getConfig())) ?? 0;
  }

  start(): void {
    if (this.machine.state.status !== "idle") return;
    this.machine.send({ type: "START", at: this.now() });
    this.backoff.reset();
    this.watchdog = setInterval(() => this.tick(), this.o.watchdogMs);
    this.launch();
  }

  /** Resolves once the process is gone (so that an output file is complete). */
  stop(): Promise<void> {
    if (this.machine.state.status === "idle") return Promise.resolve();
    return new Promise((resolve) => {
      this.stopWaiters.push(resolve);
      if (this.machine.state.status === "stopping") return;
      clearTimeout(this.retryTimer);
      this.machine.send({ type: "STOP" });
      const p = this.proc;
      if (p) p.kill();
      else this.finishStop();
    });
  }

  /** Saves the delay for the configured device (console edit or calibration) and applies it without losing the capture. */
  setAudioDelay(ms: number): number {
    const d = normalizeDelay(ms);
    this.opts.offsets.set(deviceKey(this.opts.getConfig()), d);
    this.restart();
    return d;
  }

  /** Restarts the process right away (new configuration, new delay); not counted as a failure. */
  restart(): void {
    const s = this.machine.state.status;
    if (s === "idle" || s === "stopping") return;
    if (this.proc) {
      this.restartRequested = true;
      this.proc.kill();
    } else if (s === "reconnecting") {
      clearTimeout(this.retryTimer);
      this.machine.send({ type: "RETRY" });
      this.launch();
    }
  }

  /** Sanity check entry for the heartbeat (the server e-mails the operators when `ok` is false). */
  healthCheck(): HealthCheck {
    const s = this.machine.state;
    if (this.alerted) return { id: "capture", ok: false, detail: t("capture.outage", { reason: s.lastError ?? "?" }) };
    return { id: "capture", ok: true, detail: s.status === "running" ? t("capture.running") : t("capture.notRunning") };
  }

  // ───── internals ─────

  private launch(): void {
    const config = this.opts.getConfig();
    const args = this.opts.source.buildCaptureArgs(config, this.audioDelayMs);
    this.errTail = [];
    this.lastFrame = 0;
    this.lastProgressAt = this.now();
    this.flowingSince = 0;
    let p: RunningProcess;
    try {
      p = this.opts.spawn(args);
    } catch (e) {
      this.proc = null;
      this.onExit(null, e instanceof Error ? e.message : String(e));
      return;
    }
    this.proc = p;
    p.onLine((line, stream) => (stream === "out" ? this.onProgress(line) : this.keepErr(line)));
    p.onExit((code) => {
      if (this.proc !== p) return;
      this.proc = null;
      this.onExit(code, this.errTail.at(-1) ?? "");
    });
  }

  private keepErr(line: string): void {
    if (!line.trim()) return;
    this.errTail.push(line.trim());
    if (this.errTail.length > 5) this.errTail.shift();
  }

  private onProgress(line: string): void {
    // The video frame counter is the liveness signal: audio alone keeps the output clock running when the camera is dead.
    const m = /^frame=(\d+)$/.exec(line.trim());
    if (!m) return;
    const frame = Number(m[1]);
    if (frame <= this.lastFrame) return;
    this.lastFrame = frame;
    this.lastProgressAt = this.now();
    if (this.machine.state.status === "starting") {
      this.flowingSince = this.now();
      this.machine.send({ type: "FLOWING", at: this.now() });
      this.clearAlert();
    }
  }

  private onExit(code: number | null, detail: string): void {
    const status = this.machine.state.status;
    if (status === "stopping") return this.finishStop();
    if (this.restartRequested) {
      this.restartRequested = false;
      this.launch();
      return;
    }
    const reason = detail || t("capture.exited", { code: code ?? "?" });
    this.machine.send({ type: "EXITED", at: this.now(), reason });
    this.checkAlert();
    this.retryTimer = setTimeout(() => {
      if (this.machine.state.status !== "reconnecting") return;
      this.machine.send({ type: "RETRY" });
      this.launch();
    }, this.backoff.next());
  }

  private finishStop(): void {
    this.proc = null;
    clearInterval(this.watchdog);
    clearTimeout(this.retryTimer);
    this.machine.send({ type: "STOPPED" });
    this.clearAlert();
    for (const w of this.stopWaiters.splice(0)) w();
  }

  private tick(): void {
    const now = this.now();
    const s = this.machine.state;
    if (this.proc) {
      const limit = s.status === "running" ? this.o.stallMs : this.o.startTimeoutMs;
      if (now - this.lastProgressAt > limit && s.status !== "stopping") {
        this.keepErr(t("capture.stalled"));
        this.proc.kill();
      } else if (s.status === "running" && this.flowingSince && now - this.flowingSince >= this.o.stableMs) {
        this.backoff.reset();
      }
    }
    this.checkAlert();
  }

  private checkAlert(): void {
    const s = this.machine.state;
    if (!this.alerted && isProlongedOutage(s, this.now(), this.o.outageAlertMs)) {
      this.alerted = true;
      this.opts.onAlert?.({ down: true, message: t("capture.outage", { reason: s.lastError ?? "?" }) });
    }
  }

  private clearAlert(): void {
    if (!this.alerted) return;
    this.alerted = false;
    this.opts.onAlert?.({ down: false, message: t("capture.restored") });
  }
}
