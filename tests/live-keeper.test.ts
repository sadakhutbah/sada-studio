import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveKeeper, type KeeperSession } from "../src/core/kiosk/live-keeper";
import { INITIAL_STATE, type SessionState } from "../src/core/session/machine";

/** Session factice : on pilote son état à la main. */
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

  it("démarre quand l'ordre est live, arrête quand il ne l'est plus", async () => {
    const { session, set } = fakeSession();
    const k = new LiveKeeper(session, opts);
    k.setWanted(true);
    expect(session.starts).toBe(1);
    set({ status: "live" });
    k.setWanted(false);
    expect(session.stops).toBe(1);
  });

  it("n'émet jamais sans ordre : une session à l'arrêt reste à l'arrêt", () => {
    const { session } = fakeSession();
    new LiveKeeper(session, opts);
    expect(session.starts).toBe(0);
  });

  it("caméra absente : réessaie avec une attente croissante bornée", async () => {
    const { session, set } = fakeSession();
    const k = new LiveKeeper(session, opts);
    k.setWanted(true);
    const waits: number[] = [];
    k.onRetry((r) => r && waits.push(r.waitMs));
    for (let i = 0; i < 6; i++) {
      set({ status: "error", error: "Caméra introuvable.", errorCode: "capture" });
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
    expect(session.starts).toBe(7);
  });

  it("409 : très patient, jamais agressif, et affiche l'attente", async () => {
    const { session, set } = fakeSession();
    const k = new LiveKeeper(session, opts);
    k.setWanted(true);
    const waits: number[] = [];
    k.onRetry((r) => r && waits.push(r.waitMs));
    set({ status: "error", error: "Un direct est déjà en cours depuis 12:05.", errorCode: "conflict" });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(session.starts).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(session.starts).toBe(2);
    set({ status: "error", errorCode: "conflict" });
    set({ status: "error", errorCode: "conflict" });
    expect(waits).toEqual([60_000, 120_000]);
  });

  it("l'ordre idle annule la nouvelle tentative en attente et remet la session à zéro", async () => {
    const { session, set } = fakeSession();
    const k = new LiveKeeper(session, opts);
    k.setWanted(true);
    set({ status: "error", error: "x", errorCode: null });
    k.setWanted(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.starts).toBe(1);
    expect(session.snapshot.state.status).toBe("idle");
  });

  it("un direct réussi remet l'attente à zéro", async () => {
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
