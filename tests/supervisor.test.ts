import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeartbeatReply } from "../src/core/api/types";
import { ApiError } from "../src/core/errors";
import { KioskSupervisor, type ClientReport } from "../src/core/kiosk/supervisor";
import { FakeApi, IDLE_REPLY, MOSQUE, MemoryDevices, MemoryPersist, network, revoked } from "./helpers";

const device = { baseUrl: "https://c.example", deviceId: "d1", deviceSecret: "s1", mosque: MOSQUE };
const calmReport: ClientReport = {
  sessionState: "idle",
  camera: true,
  micro: true,
  bitrateKbps: 0,
  checks: [{ id: "camera", ok: true, detail: "ok" }],
  lastError: null,
  startFailure: null,
};
const live: HeartbeatReply = { config: {}, schedule: [], command: "live", current: { type: "khutba", title: "Khutba", source: "schedule", slotId: "s1" } };

function setup(opts: { paired?: boolean; wasLive?: boolean; suppressed?: string[] } = {}) {
  const api = new FakeApi();
  const devices = new MemoryDevices();
  const persist = new MemoryPersist();
  if (opts.paired !== false) devices.saved = device;
  persist.data = { wasLive: opts.wasLive ?? false, suppressed: opts.suppressed ?? [] };
  const sup = new KioskSupervisor(api, devices, persist, { version: "9.9.9", heartbeatMs: 30_000, heartbeatLiveMs: 10_000, minBeatGapMs: 2_000, machineName: "PC-SALLE" });
  return { api, devices, persist, sup };
}
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("KioskSupervisor", () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 10, 27, 10, 0, 0) }));
  afterEach(() => vi.useRealTimers());

  describe("appairage", () => {
    it("affiche un code, attend la console, mémorise l'identité et se met à battre", async () => {
      const { api, sup, devices } = setup({ paired: false });
      sup.boot();
      expect(sup.view.phase).toBe("unpaired");
      await sup.startPairing("https://c.example");
      expect(sup.view).toMatchObject({ phase: "pairing", pairing: { userCode: "CODE-1" } });
      api.pollQueue.push({ status: "paired", deviceId: "d9", deviceSecret: "s9", mosque: MOSQUE });
      await tick(2_100);
      expect(sup.view).toMatchObject({ phase: "standby", mosque: { name: "Mosquée Alpha" } });
      expect(devices.saved).toMatchObject({ deviceId: "d9", baseUrl: "https://c.example" });
      expect(api.device?.deviceSecret).toBe("s9");
      await tick(1);
      expect(api.beats).toHaveLength(1);
      sup.dispose();
    });

    it("renouvelle seul le code expiré", async () => {
      const { api, sup } = setup({ paired: false });
      sup.boot();
      await sup.startPairing("https://c.example");
      await tick(61_000);
      expect(api.starts).toBe(2);
      expect(sup.view.pairing?.userCode).toBe("CODE-2");
      sup.dispose();
    });

    it("un code expiré signalé par le serveur est renouvelé sans attendre", async () => {
      const { api, sup } = setup({ paired: false });
      sup.boot();
      await sup.startPairing("https://c.example");
      api.pollQueue.push({ status: "expired" });
      await tick(2_100);
      expect(sup.view.pairing?.userCode).toBe("CODE-2");
      sup.dispose();
    });

    it("demande refusée : retour à l'écran initial avec explication", async () => {
      const { api, sup } = setup({ paired: false });
      sup.boot();
      await sup.startPairing("https://c.example");
      api.pollQueue.push({ status: "denied" });
      await tick(2_100);
      expect(sup.view).toMatchObject({ phase: "unpaired", notice: { code: "pair-denied" } });
      sup.dispose();
    });

    it("désappairer prévient le serveur, oublie l'identité et arrête le battement", async () => {
      const { api, sup, devices } = setup();
      sup.boot();
      await tick(1);
      await sup.unpair();
      expect(api.unpairs).toBe(1);
      expect(devices.saved).toBeNull();
      expect(api.device).toBeNull();
      expect(sup.view.phase).toBe("unpaired");
      const n = api.beats.length;
      await tick(120_000);
      expect(api.beats).toHaveLength(n);
    });

    it("désappairer oublie l'identité même si le serveur est injoignable", async () => {
      const { api, sup, devices } = setup();
      api.unpairError = network();
      sup.boot();
      await tick(1);
      await sup.unpair();
      expect(devices.saved).toBeNull();
      expect(sup.view.phase).toBe("unpaired");
    });

    it("propose le nom de la machine à la console, au premier code comme au renouvellement", async () => {
      const { api, sup } = setup({ paired: false });
      sup.boot();
      await sup.startPairing("https://c.example");
      await tick(61_000);
      expect(api.machineNames).toEqual(["PC-SALLE", "PC-SALLE"]);
      sup.dispose();
    });

    it("rotation : le nouveau secret est rangé et utilisé tout de suite", async () => {
      const { api, sup, devices } = setup();
      api.reply = { ...IDLE_REPLY, credentials: { deviceId: "d1", deviceSecret: "s2" } };
      sup.boot();
      await tick(1);
      expect(devices.saved).toMatchObject({ deviceId: "d1", deviceSecret: "s2", baseUrl: "https://c.example" });
      expect(api.device?.deviceSecret).toBe("s2");
      sup.dispose();
    });
  });

  describe("boucle de battement (horloge simulée)", () => {
    it("bat tout de suite au démarrage, puis toutes les 30 s en veille et 10 s pendant un direct", async () => {
      const { api, sup } = setup();
      sup.boot();
      await tick(1);
      expect(api.beats).toHaveLength(1);
      expect(api.beats[0]).toMatchObject({ state: "idle", version: "9.9.9" });
      await tick(29_000);
      expect(api.beats).toHaveLength(1);
      await tick(1_500);
      expect(api.beats).toHaveLength(2);
      api.reply = live;
      await tick(30_000);
      expect(sup.view).toMatchObject({ phase: "onair", wantLive: true });
      const n = api.beats.length;
      await tick(30_000);
      expect(api.beats.length - n).toBe(3);
      sup.dispose();
    });

    it("l'ordre live puis idle commande l'émission", async () => {
      const { api, sup } = setup();
      sup.boot();
      api.reply = live;
      await tick(1);
      expect(sup.view.wantLive).toBe(true);
      api.reply = IDLE_REPLY;
      await tick(10_500);
      expect(sup.view.wantLive).toBe(false);
      sup.dispose();
    });

    it("respecte l'intervalle demandé par le serveur (borné)", async () => {
      const { api, sup } = setup();
      api.reply = { ...IDLE_REPLY, config: { heartbeat_interval: 5 } };
      sup.boot();
      await tick(1);
      await tick(5_100);
      expect(api.beats).toHaveLength(2);
      sup.dispose();
    });

    it("serveur injoignable : attente croissante bornée, hors ligne affiché, l'ordre en cours est gardé", async () => {
      const { api, sup } = setup();
      api.reply = live;
      sup.boot();
      await tick(1);
      expect(sup.view.wantLive).toBe(true);
      api.beatError = network();
      await tick(10_500);
      expect(sup.view).toMatchObject({ online: false, wantLive: true });
      const n = api.beats.length;
      await tick(10 * 60_000);
      // 5 s, 10 s, 20 s, 40 s, 80 s, 120 s… : bien moins qu'un battement toutes les 10 s
      expect(api.beats.length - n).toBeLessThan(12);
      expect(api.beats.length - n).toBeGreaterThan(4);
      api.beatError = null;
      await tick(130_000);
      expect(sup.view.online).toBe(true);
      sup.dispose();
    });

    it("401 au battement : appareil révoqué, retour à l'appairage, plus aucun battement", async () => {
      const { api, sup, devices } = setup();
      sup.boot();
      await tick(1);
      api.beatError = revoked();
      await tick(30_500);
      expect(sup.view).toMatchObject({ phase: "revoked", wantLive: false, notice: { code: "revoked" } });
      expect(sup.view.notice?.message).toMatch(/appairez-le de nouveau/);
      expect(devices.saved).toBeNull();
      const n = api.beats.length;
      await tick(120_000);
      expect(api.beats).toHaveLength(n);
    });
  });

  describe("santé et battement immédiat", () => {
    it("joint la santé détaillée : contrôles, network, dernière erreur, échec de démarrage", async () => {
      const { api, sup } = setup();
      sup.boot();
      sup.setReport({
        ...calmReport,
        lastError: { code: "capture", message: "Caméra introuvable." },
        startFailure: "Caméra introuvable.",
      });
      await tick(1);
      expect(api.beats[0].health).toEqual({
        checks: [
          { id: "camera", ok: true, detail: "ok" },
          { id: "network", ok: true, detail: "Serveur Sada joignable." },
        ],
        last_error: { code: "capture", message: "Caméra introuvable." },
        live_start_failure: { message: "Caméra introuvable." },
      });
      sup.dispose();
    });

    it("un contrôle qui change d'état déclenche un battement immédiat (sans attendre 30 s)", async () => {
      const { api, sup } = setup();
      sup.boot();
      sup.setReport(calmReport);
      await tick(5_000);
      const n = api.beats.length;
      sup.setReport({ ...calmReport, camera: false, checks: [{ id: "camera", ok: false, detail: "Aucune caméra détectée." }] });
      await tick(10);
      expect(api.beats.length).toBe(n + 1);
      expect(api.beats.at(-1)!.health.checks[0]).toMatchObject({ id: "camera", ok: false });
      sup.dispose();
    });

    it("un contrôle qui clignote ne harcèle pas le serveur : écart minimal entre deux battements", async () => {
      const { api, sup } = setup();
      sup.boot();
      sup.setReport(calmReport);
      await tick(5_000);
      const n = api.beats.length;
      for (let i = 0; i < 6; i++) {
        sup.setReport({ ...calmReport, checks: [{ id: "camera", ok: i % 2 === 1, detail: "x" }] });
        await tick(100);
      }
      await tick(100);
      expect(api.beats.length - n).toBeLessThanOrEqual(2);
      sup.dispose();
    });

    it("sans changement d'état, aucun battement supplémentaire (le débit seul ne compte pas)", async () => {
      const { api, sup } = setup();
      sup.boot();
      sup.setReport(calmReport);
      await tick(5_000);
      const n = api.beats.length;
      sup.setReport({ ...calmReport, bitrateKbps: 3000 });
      await tick(100);
      expect(api.beats).toHaveLength(n);
      sup.dispose();
    });

    it("une erreur de session fait partir un battement immédiat", async () => {
      const { api, sup } = setup();
      sup.boot();
      sup.setReport(calmReport);
      await tick(5_000);
      const n = api.beats.length;
      sup.setReport({ ...calmReport, sessionState: "error", lastError: { code: "conflict", message: "Un direct est déjà en cours." } });
      await tick(10);
      expect(api.beats.length).toBe(n + 1);
      expect(api.beats.at(-1)!.health.last_error?.code).toBe("conflict");
      sup.dispose();
    });

    it("liaison coupée avec le relais : network passe à faux", async () => {
      const { api, sup } = setup();
      sup.boot();
      sup.setReport({ ...calmReport, sessionState: "reconnecting" });
      await tick(1);
      expect(api.beats[0].health.checks.find((c) => c.id === "network")).toMatchObject({ ok: false });
      sup.dispose();
    });
  });

  describe("direct manuel", () => {
    it("start puis stop : appelle le serveur, le serveur reste maître", async () => {
      const { api, sup } = setup();
      sup.boot();
      await tick(1);
      await sup.startManual({ type: "dars", title: "  Dars du soir " });
      expect(api.startCalls).toEqual([{ type: "dars", title: "Dars du soir" }]);
      expect(sup.view).toMatchObject({ phase: "onair", wantLive: true, live: { source: "manual" } });
      await sup.stopLive();
      expect(api.stopCalls).toBe(1);
      expect(sup.view.wantLive).toBe(false);
      expect(sup.view.stopPending).toBe(false);
      sup.dispose();
    });

    it("409 : affiche « déjà en cours depuis X » et n'émet pas", async () => {
      const { api, sup } = setup();
      sup.boot();
      await tick(1);
      api.startError = new ApiError(409, "Un direct est déjà en cours depuis 12:05.");
      await expect(sup.startManual({ type: "khutba", title: "X" })).rejects.toMatchObject({ status: 409 });
      expect(sup.view).toMatchObject({ wantLive: false, conflict: { message: "Un direct est déjà en cours depuis 12:05." } });
      sup.dispose();
    });

    it("refuse un titre vide ou un lancement pendant un direct", async () => {
      const { api, sup } = setup();
      api.reply = live;
      sup.boot();
      await tick(1);
      await expect(sup.startManual({ type: "khutba", title: "X" })).rejects.toMatchObject({ status: 409 });
      api.reply = IDLE_REPLY;
      await sup.stopLive();
      await tick(10_500);
      await expect(sup.startManual({ type: "khutba", title: "  " })).rejects.toThrow(/titre/);
      sup.dispose();
    });

    it("arrêt sans réseau : coupé ici aussitôt, annoncé au serveur dès que possible", async () => {
      const { api, sup } = setup();
      api.reply = live;
      sup.boot();
      await tick(1);
      api.stopError = network();
      await sup.stopLive();
      expect(sup.view).toMatchObject({ wantLive: false, stopPending: true });
      api.stopError = null;
      await tick(31_000);
      expect(api.stopCalls).toBe(1);
      expect(sup.view.stopPending).toBe(false);
      sup.dispose();
    });

    it("arrêt manuel en plein créneau : le serveur répète live, on ne relance pas", async () => {
      const { api, sup } = setup();
      api.reply = live;
      sup.boot();
      await tick(1);
      await sup.stopLive();
      await tick(31_000);
      expect(sup.view.wantLive).toBe(false);
      sup.dispose();
    });
  });

  describe("reprise après redémarrage", () => {
    it("« j'étais en direct » : en attente de l'ordre du serveur, qui reste maître", async () => {
      const { api, sup } = setup({ wasLive: true });
      sup.boot();
      expect(sup.view).toMatchObject({ resuming: true, wantLive: false });
      api.reply = live;
      await tick(1);
      expect(sup.view).toMatchObject({ resuming: false, wantLive: true });
      sup.dispose();
    });

    it("serveur idle au redémarrage : on ne relance rien", async () => {
      const { sup } = setup({ wasLive: true });
      sup.boot();
      await tick(1);
      expect(sup.view.wantLive).toBe(false);
      sup.dispose();
    });

    it("l'écart d'un arrêt manuel survit au redémarrage", async () => {
      const { api, sup } = setup({ suppressed: ["slot:s1"] });
      api.reply = { ...live, schedule: [{ id: "s1", type: "khutba", title: "Khutba", startsAt: Date.now() - 60_000, endsAt: Date.now() + 40 * 60_000 }] };
      sup.boot();
      await tick(1);
      expect(sup.view.wantLive).toBe(false);
      sup.dispose();
    });

    it("rien en mémoire : écran d'appairage", () => {
      const { sup } = setup({ paired: false });
      sup.boot();
      expect(sup.view).toMatchObject({ phase: "unpaired", persistent: true });
    });

    it("l'état « en direct » est persisté seulement quand le serveur demande bien d'émettre", async () => {
      const { api, persist, sup } = setup();
      sup.boot();
      await tick(1);
      sup.setReport({ ...calmReport, sessionState: "live" });
      expect(persist.data.wasLive).toBe(false);
      api.reply = live;
      await tick(30_500);
      sup.setReport({ ...calmReport, sessionState: "live", bitrateKbps: 1 });
      sup.setReport({ ...calmReport, sessionState: "reconnecting" });
      expect(persist.data.wasLive).toBe(true);
      sup.setReport({ ...calmReport, sessionState: "idle" });
      expect(persist.data.wasLive).toBe(false);
      sup.dispose();
    });
  });
});
