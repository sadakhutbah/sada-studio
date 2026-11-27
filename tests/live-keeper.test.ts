import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_KEEPER_OPTIONS, LiveKeeper, PREVIEW_KEEPER_OPTIONS, type KeeperSession } from "../src/core/kiosk/live-keeper";
import { INITIAL_STATE, type SessionState } from "../src/core/session/machine";

/** Fake session: its state is driven by hand. */
function fakeSession() {
  let state: SessionState = INITIAL_STATE;
  const listeners = new Set<() => void>();
  const set = (s: Partial<SessionState>) => {
    state = { ...state, ...s };
    listeners.forEach((l) => l());
  };
  const session: KeeperSession & { starts: number; stops: number } = {
    starts: 0,
    stops: 0,
    get snapshot() {
      return { state };
    },
    subscribe: (fn) => {
      const l = () => fn({ state });
      listeners.add(l);
      return () => listeners.delete(l);
    },
    start: async () => {
      session.starts++;
      set({ status: "connecting" });
    },
    stop: async () => {
      session.stops++;
      set({ ...INITIAL_STATE });
    },
  };
  return { session, set };
}

const opts = { retry: { baseMs: 1000, maxMs: 8000 }, conflictRetry: { baseMs: 60_000, maxMs: 300_000 } };

describe("LiveKeeper", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts when the order is live, stops when it no longer is", async () => {
    const { session, set } = fakeSession();
    const k = new LiveKeeper(session, opts);
    k.setWanted(true);
    expect(session.starts).toBe(1);
    set({ status: "live" });
    k.setWanted(false);
    expect(session.stops).toBe(1);
  });

  it("never broadcasts without an order: a stopped session stays stopped", () => {
    const { session } = fakeSession();
    new LiveKeeper(session, opts);
    expect(session.starts).toBe(0);
  });

  it("camera missing: retries with bounded growing delays", async () => {
    const { session, set } = fakeSession();
    const k = new LiveKeeper(session, opts);
    k.setWanted(true);
    const waits: number[] = [];
    k.onRetry((r) => r && waits.push(r.waitMs));
    for (let i = 0; i < 6; i++) {
      set({ status: "error", error: "Camera not found.", errorCode: "capture" });
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
    expect(session.starts).toBe(7);
  });

  it("409: very patient, never aggressive, and shows the wait", async () => {
    const { session, set } = fakeSession();
    const k = new LiveKeeper(session, opts);
    k.setWanted(true);
    const waits: number[] = [];
    k.onRetry((r) => r && waits.push(r.waitMs));
    set({ status: "error", error: "A live is already running since 12:05.", errorCode: "conflict" });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(session.starts).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(session.starts).toBe(2);
    set({ status: "error", errorCode: "conflict" });
    set({ status: "error", errorCode: "conflict" });
    expect(waits).toEqual([60_000, 120_000]);
  });

  it("preview: a 409 backs off like any failure (5 to 60 s), not like a live conflict", async () => {
    const { session, set } = fakeSession();
    vi.spyOn(Math, "random").mockReturnValue(0); // no jitter
    const k = new LiveKeeper(session, PREVIEW_KEEPER_OPTIONS);
    k.setWanted(true);
    const waits: number[] = [];
    k.onRetry((r) => r && waits.push(r.waitMs));
    for (let i = 0; i < 6; i++) {
      set({ status: "error", error: "conflict", errorCode: "conflict" });
      await vi.advanceTimersByTimeAsync(61_000);
    }
    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    expect(session.starts).toBe(7);
  });

  it("the preview keeper options use the short backoff for a conflict, the live ones the patient one", () => {
    expect(PREVIEW_KEEPER_OPTIONS.conflictRetry).toEqual(PREVIEW_KEEPER_OPTIONS.retry);
    expect(PREVIEW_KEEPER_OPTIONS.conflictRetry.baseMs).toBeLessThanOrEqual(5_000);
    expect(DEFAULT_KEEPER_OPTIONS.conflictRetry.baseMs).toBe(60_000);
  });

  it("the idle order cancels the pending retry and resets the session", async () => {
    const { session, set } = fakeSession();
    const k = new LiveKeeper(session, opts);
    k.setWanted(true);
    set({ status: "error", error: "x", errorCode: null });
    k.setWanted(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.starts).toBe(1);
    expect(session.snapshot.state.status).toBe("idle");
  });

  it("a successful live resets the wait", async () => {
    const { session, set } = fakeSession();
    const k = new LiveKeeper(session, opts);
    k.setWanted(true);
    const waits: number[] = [];
    k.onRetry((r) => r && waits.push(r.waitMs));
    set({ status: "error", error: "x" });
    await vi.advanceTimersByTimeAsync(1500);
    set({ status: "live" });
    set({ status: "error", error: "y" });
    expect(waits).toEqual([1000, 1000]);
  });
});
