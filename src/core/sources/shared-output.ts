import { t } from "../messages";
import type { MediaSourceStrategy } from "./types";

/** What the shared output follows: the composited source the screen already holds (`CompositedSource`). */
export interface SharedOutputTarget {
  onEnded(cb: () => void): () => void;
  onStreamChange?(cb: (s: MediaStream) => void): () => void;
}

/**
 * The picture the screen already shows, sent a second time: the web control room's preview.
 *
 * It never opens nor closes the capture itself (the camera and the routing sources release and re-open their devices
 * on `acquire`, two owners would fight over them): the screen tells it the current stream (`setCurrent`), and it
 * follows the composited source's switches (raw <-> canvas) like the live does.
 */
export class SharedOutputSource implements MediaSourceStrategy {
  readonly id = "shared-output";
  private current: MediaStream | null = null;

  constructor(private readonly target: SharedOutputTarget) {}

  /** The stream the screen holds now (null: no capture). */
  setCurrent(stream: MediaStream | null): void {
    this.current = stream;
  }

  async acquire(): Promise<MediaStream> {
    if (!this.current) throw new Error(t("preview.noPicture"));
    return this.current;
  }

  /** The capture belongs to the screen: nothing to give back. */
  release(): void {}

  onEnded(cb: () => void): () => void {
    return this.target.onEnded(cb);
  }

  onStreamChange(cb: (s: MediaStream) => void): () => void {
    return this.target.onStreamChange?.(cb) ?? (() => undefined);
  }
}
