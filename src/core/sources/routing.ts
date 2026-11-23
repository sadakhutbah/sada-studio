import type { MediaSourceStrategy, SourceOptions } from "./types";

/**
 * One `MediaSourceStrategy` in front of several: the options say which one is wanted (`sourceKind`). The session and
 * the keeper keep a single source object; switching source (settings, schedule, manual live) releases the previous one.
 */
export class RoutingSource implements MediaSourceStrategy {
  readonly id = "routing";
  private current: string | null = null;
  private readonly endedListeners = new Set<() => void>();
  private offEnded: (() => void) | null = null;

  constructor(
    private readonly sources: Record<string, MediaSourceStrategy>,
    private readonly fallback: string,
  ) {}

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
      this.offEnded = source.onEnded(() => this.endedListeners.forEach((cb) => cb()));
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
}
