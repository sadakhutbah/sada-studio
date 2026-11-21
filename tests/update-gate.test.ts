import { describe, expect, it, vi } from "vitest";
import { evaluateUpdateWindow, UpdateGate, type UpdateContext } from "../src/core/kiosk/update-gate";

const MIN = 60_000;
const calm: UpdateContext = { sessionActive: false, wantLive: false, nextSlotAt: null, slotRunning: false };

describe("update window", () => {
  it("refuses during a live, a live order, a running slot, or within the margin before a slot", () => {
    expect(evaluateUpdateWindow({ ...calm, sessionActive: true }, 0).allowed).toBe(false);
    expect(evaluateUpdateWindow({ ...calm, wantLive: true }, 0).allowed).toBe(false);
    expect(evaluateUpdateWindow({ ...calm, slotRunning: true }, 0).allowed).toBe(false);
    expect(evaluateUpdateWindow({ ...calm, nextSlotAt: 29 * MIN }, 0).allowed).toBe(false);
    expect(evaluateUpdateWindow({ ...calm, nextSlotAt: 31 * MIN }, 0).allowed).toBe(true);
    expect(evaluateUpdateWindow(calm, 0).allowed).toBe(true);
  });
});

describe("UpdateGate: deferral during a live", () => {
  it("installs nothing while the live lasts, then installs as soon as the way is clear", () => {
    vi.useFakeTimers();
    let ctx: UpdateContext = { ...calm, sessionActive: true, wantLive: true };
    const install = vi.fn();
    const gate = new UpdateGate({ context: () => ctx, install, checkEveryMs: 60_000, now: () => Date.now() });
    gate.onDownloaded("0.2.0");
    expect(install).not.toHaveBeenCalled();
    expect(gate.status).toMatchObject({ version: "0.2.0", waiting: expect.stringContaining("live") });
    vi.advanceTimersByTime(10 * MIN);
    expect(install).not.toHaveBeenCalled();
    // the live ends, but a slot starts in 20 minutes: still no
    ctx = { ...calm, nextSlotAt: Date.now() + 20 * MIN };
    vi.advanceTimersByTime(MIN);
    expect(install).not.toHaveBeenCalled();
    // the next slot is far away: install, only once
    ctx = { ...calm, nextSlotAt: Date.now() + 5 * 3600 * MIN };
    vi.advanceTimersByTime(MIN);
    vi.advanceTimersByTime(10 * MIN);
    expect(install).toHaveBeenCalledTimes(1);
    gate.dispose();
    vi.useRealTimers();
  });

  it("installs immediately when the window is already open", () => {
    const install = vi.fn();
    const gate = new UpdateGate({ context: () => calm, install });
    gate.onDownloaded("0.2.0");
    expect(install).toHaveBeenCalledTimes(1);
    gate.dispose();
  });
});
