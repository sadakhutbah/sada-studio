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

  describe("pairing", () => {
    it("shows a code, waits for the console, stores the identity and starts beating", async () => {
      const { api, sup, devices } = setup({ paired: false });
      sup.boot();
      expect(sup.view.phase).toBe("unpaired");
      await sup.startPairing("https://c.example");
      expect(sup.view).toMatchObject({ phase: "pairing", pairing: { userCode: "CODE-1" } });
      api.pollQueue.push({ status: "paired", deviceId: "d9", deviceSecret: "s9", mosque: MOSQUE });
      await tick(2_100);
      expect(sup.view).toMatchObject({ phase: "standby", mosque: { name: "Alpha Mosque" } });
      expect(devices.saved).toMatchObject({ deviceId: "d9", baseUrl: "https://c.example" });
      expect(api.device?.deviceSecret).toBe("s9");
      await tick(1);
      expect(api.beats).toHaveLength(1);
      sup.dispose();
    });

    it("renews the expired code by itself", async () => {
      const { api, sup } = setup({ paired: false });
      sup.boot();
      await sup.startPairing("https://c.example");
      await tick(61_000);
      expect(api.starts).toBe(2);
      expect(sup.view.pairing?.userCode).toBe("CODE-2");
      sup.dispose();
    });

    it("an expired code reported by the server is renewed without waiting", async () => {
      const { api, sup } = setup({ paired: false });
      sup.boot();
      await sup.startPairing("https://c.example");
      api.pollQueue.push({ status: "expired" });
      await tick(2_100);
      expect(sup.view.pairing?.userCode).toBe("CODE-2");
      sup.dispose();
    });

    it("request denied: back to the initial screen with an explanation", async () => {
      const { api, sup } = setup({ paired: false });
      sup.boot();
      await sup.startPairing("https://c.example");
      api.pollQueue.push({ status: "denied" });
      await tick(2_100);
      expect(sup.view).toMatchObject({ phase: "unpaired", notice: { code: "pair-denied" } });
      sup.dispose();
    });

    it("unpairing notifies the server, forgets the identity and stops the heartbeat", async () => {
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

    it("unpairing forgets the identity even if the server is unreachable", async () => {
      const { api, sup, devices } = setup();
      api.unpairError = network();
      sup.boot();
      await tick(1);
      await sup.unpair();
      expect(devices.saved).toBeNull();
      expect(sup.view.phase).toBe("unpaired");
    });

    it("suggests the machine name to the console, for the first code as for the renewal", async () => {
      const { api, sup } = setup({ paired: false });
      sup.boot();
      await sup.startPairing("https://c.example");
      await tick(61_000);
      expect(api.machineNames).toEqual(["PC-SALLE", "PC-SALLE"]);
      sup.dispose();
    });

    it("rotation: the new secret is stored and used right away", async () => {
      const { api, sup, devices } = setup();
      api.reply = { ...IDLE_REPLY, credentials: { deviceId: "d1", deviceSecret: "s2" } };
      sup.boot();
      await tick(1);
      expect(devices.saved).toMatchObject({ deviceId: "d1", deviceSecret: "s2", baseUrl: "https://c.example" });
      expect(api.device?.deviceSecret).toBe("s2");
      sup.dispose();
    });
  });

  describe("heartbeat loop (simulated clock)", () => {
    it("beats right away at startup, then every 30 s in standby and 10 s during a live", async () => {
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

    it("the live then idle order drives the broadcast", async () => {
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

    it("honors the interval requested by the server (bounded)", async () => {
      const { api, sup } = setup();
      api.reply = { ...IDLE_REPLY, config: { heartbeat_interval: 5 } };
      sup.boot();
      await tick(1);
      await tick(5_100);
      expect(api.beats).toHaveLength(2);
      sup.dispose();
    });

    it("server unreachable: bounded growing delay, offline displayed, the current order is kept", async () => {
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
      // 5 s, 10 s, 20 s, 40 s, 80 s, 120 s…: far fewer than a heartbeat every 10 s
      expect(api.beats.length - n).toBeLessThan(12);
      expect(api.beats.length - n).toBeGreaterThan(4);
      api.beatError = null;
      await tick(130_000);
      expect(sup.view.online).toBe(true);
      sup.dispose();
    });

    it("401 on heartbeat: device revoked, back to pairing, no more heartbeats", async () => {
      const { api, sup, devices } = setup();
      sup.boot();
      await tick(1);
      api.beatError = revoked();
      await tick(30_500);
      expect(sup.view).toMatchObject({ phase: "revoked", wantLive: false, notice: { code: "revoked" } });
      expect(sup.view.notice?.message).toMatch(/pair it again/);
      expect(devices.saved).toBeNull();
      const n = api.beats.length;
      await tick(120_000);
      expect(api.beats).toHaveLength(n);
    });
  });

  describe("health and immediate heartbeat", () => {
    it("attaches the detailed health: checks, network, last error, start failure", async () => {
      const { api, sup } = setup();
      sup.boot();
      sup.setReport({
        ...calmReport,
        lastError: { code: "capture", message: "Camera not found." },
        startFailure: "Camera not found.",
      });
      await tick(1);
      expect(api.beats[0].health).toEqual({
        checks: [
          { id: "camera", ok: true, detail: "ok" },
          { id: "network", ok: true, detail: "Sada server reachable." },
        ],
        last_error: { code: "capture", message: "Camera not found." },
        live_start_failure: { message: "Camera not found." },
      });
      sup.dispose();
    });

    it("adds the checks produced by the main process (IP camera capture) and sends an outage at once", async () => {
      const { api, sup } = setup();
      let capture: { id: string; ok: boolean; detail: string }[] = [{ id: "capture", ok: true, detail: "running" }];
      sup.setCheckProvider(() => capture);
      sup.boot();
      sup.setReport(calmReport);
      await tick(5_000);
      expect(api.beats.at(-1)!.health.checks.map((c: { id: string }) => c.id)).toEqual(["camera", "capture", "network"]);
      const n = api.beats.length;
      capture = [{ id: "capture", ok: false, detail: "no signal" }];
      sup.refreshChecks();
      await tick(10);
      expect(api.beats.length).toBe(n + 1);
      expect(api.beats.at(-1)!.health.checks.find((c: { id: string }) => c.id === "capture")).toMatchObject({ ok: false });
      sup.dispose();
    });

    it("a check that changes state triggers an immediate heartbeat (without waiting 30 s)", async () => {
      const { api, sup } = setup();
      sup.boot();
      sup.setReport(calmReport);
      await tick(5_000);
      const n = api.beats.length;
      sup.setReport({ ...calmReport, camera: false, checks: [{ id: "camera", ok: false, detail: "No camera detected." }] });
      await tick(10);
      expect(api.beats.length).toBe(n + 1);
      expect(api.beats.at(-1)!.health.checks[0]).toMatchObject({ id: "camera", ok: false });
      sup.dispose();
    });

    it("a flickering check does not hammer the server: minimum gap between two heartbeats", async () => {
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

    it("without a state change, no extra heartbeat (the bitrate alone does not count)", async () => {
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

    it("a session error triggers an immediate heartbeat", async () => {
      const { api, sup } = setup();
      sup.boot();
      sup.setReport(calmReport);
      await tick(5_000);
      const n = api.beats.length;
      sup.setReport({ ...calmReport, sessionState: "error", lastError: { code: "conflict", message: "A live is already running." } });
      await tick(10);
      expect(api.beats.length).toBe(n + 1);
      expect(api.beats.at(-1)!.health.last_error?.code).toBe("conflict");
      sup.dispose();
    });

    it("link with the relay down: network turns false", async () => {
      const { api, sup } = setup();
      sup.boot();
      sup.setReport({ ...calmReport, sessionState: "reconnecting" });
      await tick(1);
      expect(api.beats[0].health.checks.find((c) => c.id === "network")).toMatchObject({ ok: false });
      sup.dispose();
    });
  });

  describe("manual live", () => {
    it("start then stop: calls the server, the server remains the master", async () => {
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

    it("409: shows \"already running since X\" and does not broadcast", async () => {
      const { api, sup } = setup();
      sup.boot();
      await tick(1);
      api.startError = new ApiError(409, "A live is already running since 12:05.");
      await expect(sup.startManual({ type: "khutba", title: "X" })).rejects.toMatchObject({ status: 409 });
      expect(sup.view).toMatchObject({ wantLive: false, conflict: { message: "A live is already running since 12:05." } });
      sup.dispose();
    });

    it("refuses an empty title or a start during a live", async () => {
      const { api, sup } = setup();
      api.reply = live;
      sup.boot();
      await tick(1);
      await expect(sup.startManual({ type: "khutba", title: "X" })).rejects.toMatchObject({ status: 409 });
      api.reply = IDLE_REPLY;
      await sup.stopLive();
      await tick(10_500);
      await expect(sup.startManual({ type: "khutba", title: "  " })).rejects.toThrow(/title/);
      sup.dispose();
    });

    it("stop without network: cut here at once, announced to the server as soon as possible", async () => {
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

    it("manual stop mid-slot: the server repeats live, do not restart", async () => {
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

  describe("resume after restart", () => {
    it("resumes after \"I was live\": waits for the server order, which remains the master", async () => {
      const { api, sup } = setup({ wasLive: true });
      sup.boot();
      expect(sup.view).toMatchObject({ resuming: true, wantLive: false });
      api.reply = live;
      await tick(1);
      expect(sup.view).toMatchObject({ resuming: false, wantLive: true });
      sup.dispose();
    });

    it("server idle at restart: nothing is restarted", async () => {
      const { sup } = setup({ wasLive: true });
      sup.boot();
      await tick(1);
      expect(sup.view.wantLive).toBe(false);
      sup.dispose();
    });

    it("the manual-stop dismissal survives a restart", async () => {
      const { api, sup } = setup({ suppressed: ["slot:s1"] });
      api.reply = { ...live, schedule: [{ id: "s1", type: "khutba", title: "Khutba", startsAt: Date.now() - 60_000, endsAt: Date.now() + 40 * 60_000 }] };
      sup.boot();
      await tick(1);
      expect(sup.view.wantLive).toBe(false);
      sup.dispose();
    });

    it("nothing in memory: pairing screen", () => {
      const { sup } = setup({ paired: false });
      sup.boot();
      expect(sup.view).toMatchObject({ phase: "unpaired", persistent: true });
    });

    it("the live state is persisted only when the server really asks to broadcast", async () => {
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
