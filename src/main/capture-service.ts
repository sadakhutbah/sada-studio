import { execFile } from "node:child_process";
import type { HealthCheck } from "../core/api/types";
import { calibrateClap } from "../core/capture/calibrator";
import { CaptureController, deviceKey, type ProcessSpawner } from "../core/capture/controller";
import { IpCameraLocalAudioSource, defaultAudioBackend } from "../core/capture/ip-camera-source";
import { Mp4Splitter, type Mp4Chunk } from "../core/capture/mp4-boxes";
import {
  INITIAL_CAPTURE_VIEW,
  isComplete,
  parseSettings,
  redactUrl,
  toIpCameraConfig,
  type CalibrationView,
  type CaptureSettings,
  type CaptureView,
} from "../core/capture/settings";
import { AUDIO_DELAY_STEP_MS, normalizeDelay, type AudioBackend, type AudioOffsetStore } from "../core/capture/types";
import { t } from "../core/messages";
import type { FileCaptureSettingsStore } from "./capture-files";
import { listAudioDevices, nodeCalibrationIo, spawnFfmpeg } from "./ffmpeg-io";

export interface CaptureServiceDeps {
  settings: FileCaptureSettingsStore;
  offsets: AudioOffsetStore;
  ffmpegPath: string;
  /** Test seam; defaults to the real ffmpeg. */
  spawn?: ProcessSpawner;
  audioBackend?: AudioBackend;
  /** Called with the new view on every change. */
  onView: (v: CaptureView) => void;
  /** Media units for the player (renderer). */
  onMedia: (c: Mp4Chunk) => void;
  log: (line: string) => void;
}

/** A change of the delay is applied after the operator stops clicking: each restart costs a few seconds of picture. */
const DELAY_APPLY_MS = 800;
/** Length of the clap calibration run, seconds (the first 2 s are discarded as unreliable). */
export const CALIBRATION_SECONDS = 10;

/**
 * Main-process side of the "IP camera + local microphone" source: settings and delays on disk, the ffmpeg capture
 * controller, the clap calibration, the sound card list, the media forwarded to the UI and the health check.
 */
export class CaptureService {
  readonly controller: CaptureController;
  private settings: CaptureSettings;
  private readonly backend: AudioBackend;
  private readonly source = new IpCameraLocalAudioSource();
  private calibration: CalibrationView = { status: "idle" };
  private alert = false;
  private ffmpegOk = true;
  private lastInit: Mp4Chunk | null = null;
  private delayTimer: ReturnType<typeof setTimeout> | undefined;
  private devices: string[] = [];

  constructor(private readonly deps: CaptureServiceDeps) {
    this.settings = deps.settings.load();
    this.backend = deps.audioBackend ?? defaultAudioBackend();
    const raw = deps.spawn ?? spawnFfmpeg(deps.ffmpegPath);
    const spawn: ProcessSpawner = (args) => {
      const p = raw(args);
      const splitter = new Mp4Splitter();
      p.onData?.((bytes) => {
        try {
          for (const c of splitter.push(bytes)) {
            if (c.init) this.lastInit = c;
            deps.onMedia(c);
          }
        } catch (e) {
          deps.log(`Capture: invalid media stream (${e instanceof Error ? e.message : e}), restarting.`);
          p.kill();
        }
      });
      return p;
    };
    this.controller = new CaptureController({
      source: this.source,
      spawn,
      getConfig: () => this.config(),
      offsets: deps.offsets,
      onAlert: (a) => {
        this.alert = a.down;
        deps.log(`Capture: ${a.message}`);
        this.publish();
      },
    });
    this.controller.machine.subscribe(() => this.publish());
  }

  private config() {
    return toIpCameraConfig(this.settings, this.backend);
  }

  /** Checks that ffmpeg runs, and reads the sound card list. */
  async init(): Promise<void> {
    this.ffmpegOk = await new Promise<boolean>((resolve) =>
      execFile(this.deps.ffmpegPath, ["-version"], { windowsHide: true, timeout: 10_000 }, (e) => resolve(!e)),
    );
    if (!this.ffmpegOk) this.deps.log(`ffmpeg not found (${this.deps.ffmpegPath}).`);
    await this.refreshDevices();
  }

  async refreshDevices(): Promise<string[]> {
    this.devices = this.ffmpegOk ? await listAudioDevices(this.backend, this.deps.ffmpegPath) : [];
    this.publish();
    return this.devices;
  }

  get audioDevices(): string[] {
    return this.devices;
  }

  get view(): CaptureView {
    const s = this.controller.state;
    return {
      ...INITIAL_CAPTURE_VIEW,
      settings: this.settings,
      rtspUrlShown: redactUrl(this.settings.rtspUrl),
      state: { status: s.status, attempt: s.attempt, lastError: s.lastError ? redactUrl(s.lastError) : null },
      alert: this.alert,
      delayMs: this.delay(),
      calibration: this.calibration,
      ffmpeg: this.ffmpegOk ? "ok" : "missing",
    };
  }

  private delay(): number {
    return this.deps.offsets.get(deviceKey(this.config())) ?? 0;
  }

  private publish(): void {
    this.deps.onView(this.view);
  }

  // ───── commands (IPC) ─────

  setSettings(raw: unknown): CaptureView {
    const next = parseSettings(raw);
    if (!next) throw new Error(t("capture.invalidConfig"));
    const prev = this.settings;
    this.settings = next;
    this.deps.settings.save(next);
    const changed = prev.rtspUrl !== next.rtspUrl || prev.audioDevice !== next.audioDevice;
    if (next.sourceKind !== "ip-camera") void this.release();
    else if (changed) {
      if (isComplete(next)) this.controller.restart();
      else void this.release();
    }
    this.publish();
    return this.view;
  }

  /** The UI wants the capture (preview, arming or live). Idempotent: a second UI gets the current init segment again. */
  async acquire(): Promise<void> {
    if (!this.ffmpegOk) throw new Error(t("capture.ffmpegMissing"));
    if (!isComplete(this.settings)) throw new Error(t("capture.invalidConfig"));
    if (this.calibration.status === "running") throw new Error(t("capture.calibrating"));
    if (this.controller.state.status === "idle") this.controller.start();
    else if (this.lastInit && this.controller.state.status === "running") this.deps.onMedia(this.lastInit);
  }

  async release(): Promise<void> {
    clearTimeout(this.delayTimer);
    await this.controller.stop();
    this.lastInit = null;
  }

  /** Delay in ms (rounded to the 50 ms step) saved for the selected sound card; applied once the operator pauses. */
  setDelay(ms: number): CaptureView {
    const d = normalizeDelay(ms);
    this.deps.offsets.set(deviceKey(this.config()), d);
    clearTimeout(this.delayTimer);
    this.delayTimer = setTimeout(() => this.controller.restart(), DELAY_APPLY_MS);
    this.publish();
    return this.view;
  }

  stepDelay(direction: 1 | -1): CaptureView {
    return this.setDelay(this.delay() + direction * AUDIO_DELAY_STEP_MS);
  }

  /** Clap calibration: the capture is stopped (the sound card and the camera are opened by the calibration run), then resumed. */
  async calibrate(): Promise<CalibrationView> {
    if (!isComplete(this.settings)) throw new Error(t("capture.invalidConfig"));
    if (!this.ffmpegOk) throw new Error(t("capture.ffmpegMissing"));
    if (this.calibration.status === "running") throw new Error(t("capture.calibrating"));
    const wasRunning = this.controller.state.status !== "idle";
    this.calibration = { status: "running", seconds: CALIBRATION_SECONDS };
    this.publish();
    try {
      await this.controller.stop();
      const result = await calibrateClap(this.source, this.config(), nodeCalibrationIo(this.deps.ffmpegPath), CALIBRATION_SECONDS);
      if (result.ok) this.deps.offsets.set(deviceKey(this.config()), result.delayMs);
      this.calibration = { status: "done", result, at: Date.now() };
    } catch (e) {
      this.calibration = { status: "done", result: { ok: false, reason: "ffmpeg", detail: e instanceof Error ? e.message : String(e) }, at: Date.now() };
    }
    if (wasRunning) this.controller.start();
    this.publish();
    return this.calibration;
  }

  /** Entry for the heartbeat; `null` when this source is not the chosen one (no noise in the server's reports). */
  healthChecks(): HealthCheck[] {
    return this.settings.sourceKind === "ip-camera" ? [this.controller.healthCheck()] : [];
  }

  async dispose(): Promise<void> {
    await this.release();
  }
}
