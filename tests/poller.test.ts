import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Poller, WriteFence, backoffDelayMs } from "../src/core/regie/poller";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Poller", () => {
  it("polls on a fixed interval while healthy", async () => {
    const run = vi.fn(async () => undefined);
    const p = new Poller({ run, delayMs: backoffDelayMs(3000, 30000) });
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(2);
    p.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("backs off on errors, reports the failures and recovers", async () => {
    let fail = true;
    const seen: number[] = [];
    const run = vi.fn(async () => {
      if (fail) throw new Error("down");
    });
    const p = new Poller({ run, delayMs: backoffDelayMs(3000, 12000), onFailures: (n) => seen.push(n) });
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1); // t=0, next in 6 s
    await vi.advanceTimersByTimeAsync(5999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2); // next in 12 s (capped)
    await vi.advanceTimersByTimeAsync(12000);
    expect(run).toHaveBeenCalledTimes(3);
    fail = false;
    await vi.advanceTimersByTimeAsync(12000);
    expect(run).toHaveBeenCalledTimes(4);
    expect(seen).toEqual([1, 2, 3, 0]);
    await vi.advanceTimersByTimeAsync(3000); // healthy again: back to the base interval
    expect(run).toHaveBeenCalledTimes(5);
    p.stop();
  });

  it("pauses while hidden and resumes at once on wake()", async () => {
    let hidden = true;
    const run = vi.fn(async () => undefined);
    const p = new Poller({ run, delayMs: () => 3000, isHidden: () => hidden });
    p.start();
    await vi.advanceTimersByTimeAsync(20000);
    expect(run).not.toHaveBeenCalled();
    hidden = false;
    p.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    hidden = true; // hidden during the wait: the next tick does nothing and the loop sleeps
    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it("never runs two polls at once; a wake() during a poll re-polls right after", async () => {
    let release: () => void = () => undefined;
    const run = vi.fn(() => new Promise<void>((r) => (release = r)));
    const p = new Poller({ run, delayMs: () => 3000 });
    p.start();
    p.wake();
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    p.stop();
    release();
  });
});

describe("WriteFence", () => {
  it("drops a poll answer older than a command", () => {
    const f = new WriteFence();
    const early = f.begin();
    f.bump(); // a command is issued while the poll is in flight
    const late = f.begin();
    expect(early()).toBe(false);
    expect(late()).toBe(true);
  });
});
