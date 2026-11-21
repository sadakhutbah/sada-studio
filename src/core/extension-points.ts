/**
 * Points d'extension prévus, volontairement non implémentés dans cette version.
 * Ils fixent la forme que prendront ces fonctions pour que la session n'ait pas à changer.
 */

/** Mixage audio (plusieurs micros, musique, retour) : s'intercale entre les sources et le transport. */
export interface AudioMixer {
  /** Combine des flux audio en une piste unique envoyée au transport. */
  mix(inputs: MediaStream[]): MediaStream;
  dispose(): void;
}

/** Scènes (cadrage, bandeau, plusieurs sources) : produit le flux vidéo final. */
export interface SceneCompositor {
  readonly sceneId: string;
  compose(inputs: MediaStream[]): MediaStream;
  dispose(): void;
}

// Partage d'écran : une `MediaSourceStrategy` d'identifiant « screen », à enregistrer dans `SourceRegistry`.
// Transport SRT : un `Transport` de `kind` « srt », fourni à `BroadcastSession` par sa `TransportFactory`.
