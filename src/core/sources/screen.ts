import { t } from "../messages";
import type { MediaSourceStrategy, SourceOptions } from "./types";

/** What the screen source needs from `navigator.mediaDevices`. `getDisplayMedia` is absent in some embedders. */
export type ScreenMediaDevices = Pick<MediaDevices, "getUserMedia"> & Partial<Pick<MediaDevices, "getDisplayMedia">>;

interface DesktopVideoConstraints {
  mandatory: {
    chromeMediaSource: "desktop";
    chromeMediaSourceId: string;
    maxWidth: number;
    maxHeight: number;
    maxFrameRate: number;
  };
}

function optionsKey(o: SourceOptions): string {
  return JSON.stringify({
    sourceId: o.screen?.sourceId ?? "",
    includeMic: o.screen?.includeMic !== false,
    systemAudio: o.screen?.systemAudio === true,
    audioDeviceId: o.audioDeviceId ?? "",
    audio: o.audio,
    video: o.video,
  });
}

/**
 * Screen / window capture strategy. The source is chosen by the operator in the UI; before capturing, `select` tells the
 * main process which one (it answers `getDisplayMedia` through `setDisplayMediaRequestHandler`, so the page never picks
 * a screen by itself). Falls back to the legacy desktop constraint with the same source id when `getDisplayMedia`
 * refuses (it wants a user gesture, which an automatic restart does not have).
 * Registered in SourceRegistry under id "screen". Optionally mixes the local microphone so the speaker stays audible.
 */
export class ScreenSource implements MediaSourceStrategy {
  readonly id = "screen";
  private stream: MediaStream | null = null;
  private ownedStreams: MediaStream[] = [];
  private system: MediaStream | null = null;
  private key: string | null = null;
  private listeners = new Set<() => void>();
  private readonly mediaDevices: ScreenMediaDevices | null;

  constructor(
    mediaDevices?: ScreenMediaDevices,
    private readonly select?: (sourceId: string) => Promise<void>,
  ) {
    this.mediaDevices = mediaDevices ?? null;
  }

  async acquire(options: SourceOptions): Promise<MediaStream> {
    const sourceId = options.screen?.sourceId?.trim();
    if (!sourceId) {
      throw new Error(t("screen.noSource"));
    }

    const k = optionsKey(options);
    if (this.stream && this.key === k && this.isAlive(this.stream)) {
      return this.stream;
    }

    this.release();

    const devices = this.mediaDevices ?? navigator.mediaDevices;
    const videoConstraint: DesktopVideoConstraints = {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
        maxWidth: options.video?.width ?? 1920,
        maxHeight: options.video?.height ?? 1080,
        maxFrameRate: options.video?.frameRate ?? 30,
      },
    };

    const screenStream = await this.captureScreen(devices, sourceId, videoConstraint, options);
    this.ownedStreams.push(screenStream);

    const tracks: MediaStreamTrack[] = [...screenStream.getVideoTracks()];
    // The loopback sound (when asked and given) is kept apart: the mix sets its volume, it is never sent as is.
    const loopback = screenStream.getAudioTracks();
    this.system = loopback.length > 0 && typeof MediaStream === "function" ? new MediaStream(loopback) : null;

    if (options.screen?.includeMic !== false) {
      try {
        const micStream = await devices.getUserMedia({
          video: false,
          audio: {
            ...(options.audioDeviceId ? { deviceId: { exact: options.audioDeviceId } } : {}),
            echoCancellation: options.audio.echoCancellation,
            noiseSuppression: options.audio.noiseSuppression,
            autoGainControl: options.audio.autoGainControl,
          },
        });
        this.ownedStreams.push(micStream);
        tracks.push(...micStream.getAudioTracks());
      } catch {
        // Continue with video-only screen share if microphone capture is unavailable.
      }
    }

    const combined = typeof MediaStream === "function" ? new MediaStream(tracks) : screenStream;
    for (const track of screenStream.getVideoTracks()) {
      track.addEventListener("ended", () => this.notifyEnded());
    }

    this.stream = combined;
    this.key = k;
    return combined;
  }

  private async captureScreen(
    devices: ScreenMediaDevices,
    sourceId: string,
    legacy: DesktopVideoConstraints,
    options: SourceOptions,
  ): Promise<MediaStream> {
    await this.select?.(sourceId);
    if (devices.getDisplayMedia) {
      try {
        return await devices.getDisplayMedia({
          audio: options.screen?.systemAudio === true,
          video: {
            width: { max: options.video?.width ?? 1920 },
            height: { max: options.video?.height ?? 1080 },
            frameRate: { max: options.video?.frameRate ?? 30 },
          },
        });
      } catch {
        // Falls through to the source id the operator picked.
      }
    }
    try {
      return await devices.getUserMedia({ audio: false, video: legacy as unknown as MediaTrackConstraints });
    } catch (e) {
      throw new Error(e instanceof Error && e.message ? e.message : t("screen.failed"), { cause: e });
    }
  }

  release(): void {
    for (const s of this.ownedStreams) {
      for (const track of s.getTracks()) {
        track.stop();
      }
    }
    this.ownedStreams = [];
    this.system = null;
    this.stream = null;
    this.key = null;
  }

  systemAudio(): MediaStream | null {
    return this.system;
  }

  onEnded(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private isAlive(stream: MediaStream): boolean {
    const video = stream.getVideoTracks();
    return video.length > 0 && video.every((t) => t.readyState === "live");
  }

  private notifyEnded(): void {
    for (const cb of this.listeners) cb();
  }
}
