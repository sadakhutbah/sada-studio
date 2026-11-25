import type { MediaSourceStrategy } from "./types";

export type SourceFactory = () => MediaSourceStrategy;

/** Source registry: each source (camera, IP camera, screen) registers its own strategy, without touching the session or the transport. */
export class SourceRegistry {
  private readonly factories = new Map<string, SourceFactory>();

  register(id: string, factory: SourceFactory): this {
    this.factories.set(id, factory);
    return this;
  }

  create(id: string): MediaSourceStrategy {
    const f = this.factories.get(id);
    if (!f) throw new Error(`Source inconnue : ${id}`);
    return f();
  }

  ids(): string[] {
    return [...this.factories.keys()];
  }
}
