/** Bitrate (kbit/s) between two readings of the sent-bytes counter. */
export class BitrateEstimator {
  private last: { bytes: number; at: number } | null = null;

  /** Returns the bitrate since the previous reading, or 0 on the first reading / if the counter restarts from zero. */
  sample(bytesSent: number, at: number): number {
    const prev = this.last;
    this.last = { bytes: bytesSent, at };
    if (!prev || at <= prev.at || bytesSent < prev.bytes) return 0;
    return Math.round(((bytesSent - prev.bytes) * 8) / (at - prev.at));
  }

  reset() {
    this.last = null;
  }
}

/** "1:02:03" or "02:03". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatBitrate(kbps: number): string {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1).replace(".", ",")} Mbit/s` : `${kbps} kbit/s`;
}
