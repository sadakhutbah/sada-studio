/**
 * Planned extension points, deliberately not implemented in this version.
 * They fix the shape these features will take so the session does not have to change.
 */

/** Audio mixing (several microphones, music, return feed): sits between the sources and the transport. */
export interface AudioMixer {
  /** Combines audio streams into a single track sent to the transport. */
  mix(inputs: MediaStream[]): MediaStream;
  dispose(): void;
}

/** Scenes (framing, banner, several sources): produces the final video stream. */
export interface SceneCompositor {
  readonly sceneId: string;
  compose(inputs: MediaStream[]): MediaStream;
  dispose(): void;
}

// Screen sharing: a `MediaSourceStrategy` with id "screen", to register in `SourceRegistry`.
// SRT transport: a `Transport` of `kind` "srt", provided to `BroadcastSession` by its `TransportFactory`.
