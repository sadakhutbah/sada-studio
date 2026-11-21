import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FatalError } from "../src/core/errors";
import { BroadcastSession } from "../src/core/session/broadcast-session";
import { DEFAULT_AUDIO, type MediaSourceStrategy } from "../src/core/sources/types";
import type { Transport } from "../src/core/transport/types";
import { fakeStream } from "./helpers";

class FakeTransport implements Transport {
  readonly kind = "fake";
  lost: ((r: string) => void) | null = null;
  closed = false;
  bytes = 0;
  constructor(private readonly outcome: "ok" | "fail" | "fatal" = "ok") {}
  async connect() {
    if (this.outcome === "fail") throw new Error("réseau");
    if (this.outcome === "fatal") throw new FatalError("droits");
  }
  onLost(cb: (r: string) => void) {
    this.lost = cb;
  }
  async getStats() {
    return { bytesSent: this.bytes, rttMs: 20 };
  }
  async close() {
    this.closed = true;
  }
}

function setup(outcomes: Array<"ok" | "fail" | "fatal">, maxAttempts = 5) {
  const transports: FakeTransport[] = [];
  const stream = fakeStream();
  let ended: (() => void) | null = null;
  const source: MediaSourceStrategy = {
    id: "fake",
    acquire: vi.fn(async () => stream),
    release: vi.fn(),
    onEnded: (cb) => {
      ended = cb;
      return () => (ended = null);
    },
  };
  const session = new BroadcastSession({
    source,
    transportFactory: () => {
      const t = new FakeTransport(outcomes[Math.min(transports.length, outcomes.length - 1)]);
      transports.push(t);
      return t;
    },
    backoffMs: () => 1000,
    maxAttempts,
    now: () => Date.now(),
  });
  return { session, transports, source, endSource: () => ended?.() };
}
const opts = { audio: DEFAULT_AUDIO };

describe("BroadcastSession", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("passe en direct puis s'arrête proprement sans libérer la source", async () => {
    const { session, transports, source } = setup(["ok"]);
    await session.start(opts);
    expect(session.snapshot.state.status).toBe("live");
    await session.stop();
    expect(session.snapshot.state.status).toBe("idle");
    expect(transports[0].closed).toBe(true);
    expect(source.release).not.toHaveBeenCalled();
  });

  it("une connexion initiale refusée met la session en erreur", async () => {
    const { session } = setup(["fail"]);
    await session.start(opts);
    expect(session.snapshot.state).toMatchObject({ status: "error", error: "réseau" });
    await session.stop();
    expect(session.snapshot.state.status).toBe("idle");
  });

  it("se reconnecte seule après une perte de liaison, avec le même flux", async () => {
    const { session, transports, source } = setup(["ok", "ok"]);
    await session.start(opts);
    const startedAt = session.snapshot.state.startedAt;
    transports[0].lost?.("coupure");
    expect(session.snapshot.state).toMatchObject({ status: "reconnecting", attempt: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.snapshot.state).toMatchObject({ status: "live", attempt: 0, startedAt });
    expect(transports).toHaveLength(2);
    expect(transports[0].closed).toBe(true);
    expect(source.acquire).toHaveBeenCalledTimes(1);
  });

  it("réessaie après un échec, puis abandonne au maximum de tentatives", async () => {
    const { session, transports } = setup(["ok", "fail"], 2);
    await session.start(opts);
    transports[0].lost?.("coupure");
    await vi.advanceTimersByTimeAsync(1000); // essai 1 échoue
    expect(session.snapshot.state).toMatchObject({ status: "reconnecting", attempt: 2 });
    await vi.advanceTimersByTimeAsync(1000); // essai 2 échoue, maximum atteint
    expect(session.snapshot.state.status).toBe("error");
    expect(transports).toHaveLength(3);
  });

  it("une erreur fatale pendant la reconnexion arrête les essais", async () => {
    const { session, transports } = setup(["ok", "fatal"]);
    await session.start(opts);
    transports[0].lost?.("coupure");
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.snapshot.state).toMatchObject({ status: "error", error: "droits" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transports).toHaveLength(2);
  });

  it("arrêter pendant la reconnexion annule le prochain essai", async () => {
    const { session, transports } = setup(["ok", "ok"]);
    await session.start(opts);
    transports[0].lost?.("coupure");
    await session.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transports).toHaveLength(1);
    expect(session.snapshot.state.status).toBe("idle");
  });

  it("la perte de la caméra met fin au direct", async () => {
    const { session, endSource } = setup(["ok"]);
    await session.start(opts);
    endSource();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.snapshot.state.status).toBe("error");
    expect(session.snapshot.state.error).toMatch(/déconnecté/);
  });

  it("mesure le débit à partir des octets envoyés", async () => {
    const { session, transports } = setup(["ok"]);
    await session.start(opts);
    await vi.advanceTimersByTimeAsync(1000); // premier relevé
    transports[0].bytes += 500_000; // 500 ko en 1 s = 4000 kbit/s
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.snapshot.stats).toMatchObject({ bitrateKbps: 4000, rttMs: 20 });
  });
});
