import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SadaHttpApi, normalizeReply } from "../src/core/api/sada-api";
import type { HeartbeatReport } from "../src/core/api/types";
import { startMockSada, type MockSada } from "./helpers";

let mock: MockSada;
beforeEach(async () => {
  mock = await startMockSada();
});
afterEach(() => mock.close());

const report: HeartbeatReport = {
  state: "idle",
  version: "1.2.3",
  camera: true,
  micro: true,
  bitrate: 0,
  health: {
    checks: [{ id: "camera", ok: true, detail: "Une caméra détectée." }],
    last_error: { code: "capture", message: "Caméra introuvable." },
    live_start_failure: { message: "Caméra introuvable." },
  },
};

async function paired() {
  const api = new SadaHttpApi();
  const c = await api.pairing.start(mock.url);
  mock.approve();
  const p = await api.pairing.poll(mock.url, c.deviceCode);
  if (p.status !== "paired") throw new Error("appairage attendu");
  api.useDevice({ baseUrl: mock.url, deviceId: p.deviceId, deviceSecret: p.deviceSecret, mosque: p.mosque });
  return api;
}

describe("appairage", () => {
  it("rend le code, attend (pending) puis livre l'identité de l'appareil et la mosquée", async () => {
    const api = new SadaHttpApi();
    const c = await api.pairing.start(mock.url);
    expect(c).toMatchObject({ userCode: "K7QM-4TZ2", expiresInS: 600, intervalS: 2 });
    expect(await api.pairing.poll(mock.url, c.deviceCode)).toEqual({ status: "pending" });
    mock.approve("K7QM-4TZ2");
    const p = await api.pairing.poll(mock.url, c.deviceCode);
    expect(p).toMatchObject({ status: "paired", mosque: { name: "Mosquée Alpha" } });
    expect(JSON.parse(mock.requests.at(-1)!.body)).toEqual({ device_code: c.deviceCode });
  });

  it("un code expiré (410) ou inconnu (404) est « expired »", async () => {
    const short = await (await import("../scripts/mock-sada.mjs")).createMockSada({ codeTtlS: -1 });
    const api = new SadaHttpApi();
    const c = await api.pairing.start(short.url);
    expect(await api.pairing.poll(short.url, c.deviceCode)).toEqual({ status: "expired" });
    expect(await api.pairing.poll(short.url, "inconnu")).toEqual({ status: "expired" });
    await short.close();
  });

  it("serveur injoignable : erreur réseau (status 0)", async () => {
    await expect(new SadaHttpApi().pairing.start("http://127.0.0.1:1")).rejects.toMatchObject({ status: 0 });
  });
});

describe("battement et direct manuel", () => {
  it("transmet la santé détaillée et normalise planning et direct en cours", async () => {
    const api = await paired();
    mock.schedule = [{ id: "s1", type: "khutba", title: "Khutba", starts_at: "2026-11-27T12:15:00Z", ends_at: "2026-11-27T13:00:00Z" }];
    mock.setLive({ type: "dars", title: "Dars", source: "manual" });
    const reply = await api.heartbeat(report);
    expect(JSON.parse(mock.requests.at(-1)!.body)).toEqual(report);
    expect(mock.requests.at(-1)!.headers.authorization).toMatch(/^Bearer secret-/);
    expect(reply.command).toBe("live");
    expect(reply.current).toEqual({ type: "dars", title: "Dars", source: "manual", slotId: undefined });
    expect(reply.schedule[0]).toMatchObject({ id: "s1", type: "khutba", startsAt: Date.parse("2026-11-27T12:15:00Z"), endsAt: Date.parse("2026-11-27T13:00:00Z") });
  });

  it("révoqué : le battement lève DeviceRevokedError", async () => {
    const api = await paired();
    mock.revokeAll();
    await expect(api.heartbeat(report)).rejects.toMatchObject({ name: "DeviceRevokedError" });
  });

  it("live/start puis live/stop ; 409 avec l'heure du direct en cours", async () => {
    const api = await paired();
    await api.startLive({ type: "khutba", title: "Khutba spéciale" });
    expect(JSON.parse(mock.requests.at(-1)!.body)).toEqual({ type: "khutba", title: "Khutba spéciale" });
    expect(mock.current).toMatchObject({ source: "manual" });
    await expect(api.startLive({ type: "dars", title: "Autre" })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/^Un direct est déjà en cours depuis \d\d:\d\d\.$/),
    });
    await api.stopLive();
    expect(mock.command).toBe("idle");
  });

  it("une réponse partielle ne casse pas la boucle", () => {
    expect(normalizeReply({})).toEqual({ config: {}, schedule: [], command: "idle", current: null });
    expect(normalizeReply({ schedule: [{ title: "sans heure" }, null] }).schedule).toEqual([]);
  });
});
