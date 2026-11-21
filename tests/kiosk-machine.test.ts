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
const paired = () => pairedState({ name: "Mosquée Alpha" }, "https://x");

describe("appairage", () => {
  it("unpaired → pairing → standby, puis le code renouvelé reste en pairing", () => {
    const p = run([{ type: "PAIRING_STARTED", baseUrl: "https://x", userCode: "AAAA", expiresAt: T0 + 600_000 }]);
    expect(p).toMatchObject({ phase: "pairing", pairing: { userCode: "AAAA" } });
    const renewed = kioskTransition(p, { type: "PAIRING_STARTED", baseUrl: "https://x", userCode: "BBBB", expiresAt: T0 + 1_200_000 });
    expect(renewed.pairing?.userCode).toBe("BBBB");
    const done = kioskTransition(renewed, { type: "PAIRED", mosque: { name: "Mosquée Alpha" }, at: T0 });
    expect(done).toMatchObject({ phase: "standby", pairing: null, mosque: { name: "Mosquée Alpha" }, wantLive: false });
  });

  it("un appairage refusé revient à l'écran initial avec une explication", () => {
    const s = run([
      { type: "PAIRING_STARTED", baseUrl: "https://x", userCode: "A", expiresAt: 1 },
      { type: "PAIRING_FAILED", code: "pair-denied", message: "Refusé." },
    ]);
    expect(s).toMatchObject({ phase: "unpaired", notice: { code: "pair-denied" }, baseUrl: "https://x" });
  });

  it("révoqué : plus rien n'est émis, l'explication reste, le réappairage est possible", () => {
    const live = run([beat(reply({ command: "live", current: scheduled() }))], paired());
    expect(live.wantLive).toBe(true);
    const r = kioskTransition(live, { type: "REVOKED", message: "Appareil retiré." });
    expect(r).toMatchObject({ phase: "revoked", wantLive: false, mosque: null, notice: { code: "revoked" } });
    expect(kioskTransition(r, { type: "PAIRING_STARTED", baseUrl: "https://x", userCode: "C", expiresAt: 1 }).phase).toBe("pairing");
  });

  it("désappairer ramène à unpaired sans explication d'erreur", () => {
    expect(kioskTransition(paired(), { type: "UNPAIR" })).toMatchObject({ phase: "unpaired", notice: null, mosque: null });
  });
});

describe("pilotage par le serveur", () => {
  it("ordre live → onair ; ordre idle → standby", () => {
    const on = run([beat(reply({ command: "live", current: scheduled() }))], paired());
    expect(on).toMatchObject({ phase: "onair", wantLive: true, live: { source: "schedule" } });
    const off = kioskTransition(on, beat(reply()));
    expect(off).toMatchObject({ phase: "standby", wantLive: false, live: null });
  });

  it("armement dans la marge avant le créneau, retour en veille s'il s'éloigne", () => {
    const far = run([beat(reply({ schedule: [slot()] }))], paired());
    expect(far).toMatchObject({ phase: "standby", nextSlot: { id: "s1" } });
    const near = kioskTransition(far, { type: "TICK", at: T0 + 115 * MIN });
    expect(near.phase).toBe("armed");
    expect(near.wantLive).toBe(false);
    const gone = kioskTransition(near, beat(reply({ schedule: [] }), T0 + 116 * MIN));
    expect(gone.phase).toBe("standby");
  });

  it("un échec de battement marque hors ligne mais garde l'ordre en cours", () => {
    const on = run([beat(reply({ command: "live", current: scheduled() })), { type: "HEARTBEAT_FAILED" }], paired());
    expect(on).toMatchObject({ online: false, wantLive: true, phase: "onair" });
    expect(kioskTransition(on, beat(reply({ command: "live", current: scheduled() }))).online).toBe(true);
  });
});

describe("direct manuel", () => {
  it("MANUAL_STARTED → onair, source manuelle", () => {
    const s = run([{ type: "MANUAL_STARTED", kind: "dars", title: "Dars du soir", at: T0 }], paired());
    expect(s).toMatchObject({ phase: "onair", wantLive: true, live: { source: "manual", title: "Dars du soir", type: "dars" } });
  });

  it("un créneau planifié ne coupe jamais un direct manuel en cours", () => {
    let s = run([{ type: "MANUAL_STARTED", kind: "dars", title: "Dars du soir", at: T0 }], paired());
    // le créneau de la khutba arrive : le serveur annonce live / schedule
    s = kioskTransition(s, beat(reply({ schedule: [slot()], command: "live", current: scheduled() }), T0 + 125 * MIN));
    expect(s).toMatchObject({ phase: "onair", wantLive: true, manual: { title: "Dars du soir" }, live: { source: "manual", title: "Dars du soir" } });
  });

  it("l'ordre idle du serveur met fin au direct manuel, après le délai de grâce seulement", () => {
    let s = run([{ type: "MANUAL_STARTED", kind: "dars", title: "D", at: T0 }], paired());
    s = kioskTransition(s, beat(reply(), T0 + 5_000));
    expect(s.wantLive).toBe(true);
    s = kioskTransition(s, beat(reply(), T0 + DEFAULT_KIOSK_OPTIONS.manualGraceMs + 1));
    expect(s).toMatchObject({ wantLive: false, manual: null, phase: "standby" });
  });

  it("l'arrêt manuel pendant un créneau ne relance pas avant le créneau suivant", () => {
    const sched = [slot(), slot({ id: "s2", title: "Khutba suivante", startsAt: T0 + 7 * 24 * 60 * MIN, endsAt: T0 + 7 * 24 * 60 * MIN + 45 * MIN })];
    const running = reply({ schedule: sched, command: "live", current: scheduled() });
    let s = kioskTransition(paired(), beat(running, T0 + 130 * MIN));
    expect(s.wantLive).toBe(true);
    s = kioskTransition(s, { type: "STOP_REQUESTED", at: T0 + 131 * MIN });
    expect(s.wantLive).toBe(false);
    // le serveur répète live pour ce même créneau (latence) : on ne relance pas
    s = kioskTransition(s, beat(running, T0 + 132 * MIN));
    expect(s).toMatchObject({ wantLive: false, phase: "standby", nextSlot: { id: "s2" } });
    // toujours supprimé tant que le créneau tourne
    s = kioskTransition(s, beat(running, T0 + 150 * MIN));
    expect(s.wantLive).toBe(false);
    // le créneau est fini : l'écart disparaît, le suivant se déclenchera normalement
    s = kioskTransition(s, beat(reply({ schedule: sched }), T0 + 170 * MIN));
    expect(s.suppressed).toEqual([]);
    const next = kioskTransition(s, beat(reply({ schedule: sched, command: "live", current: scheduled({ slotId: "s2", title: "Khutba suivante" }) }), T0 + 7 * 24 * 60 * MIN + MIN));
    expect(next.wantLive).toBe(true);
  });

  it("arrêter un direct manuel pendant un créneau écarte aussi le créneau en cours", () => {
    let s = run([{ type: "MANUAL_STARTED", kind: "dars", title: "D", at: T0 }], paired());
    s = kioskTransition(s, beat(reply({ schedule: [slot()], command: "live", current: scheduled() }), T0 + 125 * MIN));
    s = kioskTransition(s, { type: "STOP_REQUESTED", at: T0 + 126 * MIN });
    s = kioskTransition(s, beat(reply({ schedule: [slot()], command: "live", current: scheduled() }), T0 + 127 * MIN));
    expect(s.wantLive).toBe(false);
  });

  it("un nouveau direct manuel lève l'écart", () => {
    let s = kioskTransition(paired(), beat(reply({ command: "live", current: scheduled() })));
    s = kioskTransition(s, { type: "STOP_REQUESTED", at: T0 });
    expect(s.suppressed.length).toBeGreaterThan(0);
    s = kioskTransition(s, { type: "MANUAL_STARTED", kind: "khutba", title: "X", at: T0 + 1 });
    expect(s).toMatchObject({ suppressed: [], wantLive: true });
  });

  it("409 au lancement : le message reste affiché, sans direct manuel", () => {
    const s = kioskTransition(paired(), { type: "MANUAL_REFUSED", message: "Un direct est déjà en cours depuis 12:05.", at: T0 });
    expect(s).toMatchObject({ manual: null, wantLive: false, conflict: { message: "Un direct est déjà en cours depuis 12:05." } });
    expect(kioskTransition(s, { type: "DISMISS_CONFLICT" }).conflict).toBeNull();
  });
});

describe("reprise", () => {
  it("un état restauré garde l'écart d'un arrêt manuel : pas de relance au redémarrage", () => {
    const restored = pairedState({ name: "M" }, "https://x", ["slot:s1"]);
    const s = kioskTransition(restored, beat(reply({ command: "live", current: scheduled(), schedule: [slot()] }), T0 + 130 * MIN));
    expect(s.wantLive).toBe(false);
  });

  it("sans écart, l'ordre live du serveur relance l'émission aussitôt (le serveur reste maître)", () => {
    const s = kioskTransition(pairedState({ name: "M" }, "https://x"), beat(reply({ command: "live", current: scheduled() })));
    expect(s.wantLive).toBe(true);
  });
});
