import { describe, expect, it, vi } from "vitest";
import { evaluateUpdateWindow, UpdateGate, type UpdateContext } from "../src/core/kiosk/update-gate";

const MIN = 60_000;
const calm: UpdateContext = { sessionActive: false, wantLive: false, nextSlotAt: null, slotRunning: false };

describe("fenêtre de mise à jour", () => {
  it("refuse pendant un direct, un ordre live, un créneau en cours, ou dans la marge avant un créneau", () => {
    expect(evaluateUpdateWindow({ ...calm, sessionActive: true }, 0).allowed).toBe(false);
    expect(evaluateUpdateWindow({ ...calm, wantLive: true }, 0).allowed).toBe(false);
    expect(evaluateUpdateWindow({ ...calm, slotRunning: true }, 0).allowed).toBe(false);
    expect(evaluateUpdateWindow({ ...calm, nextSlotAt: 29 * MIN }, 0).allowed).toBe(false);
    expect(evaluateUpdateWindow({ ...calm, nextSlotAt: 31 * MIN }, 0).allowed).toBe(true);
    expect(evaluateUpdateWindow(calm, 0).allowed).toBe(true);
  });
});

describe("UpdateGate : report pendant un direct", () => {
  it("n'installe rien tant que le direct dure, puis installe dès que la voie est libre", () => {
    vi.useFakeTimers();
    let ctx: UpdateContext = { ...calm, sessionActive: true, wantLive: true };
    const install = vi.fn();
    const gate = new UpdateGate({ context: () => ctx, install, checkEveryMs: 60_000, now: () => Date.now() });
    gate.onDownloaded("0.2.0");
    expect(install).not.toHaveBeenCalled();
    expect(gate.status).toMatchObject({ version: "0.2.0", waiting: expect.stringContaining("direct") });
    vi.advanceTimersByTime(10 * MIN);
    expect(install).not.toHaveBeenCalled();
    // le direct se termine, mais un créneau commence dans 20 minutes : toujours pas
    ctx = { ...calm, nextSlotAt: Date.now() + 20 * MIN };
    vi.advanceTimersByTime(MIN);
    expect(install).not.toHaveBeenCalled();
    // le créneau suivant est loin : installation, une seule fois
    ctx = { ...calm, nextSlotAt: Date.now() + 5 * 3600 * MIN };
    vi.advanceTimersByTime(MIN);
    vi.advanceTimersByTime(10 * MIN);
    expect(install).toHaveBeenCalledTimes(1);
    gate.dispose();
    vi.useRealTimers();
  });

  it("installe tout de suite quand la fenêtre est déjà ouverte", () => {
    const install = vi.fn();
    const gate = new UpdateGate({ context: () => calm, install });
    gate.onDownloaded("0.2.0");
    expect(install).toHaveBeenCalledTimes(1);
    gate.dispose();
  });
});
