import type { MediaSourceStrategy, SourceOptions, SourceSync } from "./types";

/**
 * One `MediaSourceStrategy` in front of several: the options say which one is wanted (`sourceKind`). The session and
 * the keeper keep a single source object; switching source (settings, schedule, manual live) releases the previous one.
 */
export class RoutingSource implements MediaSourceStrategy {
  readonly id = "routing";
  private current: string | null = null;
  private readonly endedListeners = new Set<() => void>();
  private readonly softEndedListeners = new Set<() => void>();
  private offEnded: (() => void) | null = null;

  /**
   * `recoverable`: kinds whose loss must not fail the live (a shared screen the user stops sharing, a window that
   * closes). `onRecoverableEnded` tells the UI so it can go back to the camera; `onEnded` stays for the other sources.
   */
  constructor(
    private readonly sources: Record<string, MediaSourceStrategy>,
    private readonly fallback: string,
    private readonly recoverable: ReadonlySet<string> = new Set(),
  ) {}

  /** Synchronization controls of a source (the webcam's, whatever the current choice: it is the one asked for). */
  syncOf(kind: string): SourceSync | undefined {
    return this.sources[kind]?.sync;
  }

  /** Sound of the current source's share (the shared screen's), null when it has none. */
  systemAudio(): MediaStream | null {
    return this.current ? (this.sources[this.current]?.systemAudio?.() ?? null) : null;
  }

  private pick(o: SourceOptions): string {
    const k = o.sourceKind ?? this.fallback;
    return k in this.sources ? k : this.fallback;
  }

  async acquire(options: SourceOptions): Promise<MediaStream> {
    const kind = this.pick(options);
    if (this.current && this.current !== kind) this.release();
    const source = this.sources[kind]!;
    if (this.current !== kind) {
      this.offEnded?.();
      const listeners = this.recoverable.has(kind) ? this.softEndedListeners : this.endedListeners;
      this.offEnded = source.onEnded(() => [...listeners].forEach((cb) => cb()));
      this.current = kind;
    }
    return source.acquire(options);
  }

  release(): void {
    if (!this.current) return;
    this.sources[this.current]?.release();
    this.offEnded?.();
    this.offEnded = null;
    this.current = null;
  }

  onEnded(cb: () => void): () => void {
    this.endedListeners.add(cb);
    return () => this.endedListeners.delete(cb);
  }

  onRecoverableEnded(cb: () => void): () => void {
    this.softEndedListeners.add(cb);
    return () => this.softEndedListeners.delete(cb);
  }
}
