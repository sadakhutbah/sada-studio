/** Bounded growing delay: base, 2×base, 4×base… up to `max`, with slight jitter so devices do not all hit at once. */
export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Random share added, from 0 to 1 (0.2 = up to +20%). */
  jitter?: number;
  random?: () => number;
}

export function backoffDelay(attempt: number, o: BackoffOptions): number {
  const raw = Math.min(o.maxMs, o.baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = o.jitter ?? 0;
  return Math.round(Math.min(o.maxMs, raw * (1 + jitter * (o.random ?? Math.random)())));
}

export class Backoff {
  private attempt = 0;
  constructor(private readonly options: BackoffOptions) {}

  next(): number {
    this.attempt++;
    return backoffDelay(this.attempt, this.options);
  }

  reset(): void {
    this.attempt = 0;
  }

  get attempts(): number {
    return this.attempt;
  }
}
