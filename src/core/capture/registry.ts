import type { CaptureSourceStrategy } from "./types";

export type CaptureSourceFactory = () => CaptureSourceStrategy;

/** Registry of ffmpeg-driven capture sources (same pattern as `SourceRegistry`). */
export class CaptureSourceRegistry {
  private readonly factories = new Map<string, CaptureSourceFactory>();

  register(id: string, factory: CaptureSourceFactory): this {
    this.factories.set(id, factory);
    return this;
  }

  create(id: string): CaptureSourceStrategy {
    const f = this.factories.get(id);
    if (!f) throw new Error(`Source inconnue : ${id}`);
    return f();
  }

  ids(): string[] {
    return [...this.factories.keys()];
  }
}
