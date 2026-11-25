export interface TransportStats {
  /** Media bytes sent since opening (cumulative). */
  bytesSent: number;
  /** Round-trip time in ms, when the transport can measure it. */
  rttMs?: number;
  /** Video frame rate actually sent. */
  fps?: number;
}

export interface ConnectOptions {
  /** Video bitrate ceiling, in kbit/s. */
  maxVideoKbps?: number;
}

/**
 * Transport strategy: how the tracks reach Sada (WHIP today, SRT later).
 * One instance serves one connection; the session creates a new one on each reconnection.
 */
export interface Transport {
  readonly kind: string;
  connect(stream: MediaStream, options?: ConnectOptions): Promise<void>;
  /** Called at most once when the transport loses the link after having been connected. */
  onLost(cb: (reason: string) => void): void;
  getStats(): Promise<TransportStats>;
  /** Sends the tracks of `stream` instead of the current ones, on the same connection (no renegotiation). */
  replaceTracks?(stream: MediaStream): Promise<void>;
  close(): Promise<void>;
}

export type TransportFactory = () => Transport;
