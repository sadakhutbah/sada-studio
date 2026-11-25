export interface PollerOptions {
  /** One poll. A rejection counts as a failure. */
  run: () => Promise<void>;
  /** Delay before the next poll, given the number of consecutive failures (0 after a success). */
  delayMs: (failures: number) => number;
  /** Nothing is polled while the window is hidden; `wake()` resumes at once. */
  isHidden?: () => boolean;
  /** Called whenever the consecutive failure count changes. */
  onFailures?: (failures: number) => void;
}

/** Fixed interval while healthy, doubling (capped) on consecutive failures. */
export function backoffDelayMs(baseMs: number, maxMs: number): (failures: number) => number {
  return (failures) => Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.min(failures, 10)));
}

/**
 * Self-scheduling poll loop: never two polls at once, paused while hidden, backing off on errors.
 * `wake()` polls right away (window shown again, local state changed).
 */
export class Poller {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private again = false;
  private stopped = true;
  private failures = 0;

  constructor(private readonly o: PollerOptions) {}

  get failureCount(): number {
    return this.failures;
  }

  start(): void {
    this.stopped = false;
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  wake(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.running) this.again = true;
    else void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    if (this.o.isHidden?.()) return; // paused: wake() restarts the loop
    this.running = true;
    let ok = true;
    try {
      await this.o.run();
    } catch {
      ok = false;
    }
    this.running = false;
    if (this.stopped) return;
    const next = ok ? 0 : this.failures + 1;
    if (next !== this.failures) {
      this.failures = next;
      this.o.onFailures?.(next);
    }
    if (this.again) {
      this.again = false;
      void this.tick();
      return;
    }
    this.timer = setTimeout(() => void this.tick(), this.o.delayMs(this.failures));
  }
}

/**
 * Guards a poll against the writes that happen while it is in flight: a response is applied only when no command
 * (scene, overlay, transition…) was issued since the poll started, otherwise it would show a state older than the command.
 */
export class WriteFence {
  private seq = 0;
  /** Call when a command is issued. */
  bump(): void {
    this.seq++;
  }
  /** Call when a poll starts; the returned function says whether its answer is still current. */
  begin(): () => boolean {
    const at = this.seq;
    return () => at === this.seq;
  }
}
