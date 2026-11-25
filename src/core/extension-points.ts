/**
 * Extension points: the shape of the features that plug into the session without changing it.
 * The scene compositor is implemented (`sources/compositor.ts`); audio mixing is partly (`audio/mixer.ts`).
 */

/** Audio mixing (several microphones, music, return feed): sits between the sources and the transport. */
export interface AudioMixer {
  /** Combines audio streams into a single track sent to the transport. */
  mix(inputs: MediaStream[]): MediaStream;
  dispose(): void;
}

/** Scenes (web source and shared screen over the camera): produces the final video stream. */
export interface SceneCompositor {
  readonly sceneId: string;
  compose(inputs: MediaStream[]): MediaStream;
  dispose(): void;
}

// Screen sharing: a `MediaSourceStrategy` with id "screen" (`sources/screen.ts`), registered in `SourceRegistry`.
// SRT transport: a `Transport` of `kind` "srt", provided to `BroadcastSession` by its `TransportFactory`.
