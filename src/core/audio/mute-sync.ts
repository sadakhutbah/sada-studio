import { backoffDelay } from "../kiosk/backoff";
import type { InputAudioMixer } from "./mixer";

/** How long one attempt to tell the server may take. */
export const MUTE_PUSH_TIMEOUT_MS = 5_000;
/**
 * How long the main process waits for the window to answer a shortcut or an API action. It must outlast one server
 * attempt (`MUTE_PUSH_TIMEOUT_MS`), or the real error is replaced by a bare "timeout".
 */
export const CONTROL_TIMEOUT_MS = 15_000;

const RETRY_ATTEMPTS = 8;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;

export interface MuteOutcome {
  /** The change happened here but the server was not told yet: retries go on in the background. */
  warning: Error | null;
}

/** What the screen shows about the microphone. Plain data (it is copied into the Redux store). */
export interface MuteSyncState {
  /** The local microphone, the only truth for what goes on air from this computer. */
  muted: boolean;
  /** The server is being told (first attempt or retries). */
  pending: boolean;
  /** The server holds the same value as here (as far as this side knows). */
  synced: boolean;
  /** Why the server could not be told (detail of the last failure), null when nothing went wrong. */
  warning: string | null;
}

export interface MuteSyncOptions {
  /** Waits between retries; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Delay before retry `n` (1-based). */
  delay?: (attempt: number) => number;
  attempts?: number;
}

const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));
/** The `rev` of a server answer (contract: every command answers with the full state and its `rev`). */
const revOf = (r: unknown): number | null =>
  r && typeof r === "object" && typeof (r as { rev?: unknown }).rev === "number" ? (r as { rev: number }).rev : null;

/**
 * Local microphone mute with a best-effort mirror on the server.
 *
 * - Muting AND restoring apply here at once: the server is never waited for, so the button never goes back.
 * - The server is told in the background, with retries and a growing delay. While it cannot be told, a non-blocking
 *   warning is kept ("not synchronised"); it clears as soon as an attempt succeeds.
 * - The last write wins: a newer request cancels the retries of the previous one.
 * - A value changed on the server by someone else (web Régie) is applied here through `remote()`, but only when its
 *   `rev` is newer than our own last write and no local write is still waiting for the server.
 */
export class MuteSync {
  private generation = 0;
  private pending = false;
  private synced = true;
  private warning: string | null = null;
  /** `rev` of the server state our last successful write produced (null: unknown). */
  private writeRev: number | null = null;
  /** Highest `rev` seen from the server for the mute (writes and `remote()`). */
  private seenRev: number | null = null;
  private readonly listeners = new Set<(s: MuteSyncState) => void>();

  constructor(
    private readonly mixer: InputAudioMixer,
    private readonly push: (muted: boolean) => Promise<unknown>,
    private readonly options: MuteSyncOptions = {},
  ) {
    mixer.subscribe(() => this.emit());
  }

  state(): MuteSyncState {
    return { muted: this.mixer.isMuted(), pending: this.pending, synced: this.synced, warning: this.warning };
  }

  subscribe(cb: (s: MuteSyncState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  toggle(): Promise<MuteOutcome> {
    return this.set(!this.mixer.isMuted());
  }

  /** Applies at once, then tells the server. Resolves after the first attempt (retries go on in the background). */
  async set(muted: boolean): Promise<MuteOutcome> {
    const mine = ++this.generation;
    this.pending = true;
    this.synced = false;
    this.mixer.setMuted(muted); // emits
    try {
      await this.attempt(mine, muted);
      return { warning: null };
    } catch (e) {
      const err = asError(e);
      if (mine === this.generation) {
        this.warning = err.message;
        this.emit();
        void this.retry(mine, muted);
      }
      return { warning: err };
    }
  }

  /**
   * The server's value, as read by a poll. Applied here only when it comes from a change newer than our last write
   * (strictly greater `rev`) and nothing of ours is still on its way: a stale poll never undoes a local click.
   * Without a `rev` (old server) the local value is kept. Returns whether the local microphone changed.
   */
  remote(muted: boolean | undefined, rev: number | undefined | null): boolean {
    if (typeof muted !== "boolean" || typeof rev !== "number") return false;
    // Our write did not reach the server yet: it is the last one and will win.
    if (this.pending) return false;
    if (!this.synced) {
      // Retries given up, but the server holds our value anyway (told by another way, or it was already there).
      if (muted === this.mixer.isMuted()) {
        this.synced = true;
        this.warning = null;
        this.seenRev = Math.max(this.seenRev ?? rev, rev);
        this.emit();
      }
      return false;
    }
    if (this.seenRev !== null && rev <= this.seenRev) return false;
    if (this.writeRev !== null && rev <= this.writeRev) return false;
    this.seenRev = rev;
    if (muted === this.mixer.isMuted()) return false;
    this.generation++; // nothing of ours is pending, but keep the "last one wins" order
    this.mixer.setMuted(muted);
    return true;
  }

  private async attempt(mine: number, muted: boolean): Promise<void> {
    const answer = await this.push(muted);
    if (mine !== this.generation) return; // a newer request owns the state now
    const rev = revOf(answer);
    if (rev !== null) {
      this.writeRev = rev;
      this.seenRev = Math.max(this.seenRev ?? rev, rev);
    }
    this.pending = false;
    this.synced = true;
    this.warning = null;
    this.emit();
  }

  private async retry(mine: number, muted: boolean): Promise<void> {
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const delay = this.options.delay ?? ((n: number) => backoffDelay(n, { baseMs: RETRY_BASE_MS, maxMs: RETRY_MAX_MS, jitter: 0.2 }));
    const attempts = this.options.attempts ?? RETRY_ATTEMPTS;
    for (let n = 1; n <= attempts; n++) {
      await sleep(delay(n));
      if (mine !== this.generation) return;
      try {
        await this.attempt(mine, muted);
        return;
      } catch (e) {
        if (mine !== this.generation) return;
        this.warning = asError(e).message;
        this.emit();
      }
    }
    // Given up: the local value holds, the warning stays until the next change.
    if (mine === this.generation) {
      this.pending = false;
      this.emit();
    }
  }

  private emit(): void {
    const s = this.state();
    for (const cb of this.listeners) cb(s);
  }
}
