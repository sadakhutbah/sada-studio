import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SadaHttpApi, normalizeReply, toWireReport } from "../src/core/api/sada-api";
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
  micro: false,
  bitrate: 2500,
  health: {
    checks: [
      { id: "camera", ok: true, detail: "Une caméra détectée." },
      { id: "windows_autologon", ok: false, detail: "Mot de passe demandé." },
      { id: "windows_update_active_hours", ok: true, detail: "" },
      { id: "sleep", ok: true, detail: "" },
      { id: "network", ok: true, detail: "" },
    ],
    last_error: { code: "capture", message: "Caméra introuvable." },
    live_start_failure: null,
  },
};

async function paired() {
  const api = new SadaHttpApi();
  const c = await api.pairing.start(mock.url, "PC-SALLE");
  mock.approve();
  const p = await api.pairing.poll(mock.url, c.deviceCode);
  if (p.status !== "paired") throw new Error("appairage attendu");
  api.useDevice({ baseUrl: mock.url, deviceId: p.deviceId, deviceSecret: p.deviceSecret, mosque: p.mosque });
  return api;
}

describe("appairage", () => {
  it("propose le nom de la machine, attend (pending) puis livre l'identifiant public et le secret apart", async () => {
    const api = new SadaHttpApi();
    const c = await api.pairing.start(mock.url, "  PC-SALLE  ");
    expect(JSON.parse(mock.requests.at(-1)!.body)).toEqual({ name: "PC-SALLE" });
    expect(c).toMatchObject({ userCode: "K7QM-4TZ2", expiresInS: 600, intervalS: 5 });
    expect(await api.pairing.poll(mock.url, c.deviceCode)).toEqual({ status: "pending" });
    mock.approve("K7QM-4TZ2");
    const p = await api.pairing.poll(mock.url, c.deviceCode);
    expect(p).toMatchObject({ status: "paired", mosque: { name: "Mosquée Alpha", slug: "alpha" } });
    if (p.status !== "paired") throw new Error("appairage attendu");
    expect(p.deviceId).toMatch(/^sdev_\d+$/);
    expect(p.deviceSecret).toMatch(new RegExp(`^${p.deviceId}\\.\\S+$`));
    expect(JSON.parse(mock.requests.at(-1)!.body)).toEqual({ device_code: c.deviceCode });
  });

  it("sans nom de machine, le corps reste vide", async () => {
    await new SadaHttpApi().pairing.start(mock.url);
    expect(JSON.parse(mock.requests.at(-1)!.body)).toEqual({});
  });

  it("un code expiré (410), inconnu (404) ou déjà réclamé (410) demande un nouveau code ; révoqué = refusé", async () => {
    const short = await (await import("../scripts/mock-sada.mjs")).createMockSada({ codeTtlS: -1 });
    const api = new SadaHttpApi();
    const c = await api.pairing.start(short.url);
    expect(await api.pairing.poll(short.url, c.deviceCode)).toEqual({ status: "expired" });
    expect(await api.pairing.poll(short.url, "inconnu")).toEqual({ status: "expired" });
    await short.close();

    const c2 = await new SadaHttpApi().pairing.start(mock.url);
    mock.approve();
    const first = await new SadaHttpApi().pairing.poll(mock.url, c2.deviceCode);
    expect(first.status).toBe("paired");
    mock.revokeAll();
    expect(await new SadaHttpApi().pairing.poll(mock.url, c2.deviceCode)).toEqual({ status: "denied" });
  });

  it("l'appareil a déjà parlé : le même code ne redonne plus rien (410 claimed)", async () => {
    const api = new SadaHttpApi();
    const c = await api.pairing.start(mock.url);
    mock.approve();
    const p = await api.pairing.poll(mock.url, c.deviceCode);
    if (p.status !== "paired") throw new Error("appairage attendu");
    api.useDevice({ baseUrl: mock.url, deviceId: p.deviceId, deviceSecret: p.deviceSecret, mosque: p.mosque });
    await api.heartbeat(report);
    expect(await api.pairing.poll(mock.url, c.deviceCode)).toEqual({ status: "expired" });
  });

  it("serveur injoignable : erreur réseau (status 0)", async () => {
    await expect(new SadaHttpApi().pairing.start("http://127.0.0.1:1")).rejects.toMatchObject({ status: 0 });
  });
});

describe("battement et direct manuel", () => {
  it("envoie le corps du contrat (camera, microphone, bitrate_kbps, health à trois clés)", () => {
    expect(toWireReport(report)).toEqual({
      state: "standby",
      version: "1.2.3",
      camera: true,
      microphone: false,
      bitrate_kbps: 2500,
      health: { auto_login: false, update_hours: true, sleep_disabled: true },
    });
    expect(toWireReport({ ...report, state: "reconnecting", health: { ...report.health, checks: [] } })).toMatchObject({ state: "live", health: {} });
    expect(toWireReport({ ...report, state: "error" }).state).toBe("error");
  });

  it("lit current.slot_id, starts_at/ends_at, next et slots du contrat", async () => {
    const api = await paired();
    const t = Date.now();
    mock.schedule = [
      { slot_id: "jumua-0@1", type: "khutba", title: "Khutba", starts_at: new Date(t + 3600_000).toISOString(), ends_at: new Date(t + 7200_000).toISOString() },
      { slot_id: "dars-1@2", type: "dars", title: "Dars", starts_at: new Date(t + 9000_000).toISOString(), ends_at: new Date(t + 12000_000).toISOString() },
    ];
    mock.setLive({ type: "dars", title: "Cours", source: "manual" });
    const reply = await api.heartbeat(report);
    expect(JSON.parse(mock.requests.at(-1)!.body)).toEqual(toWireReport(report));
    expect(mock.requests.at(-1)!.headers.authorization).toMatch(/^Bearer sdev_\d+\./);
    expect(reply.command).toBe("live");
    expect(reply.current).toEqual({ type: "dars", title: "Cours", source: "manual", slotId: undefined });
    expect(reply.schedule.map((s) => s.id)).toEqual(["jumua-0@1", "dars-1@2"]);
    expect(reply.schedule[0]).toMatchObject({ type: "khutba", startsAt: Date.parse(mock.schedule[0].starts_at as string), endsAt: Date.parse(mock.schedule[0].ends_at as string) });
    expect(reply.config.heartbeat_interval).toBe(30);
  });

  it("un créneau en cours porte son slot_id, une seule fois dans la liste", async () => {
    const api = await paired();
    mock.setLive({ type: "khutba", title: "Jumua", source: "schedule" });
    const reply = await api.heartbeat(report);
    expect(reply.current).toMatchObject({ source: "schedule", type: "khutba", title: "Jumua" });
    expect(reply.current?.slotId).toMatch(/^forced@/);
    expect(reply.schedule.filter((s) => s.id === reply.current?.slotId)).toHaveLength(1);
  });

  it("révoqué (401) : le battement lève DeviceRevokedError, comme un identifiant inconnu", async () => {
    const api = await paired();
    mock.revokeAll();
    await expect(api.heartbeat(report)).rejects.toMatchObject({ name: "DeviceRevokedError" });
    api.useDevice({ baseUrl: mock.url, deviceId: "sdev_9", deviceSecret: "sdev_9.inconnu", mosque: { name: "M" } });
    await expect(api.heartbeat(report)).rejects.toMatchObject({ name: "DeviceRevokedError" });
  });

  it("live/start, 409 avec l'heure ISO d'une autre source, puis live/stop", async () => {
    const api = await paired();
    await api.startLive({ type: "conference", title: "Soirée" });
    expect(JSON.parse(mock.requests.at(-1)!.body)).toEqual({ type: "conference", title: "Soirée" });
    expect(mock.current).toMatchObject({ source: "manual", type: "conference" });
    await api.stopLive();
    expect(mock.command).toBe("standby");
    mock.otherPublisher = true;
    await expect(api.startLive({ type: "dars", title: "Autre" })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/^Un direct est déjà en cours depuis \d\d:\d\d\.$/),
    });
  });

  it("une rotation demandée par la console apporte un nouveau secret", async () => {
    const api = await paired();
    mock.rotateAll();
    const reply = await api.heartbeat(report);
    expect(reply.credentials).toMatchObject({ deviceId: expect.stringMatching(/^sdev_/), deviceSecret: expect.stringMatching(/^sdev_\d+\./) });
    expect(normalizeReply({ credentials: { device_id: "sdev_1" } }).credentials).toBeUndefined();
  });

  it("désappairage : le serveur révoque l'appareil, qui est refusé ensuite", async () => {
    const api = await paired();
    await api.unpair();
    expect(mock.requests.at(-1)).toMatchObject({ method: "POST", url: "/api/v1/studio/unpair" });
    await expect(api.heartbeat(report)).rejects.toMatchObject({ name: "DeviceRevokedError" });
  });

  it("une réponse partielle ne casse pas la boucle", () => {
    expect(normalizeReply({}).schedule).toEqual([]);
    expect(normalizeReply({})).toMatchObject({ command: "idle", current: null });
    expect(normalizeReply({ slots: [{ title: "sans heure" }, null] }).schedule).toEqual([]);
  });
});
