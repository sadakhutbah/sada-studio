/**
 * Cache of the programme's assets (logo, scene pictures, screen descriptions), revalidated by ETag. The last valid
 * value is kept through any failure (network, server, decoding): the programme never turns black because a refresh
 * failed. Pure (fetch and decode injected), so the policy is testable.
 */

/** One revalidation: `changed: false` = 304; `data: null` = the server has none (404). */
export type Revalidation<D> = { changed: false } | { changed: true; etag: string; data: D | null };

export interface AssetCacheOptions<D, T> {
  fetch(key: string, etag: string | null): Promise<Revalidation<D>>;
  decode(data: D, key: string): Promise<T> | T;
  /** Frees a value that has been replaced or dropped (ImageBitmap.close). */
  release?(value: T): void;
  now?(): number;
  /** When a value fetched at `fetchedAt` is to be revalidated (default: just after the next minute). */
  staleAt?(fetchedAt: number): number;
  /** Pause after a failure before the next attempt (default 10 s). */
  retryMs?: number;
  /** A value appeared, changed or went away. */
  onChange?(key: string): void;
}

interface Entry<T> {
  value: T | null;
  etag: string | null;
  fetchedAt: number;
  /** The server answered 404: there is no such asset (as opposed to a failure). */
  missing: boolean;
  failures: number;
  retryAt: number;
  inflight: Promise<void> | null;
}

/** Revalidate 1.5 s after the next minute: the server's ETag changes at the minute (countdowns, times). */
export const nextMinute = (fetchedAt: number) => Math.floor(fetchedAt / 60_000) * 60_000 + 61_500;

export class AssetCache<D, T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly now: () => number;
  private readonly staleAt: (t: number) => number;
  private readonly retryMs: number;

  constructor(private readonly o: AssetCacheOptions<D, T>) {
    this.now = o.now ?? Date.now;
    this.staleAt = o.staleAt ?? nextMinute;
    this.retryMs = o.retryMs ?? 10_000;
  }

  /** The last valid value (null: none yet, or the server has none). */
  get(key: string): T | null {
    return this.entries.get(key)?.value ?? null;
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /** The server said there is no such asset (404), and nothing valid is held. */
  isMissing(key: string): boolean {
    const e = this.entries.get(key);
    return Boolean(e?.missing) && e?.value === null;
  }

  /** Known (fetched successfully at least once, 404 included). */
  settled(key: string): boolean {
    const e = this.entries.get(key);
    return Boolean(e) && (e!.value !== null || e!.missing);
  }

  failures(key: string): number {
    return this.entries.get(key)?.failures ?? 0;
  }

  /** Whether a refresh would hit the network now (stale, never fetched, retry due). */
  due(key: string): boolean {
    const e = this.entries.get(key);
    if (!e) return true;
    if (e.inflight) return false;
    const now = this.now();
    if (e.failures > 0) return now >= e.retryAt;
    return now >= this.staleAt(e.fetchedAt);
  }

  /**
   * Revalidates `key` when it is due (or at once with `force`, still never two calls at a time for one key, and
   * never before the retry pause after a failure).
   */
  refresh(key: string, force = false): Promise<void> {
    let e = this.entries.get(key);
    if (!e) {
      e = { value: null, etag: null, fetchedAt: 0, missing: false, failures: 0, retryAt: 0, inflight: null };
      this.entries.set(key, e);
    }
    if (e.inflight) return e.inflight;
    const now = this.now();
    if (e.failures > 0 && now < e.retryAt) return Promise.resolve();
    if (!force && e.fetchedAt > 0 && now < this.staleAt(e.fetchedAt)) return Promise.resolve();
    const entry = e;
    entry.inflight = this.run(key, entry).finally(() => {
      entry.inflight = null;
    });
    return entry.inflight;
  }

  /** The ETags are no longer valid (other programme: live ↔ rehearsal): values are kept until replaced. */
  forgetValidators(): void {
    for (const e of this.entries.values()) {
      e.etag = null;
      e.fetchedAt = 0;
      e.failures = 0;
      e.retryAt = 0;
    }
  }

  /** Drops the entries not in `keep` (their values are released). */
  retain(keep: ReadonlySet<string>): void {
    for (const [k, e] of this.entries) {
      if (keep.has(k) || e.inflight) continue;
      if (e.value !== null) this.o.release?.(e.value);
      this.entries.delete(k);
    }
  }

  clear(): void {
    for (const e of this.entries.values()) if (e.value !== null) this.o.release?.(e.value);
    this.entries.clear();
  }

  private async run(key: string, e: Entry<T>): Promise<void> {
    try {
      const r = await this.o.fetch(key, e.etag);
      if (this.entries.get(key) !== e) return; // dropped meanwhile
      const now = this.now();
      if (!r.changed) {
        e.fetchedAt = now;
        e.failures = 0;
        return;
      }
      if (r.data === null) {
        const had = e.value;
        e.value = null;
        e.etag = r.etag || null;
        e.missing = true;
        e.fetchedAt = now;
        e.failures = 0;
        if (had !== null) {
          this.o.release?.(had);
          this.o.onChange?.(key);
        }
        return;
      }
      const value = await this.o.decode(r.data, key);
      if (this.entries.get(key) !== e) {
        this.o.release?.(value);
        return;
      }
      const old = e.value;
      e.value = value;
      e.etag = r.etag || null;
      e.missing = false;
      e.fetchedAt = this.now();
      e.failures = 0;
      if (old !== null && old !== value) this.o.release?.(old);
      this.o.onChange?.(key);
    } catch {
      // Network, server or decoding failure: the last valid value stays, the next attempt waits a little.
      e.failures++;
      e.retryAt = this.now() + this.retryMs;
    }
  }
}
