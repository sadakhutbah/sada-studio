/** Attente croissante bornée : base, 2×base, 4×base… jusqu'à `max`, avec une légère dispersion pour que les boîtiers ne frappent pas ensemble. */
export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Part aléatoire ajoutée, de 0 à 1 (0,2 = jusqu'à +20 %). */
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
