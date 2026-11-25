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
  /** The change did not happen (a restore the server did not confirm: the microphone stays muted). */
  error: Error | null;
  /** The change happened here but the server was not told yet: retries go on in the background. */
  warning: Error | null;
}

export interface MuteSyncOptions {
  /** Waits between retries; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Delay before retry `n` (1-based). */
  delay?: (attempt: number) => number;
  attempts?: number;
  /** A background retry finally reached the server. */
  onSynced?: () => void;
}

const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/**
 * Local microphone mute with a best-effort mirror on the server.
 *
 * - Muting is a safety: it always applies here at once, whatever the server does. If the server cannot be told, a
 *   warning is returned (not an error) and the call is retried in the background with a growing delay.
 * - Restoring is the opposite: the microphone only opens once the server confirmed, so a failed restore leaves it muted
 *   (an open microphone nobody asked the server to open is never the failure mode), and the operator retries.
 * - The last request wins: a newer one cancels pending retries and a restore answered after a newer mute is dropped.
 */
export class MuteSync {
  private generation = 0;

  constructor(
    private readonly mixer: InputAudioMixer,
    private readonly push: (muted: boolean) => Promise<unknown>,
    private readonly options: MuteSyncOptions = {},
  ) {}

  toggle(): Promise<MuteOutcome> {
    return this.set(!this.mixer.isMuted());
  }

  async set(muted: boolean): Promise<MuteOutcome> {
    const mine = ++this.generation;
    if (muted) {
      this.mixer.setMuted(true);
      try {
        await this.push(true);
        return { error: null, warning: null };
      } catch (e) {
        if (mine === this.generation) void this.retry(mine);
        return { error: null, warning: asError(e) };
      }
    }
    try {
      await this.push(false);
    } catch (e) {
      return { error: asError(e), warning: null };
    }
    // A mute asked while the restore was in flight wins: the microphone must not open behind it.
    if (mine === this.generation) this.mixer.setMuted(false);
    return { error: null, warning: null };
  }

  private async retry(mine: number): Promise<void> {
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const delay = this.options.delay ?? ((n: number) => backoffDelay(n, { baseMs: RETRY_BASE_MS, maxMs: RETRY_MAX_MS, jitter: 0.2 }));
    for (let n = 1; n <= (this.options.attempts ?? RETRY_ATTEMPTS); n++) {
      await sleep(delay(n));
      if (mine !== this.generation) return;
      try {
        await this.push(true);
        this.options.onSynced?.();
        return;
      } catch {
        /* next attempt */
      }
    }
  }
}
