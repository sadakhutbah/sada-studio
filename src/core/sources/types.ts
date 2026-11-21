/** Réglages audio : les traitements automatiques sont coupés par défaut (voix de l'imam, musique des récitations). */
export interface AudioSettings {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export const DEFAULT_AUDIO: AudioSettings = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

export interface SourceOptions {
  videoDeviceId?: string;
  audioDeviceId?: string;
  audio: AudioSettings;
  /** Dimensions et cadence demandées (idéales, le matériel arbitre). */
  video?: { width: number; height: number; frameRate: number };
}

/**
 * Stratégie de source : d'où viennent les pistes à diffuser (caméra aujourd'hui ; écran, scène
 * composée, mixage audio plus tard). `acquire` rend le même flux tant que les options ne changent
 * pas : l'aperçu et la diffusion partagent donc la même capture. Le propriétaire appelle `release`.
 */
export interface MediaSourceStrategy {
  readonly id: string;
  acquire(options: SourceOptions): Promise<MediaStream>;
  release(): void;
  /** Notifie la perte de la source (caméra débranchée). Renvoie la fonction de désabonnement. */
  onEnded(cb: () => void): () => void;
}
