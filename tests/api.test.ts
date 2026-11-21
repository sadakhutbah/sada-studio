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
      { id: "camera", ok: true, detail: "One camera detected." },
      { id: "windows_autologon", ok: false, detail: "Password required." },
      { id: "windows_update_active_hours", ok: true, detail: "" },
      { id: "sleep", ok: true, detail: "" },
      { id: "network", ok: true, detail: "" },
    ],
    last_error: { code: "capture", message: "Camera not found." },
    live_start_failure: null,
  },
};

async function paired() {
  const api = new SadaHttpApi();
  const c = await api.pairing.start(mock.url, "PC-SALLE");
  mock.approve();
  const p = await api.pairing.poll(mock.url, c.deviceCode);
  if (p.status !== "paired") throw new Error("pairing expected");
  api.useDevice({ baseUrl: mock.url, deviceId: p.deviceId, deviceSecret: p.deviceSecret, mosque: p.mosque });
  return api;
}

describe("pairing", () => {
  it("suggests the machine name, waits (pending), then delivers the public id and the device secret", async () => {
    const api = new SadaHttpApi();
    const c = await api.pairing.start(mock.url, "  PC-SALLE  ");
    expect(JSON.parse(mock.requests.at(-1)!.body)).toEqual({ name: "PC-SALLE" });
    expect(c).toMatchObject({ userCode: "K7QM-4TZ2", expiresInS: 600, intervalS: 5 });
    expect(await api.pairing.poll(mock.url, c.deviceCode)).toEqual({ status: "pending" });
    mock.approve("K7QM-4TZ2");
    const p = await api.pairing.poll(mock.url, c.deviceCode);
    expect(p).toMatchObject({ status: "paired", mosque: { name: "Alpha Mosque", slug: "alpha" } });
    if (p.status !== "paired") throw new Error("pairing expected");
    expect(p.deviceId).toMatch(/^sdev_\d+$/);
    expect(p.deviceSecret).toMatch(new RegExp(`^${p.deviceId}\\.\\S+$`));
    expect(JSON.parse(mock.requests.at(-1)!.body)).toEqual({ device_code: c.deviceCode });
  });

  it("without a machine name, the body stays empty", async () => {
    await new SadaHttpApi().pairing.start(mock.url);
    expect(JSON.parse(mock.requests.at(-1)!.body)).toEqual({});
  });

  it("an expired (410), unknown (404) or already claimed (410) code requires a new code; revoked = refused", async () => {
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

  it("the device has already spoken: the same code yields nothing more (410 claimed)", async () => {
    const api = new SadaHttpApi();
    const c = await api.pairing.start(mock.url);
    mock.approve();
    const p = await api.pairing.poll(mock.url, c.deviceCode);
    if (p.status !== "paired") throw new Error("pairing expected");
    api.useDevice({ baseUrl: mock.url, deviceId: p.deviceId, deviceSecret: p.deviceSecret, mosque: p.mosque });
    await api.heartbeat(report);
    expect(await api.pairing.poll(mock.url, c.deviceCode)).toEqual({ status: "expired" });
  });

  it("server unreachable: network error (status 0)", async () => {
    await expect(new SadaHttpApi().pairing.start("http://127.0.0.1:1")).rejects.toMatchObject({ status: 0 });
  });
});

describe("heartbeat and manual live", () => {
  it("sends the contract body (camera, microphone, bitrate_kbps, health with three keys)", () => {
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
    // no check yet: neither camera nor microphone is claimed absent (no false alert at startup)
    const first = toWireReport({ ...report, camera: false, micro: false, health: { ...report.health, checks: [] } });
    expect(first).not.toHaveProperty("camera");
    expect(first).not.toHaveProperty("microphone");
  });

  it("reads current.slot_id, starts_at/ends_at, next and slots from the contract", async () => {
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

  it("a running slot carries its slot_id, only once in the list", async () => {
    const api = await paired();
    mock.setLive({ type: "khutba", title: "Jumua", source: "schedule" });
    const reply = await api.heartbeat(report);
    expect(reply.current).toMatchObject({ source: "schedule", type: "khutba", title: "Jumua" });
    expect(reply.current?.slotId).toMatch(/^forced@/);
    expect(reply.schedule.filter((s) => s.id === reply.current?.slotId)).toHaveLength(1);
  });

  it("revoked (401): the heartbeat throws DeviceRevokedError, like an unknown credential", async () => {
    const api = await paired();
    mock.revokeAll();
    await expect(api.heartbeat(report)).rejects.toMatchObject({ name: "DeviceRevokedError" });
    api.useDevice({ baseUrl: mock.url, deviceId: "sdev_9", deviceSecret: "sdev_9.inconnu", mosque: { name: "M" } });
    await expect(api.heartbeat(report)).rejects.toMatchObject({ name: "DeviceRevokedError" });
  });

  it("live/start, 409 with the ISO time of another source, then live/stop", async () => {
    const api = await paired();
    await api.startLive({ type: "conference", title: "Evening" });
    expect(JSON.parse(mock.requests.at(-1)!.body)).toEqual({ type: "conference", title: "Evening" });
    expect(mock.current).toMatchObject({ source: "manual", type: "conference" });
    await api.stopLive();
    expect(mock.command).toBe("standby");
    mock.otherPublisher = true;
    await expect(api.startLive({ type: "dars", title: "Other" })).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/^A live is already running since \d\d:\d\d\.$/),
    });
  });

  it("a rotation requested by the console brings a new secret", async () => {
    const api = await paired();
    mock.rotateAll();
    const reply = await api.heartbeat(report);
    expect(reply.credentials).toMatchObject({ deviceId: expect.stringMatching(/^sdev_/), deviceSecret: expect.stringMatching(/^sdev_\d+\./) });
    expect(normalizeReply({ credentials: { device_id: "sdev_1" } }).credentials).toBeUndefined();
  });

  it("unpairing: the server revokes the device, which is refused afterwards", async () => {
    const api = await paired();
    await api.unpair();
    expect(mock.requests.at(-1)).toMatchObject({ method: "POST", url: "/api/v1/studio/unpair" });
    await expect(api.heartbeat(report)).rejects.toMatchObject({ name: "DeviceRevokedError" });
  });

  it("a partial response does not break the loop", () => {
    expect(normalizeReply({}).schedule).toEqual([]);
    expect(normalizeReply({})).toMatchObject({ command: "idle", current: null });
    expect(normalizeReply({ slots: [{ title: "sans heure" }, null] }).schedule).toEqual([]);
  });
});
