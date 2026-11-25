import type { MediaSourceStrategy, SourceOptions } from "./types";

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
    audioDeviceId: o.audioDeviceId ?? "",
    audio: o.audio,
    video: o.video,
  });
}

/**
 * Screen / window capture strategy backed by Electron's desktopCapturer source ids.
 * Registered in SourceRegistry under id "screen" (see src/core/extension-points.ts).
 * Optionally mixes the configured local microphone so the speaker remains audible.
 */
export class ScreenSource implements MediaSourceStrategy {
  readonly id = "screen";
  private stream: MediaStream | null = null;
  private ownedStreams: MediaStream[] = [];
  private key: string | null = null;
  private listeners = new Set<() => void>();
  private readonly mediaDevices: Pick<MediaDevices, "getUserMedia"> | null;

  constructor(mediaDevices?: Pick<MediaDevices, "getUserMedia">) {
    this.mediaDevices = mediaDevices ?? null;
  }

  async acquire(options: SourceOptions): Promise<MediaStream> {
    const sourceId = options.screen?.sourceId?.trim();
    if (!sourceId) {
      throw new Error("Aucune source d'écran ou de fenêtre sélectionnée.");
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

    const screenStream = await devices.getUserMedia({
      audio: false,
      video: videoConstraint as unknown as MediaTrackConstraints,
    });
    this.ownedStreams.push(screenStream);

    const tracks: MediaStreamTrack[] = [...screenStream.getVideoTracks()];

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

  release(): void {
    for (const s of this.ownedStreams) {
      for (const track of s.getTracks()) {
        track.stop();
      }
    }
    this.ownedStreams = [];
    this.stream = null;
    this.key = null;
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
