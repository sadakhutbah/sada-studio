export interface TransportStats {
  /** Octets média envoyés depuis l'ouverture (cumulé). */
  bytesSent: number;
  /** Aller-retour en ms, quand le transport sait le mesurer. */
  rttMs?: number;
  /** Cadence vidéo réellement envoyée. */
  fps?: number;
}

export interface ConnectOptions {
  /** Plafond du débit vidéo, en kbit/s. */
  maxVideoKbps?: number;
}

/**
 * Stratégie de transport : comment les pistes partent vers Sada (WHIP aujourd'hui, SRT plus tard).
 * Une instance sert à une connexion ; la session en crée une nouvelle à chaque reconnexion.
 */
export interface Transport {
  readonly kind: string;
  connect(stream: MediaStream, options?: ConnectOptions): Promise<void>;
  /** Appelé au plus une fois quand le transport perd la liaison après avoir été connecté. */
  onLost(cb: (reason: string) => void): void;
  getStats(): Promise<TransportStats>;
  close(): Promise<void>;
}

export type TransportFactory = () => Transport;
