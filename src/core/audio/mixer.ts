import type { AudioMixer } from "../extension-points";

export type MuteListener = (muted: boolean) => void;

/**
 * Incoming audio mixer implementing the `AudioMixer` extension point.
 * Manages real-time mute on the active incoming MediaStream audio tracks
 * without tearing down video or WebRTC transport.
 */
export class InputAudioMixer implements AudioMixer {
  private muted = false;
  private tracks = new Set<MediaStreamTrack>();
  private readonly listeners = new Set<MuteListener>();

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): boolean {
    const next = Boolean(muted);
    this.muted = next;
    for (const track of this.tracks) {
      track.enabled = !next;
    }
    for (const cb of this.listeners) cb(this.muted);
    return this.muted;
  }

  toggleMute(): boolean {
    return this.setMuted(!this.muted);
  }

  subscribe(cb: MuteListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  mix(inputs: MediaStream[]): MediaStream {
    this.tracks.clear();
    const primary = inputs[0];
    if (!primary) {
      throw new Error("No input MediaStream provided to AudioMixer");
    }
    for (const stream of inputs) {
      for (const track of stream.getAudioTracks()) {
        track.enabled = !this.muted;
        this.tracks.add(track);
      }
    }
    if (inputs.length === 1 || typeof MediaStream === "undefined") {
      return primary;
    }
    const out = new MediaStream([...primary.getVideoTracks(), ...this.tracks]);
    return out;
  }

  dispose(): void {
    this.tracks.clear();
    this.listeners.clear();
  }
}
