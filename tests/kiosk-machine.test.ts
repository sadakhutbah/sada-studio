import { describe, expect, it } from "vitest";
import type { CurrentLive, HeartbeatReply, Slot } from "../src/core/api/types";
import { DEFAULT_KIOSK_OPTIONS, INITIAL_KIOSK, kioskTransition, pairedState, type KioskEvent, type KioskState } from "../src/core/kiosk/machine";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 27, 10, 0, 0);
const run = (events: KioskEvent[], from: KioskState = INITIAL_KIOSK) => events.reduce((s, e) => kioskTransition(s, e), from);
const slot = (over: Partial<Slot> = {}): Slot => ({ id: "s1", type: "khutba", title: "Khutba du vendredi", startsAt: T0 + 120 * MIN, endsAt: T0 + 165 * MIN, ...over });
const reply = (over: Partial<HeartbeatReply> = {}): HeartbeatReply => ({ config: {}, schedule: [], command: "idle", current: null, ...over });
const beat = (r: HeartbeatReply, at = T0): KioskEvent => ({ type: "HEARTBEAT_OK", reply: r, at });
const scheduled = (over: Partial<CurrentLive> = {}): CurrentLive => ({ type: "khutba", title: "Khutba du vendredi", source: "schedule", slotId: "s1", ...over });
const paired = () => pairedState({ name: "Alpha Mosque" }, "https://x");

describe("pairing", () => {
  it("unpaired → pairing → standby, and a renewed code stays in pairing", () => {
    const p = run([{ type: "PAIRING_STARTED", baseUrl: "https://x", userCode: "AAAA", expiresAt: T0 + 600_000 }]);
    expect(p).toMatchObject({ phase: "pairing", pairing: { userCode: "AAAA" } });
    const renewed = kioskTransition(p, { type: "PAIRING_STARTED", baseUrl: "https://x", userCode: "BBBB", expiresAt: T0 + 1_200_000 });
    expect(renewed.pairing?.userCode).toBe("BBBB");
    const done = kioskTransition(renewed, { type: "PAIRED", mosque: { name: "Alpha Mosque" }, at: T0 });
    expect(done).toMatchObject({ phase: "standby", pairing: null, mosque: { name: "Alpha Mosque" }, wantLive: false });
  });

  it("a denied pairing returns to the initial screen with an explanation", () => {
    const s = run([
      { type: "PAIRING_STARTED", baseUrl: "https://x", userCode: "A", expiresAt: 1 },
      { type: "PAIRING_FAILED", code: "pair-denied", message: "Denied." },
    ]);
    expect(s).toMatchObject({ phase: "unpaired", notice: { code: "pair-denied" }, baseUrl: "https://x" });
  });

  it("revoked: nothing is broadcast, the explanation stays, re-pairing is possible", () => {
    const live = run([beat(reply({ command: "live", current: scheduled() }))], paired());
    expect(live.wantLive).toBe(true);
    const r = kioskTransition(live, { type: "REVOKED", message: "Device removed." });
    expect(r).toMatchObject({ phase: "revoked", wantLive: false, mosque: null, notice: { code: "revoked" } });
    expect(kioskTransition(r, { type: "PAIRING_STARTED", baseUrl: "https://x", userCode: "C", expiresAt: 1 }).phase).toBe("pairing");
  });

  it("unpairing returns to unpaired without an error explanation", () => {
    expect(kioskTransition(paired(), { type: "UNPAIR" })).toMatchObject({ phase: "unpaired", notice: null, mosque: null });
  });
});

describe("server control", () => {
  it("live order → onair; idle order → standby", () => {
    const on = run([beat(reply({ command: "live", current: scheduled() }))], paired());
    expect(on).toMatchObject({ phase: "onair", wantLive: true, live: { source: "schedule" } });
    const off = kioskTransition(on, beat(reply()));
    expect(off).toMatchObject({ phase: "standby", wantLive: false, live: null });
  });

  it("arming within the margin before the slot, back to standby if it moves away", () => {
    const far = run([beat(reply({ schedule: [slot()] }))], paired());
    expect(far).toMatchObject({ phase: "standby", nextSlot: { id: "s1" } });
    const near = kioskTransition(far, { type: "TICK", at: T0 + 115 * MIN });
    expect(near.phase).toBe("armed");
    expect(near.wantLive).toBe(false);
    const gone = kioskTransition(near, beat(reply({ schedule: [] }), T0 + 116 * MIN));
    expect(gone.phase).toBe("standby");
  });

  it("a failed heartbeat marks offline but keeps the current order", () => {
    const on = run([beat(reply({ command: "live", current: scheduled() })), { type: "HEARTBEAT_FAILED" }], paired());
    expect(on).toMatchObject({ online: false, wantLive: true, phase: "onair" });
    expect(kioskTransition(on, beat(reply({ command: "live", current: scheduled() }))).online).toBe(true);
  });
});

describe("manual live", () => {
  it("MANUAL_STARTED → onair, manual source", () => {
    const s = run([{ type: "MANUAL_STARTED", kind: "dars", title: "Dars du soir", at: T0 }], paired());
    expect(s).toMatchObject({ phase: "onair", wantLive: true, live: { source: "manual", title: "Dars du soir", type: "dars" } });
  });

  it("a scheduled slot never cuts a running manual live", () => {
    let s = run([{ type: "MANUAL_STARTED", kind: "dars", title: "Dars du soir", at: T0 }], paired());
    // the khutba slot arrives: the server announces live / schedule
    s = kioskTransition(s, beat(reply({ schedule: [slot()], command: "live", current: scheduled() }), T0 + 125 * MIN));
    expect(s).toMatchObject({ phase: "onair", wantLive: true, manual: { title: "Dars du soir" }, live: { source: "manual", title: "Dars du soir" } });
  });

  it("the server's idle order ends the manual live, only after the grace delay", () => {
    let s = run([{ type: "MANUAL_STARTED", kind: "dars", title: "D", at: T0 }], paired());
    s = kioskTransition(s, beat(reply(), T0 + 5_000));
    expect(s.wantLive).toBe(true);
    s = kioskTransition(s, beat(reply(), T0 + DEFAULT_KIOSK_OPTIONS.manualGraceMs + 1));
    expect(s).toMatchObject({ wantLive: false, manual: null, phase: "standby" });
  });

  it("a manual stop during a slot does not restart before the next slot", () => {
    const sched = [slot(), slot({ id: "s2", title: "Khutba suivante", startsAt: T0 + 7 * 24 * 60 * MIN, endsAt: T0 + 7 * 24 * 60 * MIN + 45 * MIN })];
    const running = reply({ schedule: sched, command: "live", current: scheduled() });
    let s = kioskTransition(paired(), beat(running, T0 + 130 * MIN));
    expect(s.wantLive).toBe(true);
    s = kioskTransition(s, { type: "STOP_REQUESTED", at: T0 + 131 * MIN });
    expect(s.wantLive).toBe(false);
    // the server repeats live for the same slot (latency): do not restart
    s = kioskTransition(s, beat(running, T0 + 132 * MIN));
    expect(s).toMatchObject({ wantLive: false, phase: "standby", nextSlot: { id: "s2" } });
    // still suppressed while the slot is running
    s = kioskTransition(s, beat(running, T0 + 150 * MIN));
    expect(s.wantLive).toBe(false);
    // the slot is over: the dismissal disappears, the next one will trigger normally
    s = kioskTransition(s, beat(reply({ schedule: sched }), T0 + 170 * MIN));
    expect(s.suppressed).toEqual([]);
    const next = kioskTransition(s, beat(reply({ schedule: sched, command: "live", current: scheduled({ slotId: "s2", title: "Khutba suivante" }) }), T0 + 7 * 24 * 60 * MIN + MIN));
    expect(next.wantLive).toBe(true);
  });

  it("stopping a manual live during a slot also dismisses the running slot", () => {
    let s = run([{ type: "MANUAL_STARTED", kind: "dars", title: "D", at: T0 }], paired());
    s = kioskTransition(s, beat(reply({ schedule: [slot()], command: "live", current: scheduled() }), T0 + 125 * MIN));
    s = kioskTransition(s, { type: "STOP_REQUESTED", at: T0 + 126 * MIN });
    s = kioskTransition(s, beat(reply({ schedule: [slot()], command: "live", current: scheduled() }), T0 + 127 * MIN));
    expect(s.wantLive).toBe(false);
  });

  it("a new manual live lifts the dismissal", () => {
    let s = kioskTransition(paired(), beat(reply({ command: "live", current: scheduled() })));
    s = kioskTransition(s, { type: "STOP_REQUESTED", at: T0 });
    expect(s.suppressed.length).toBeGreaterThan(0);
    s = kioskTransition(s, { type: "MANUAL_STARTED", kind: "khutba", title: "X", at: T0 + 1 });
    expect(s).toMatchObject({ suppressed: [], wantLive: true });
  });

  it("409 on start: the message stays displayed, without a manual live", () => {
    const s = kioskTransition(paired(), { type: "MANUAL_REFUSED", message: "A live is already running since 12:05.", at: T0 });
    expect(s).toMatchObject({ manual: null, wantLive: false, conflict: { message: "A live is already running since 12:05." } });
    expect(kioskTransition(s, { type: "DISMISS_CONFLICT" }).conflict).toBeNull();
  });
});

describe("resume", () => {
  it("a restored state keeps the manual-stop dismissal: no restart on reboot", () => {
    const restored = pairedState({ name: "M" }, "https://x", ["slot:s1"]);
    const s = kioskTransition(restored, beat(reply({ command: "live", current: scheduled(), schedule: [slot()] }), T0 + 130 * MIN));
    expect(s.wantLive).toBe(false);
  });

  it("without dismissal, the server's live order restarts broadcasting at once (the server remains the master)", () => {
    const s = kioskTransition(pairedState({ name: "M" }, "https://x"), beat(reply({ command: "live", current: scheduled() })));
    expect(s.wantLive).toBe(true);
  });
});
