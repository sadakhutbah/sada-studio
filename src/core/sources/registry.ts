import type { MediaSourceStrategy } from "./types";

export type SourceFactory = () => MediaSourceStrategy;

/**
 * Registre des sources. Point d'extension : le partage d'écran (« screen ») s'y enregistrera avec
 * sa propre stratégie, sans toucher à la session ni au transport.
 */
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
