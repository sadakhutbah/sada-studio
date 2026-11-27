import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SadaHttpApi, normalizeReply } from "../src/core/api/sada-api";
import { INITIAL_KIOSK, kioskTransition, pairedState } from "../src/core/kiosk/machine";
import { KioskSupervisor } from "../src/core/kiosk/supervisor";
import { SharedOutputSource } from "../src/core/sources/shared-output";
import { FakeApi, IDLE_REPLY, MOSQUE, MemoryDevices, MemoryPersist, fakeStream, startMockSada, type MockSada } from "./helpers";

/** The web control room asks for the device's picture outside a live: heartbeat flag, preview WHIP, cadence. */

describe("heartbeat reply: preview", () => {
  it("is on only when the server says `preview.on`", () => {
    expect(normalizeReply({ command: "idle", preview: { on: true, expires_in: 40 } }).preview).toBe(true);
    expect(normalizeReply({ command: "idle", preview: null }).preview).toBe(false);
    expect(normalizeReply({ command: "idle" }).preview).toBe(false);
    expect(normalizeReply({ command: "idle", preview: true }).preview).toBe(false); // not the contract's shape
  });
});

describe("kiosk machine: preview", () => {
  const paired = () => pairedState(MOSQUE, "https://sada.example");
  const at = 1_000;

  it("follows the server, and is dropped when the server cannot be reached", () => {
    let s = kioskTransition(paired(), { type: "HEARTBEAT_OK", reply: { ...IDLE_REPLY, preview: true }, at });
    expect(s.preview).toBe(true);
    expect(s.wantLive).toBe(false); // a preview is never a live
    s = kioskTransition(s, { type: "HEARTBEAT_FAILED" });
    expect(s.preview).toBe(false);
    s = kioskTransition(s, { type: "HEARTBEAT_OK", reply: { ...IDLE_REPLY, preview: true }, at });
    s = kioskTransition(s, { type: "HEARTBEAT_OK", reply: IDLE_REPLY, at: at + 5_000 });
    expect(s.preview).toBe(false);
  });

  it("is forgotten when the device leaves the mosque", () => {
    const s = kioskTransition(paired(), { type: "HEARTBEAT_OK", reply: { ...IDLE_REPLY, preview: true }, at });
    expect(kioskTransition(s, { type: "UNPAIR" }).preview).toBe(false);
    expect(kioskTransition(s, { type: "REVOKED", message: "" }).preview).toBe(false);
    expect(INITIAL_KIOSK.preview).toBe(false);
  });
});

describe("supervisor: preview cadence", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  it("beats every 10 s while the control room watches, so a stop is seen quickly", async () => {
    const api = new FakeApi();
    const devices = new MemoryDevices();
    devices.saved = { baseUrl: "https://sada.example", deviceId: "sdev_1", deviceSecret: "s", mosque: MOSQUE };
    const sup = new KioskSupervisor(api, devices, new MemoryPersist(), { version: "t", heartbeatMs: 30_000, heartbeatLiveMs: 10_000, minBeatGapMs: 2_000 });
    api.reply = { ...IDLE_REPLY, config: { heartbeat_interval: 30 }, preview: true };
    sup.boot();
    await tick(1);
    expect(sup.view.preview).toBe(true);
    const before = api.beats.length;
    await tick(10_500);
    expect(api.beats.length).toBe(before + 1);
    api.reply = { ...IDLE_REPLY, config: { heartbeat_interval: 30 } };
    await tick(10_500);
    expect(sup.view.preview).toBe(false);
    const quiet = api.beats.length;
    await tick(20_000);
    expect(api.beats.length).toBe(quiet); // back to the server's 30 s
    sup.dispose();
  });
});

describe("shared output source", () => {
  it("sends the stream the screen holds, never opens nor releases the capture", async () => {
    const offs: string[] = [];
    const target = {
      onEnded: (_cb: () => void) => () => void offs.push("ended"),
      onStreamChange: (_cb: (s: MediaStream) => void) => () => void offs.push("change"),
    };
    const src = new SharedOutputSource(target);
    await expect(src.acquire()).rejects.toThrow();
    const stream = fakeStream();
    src.setCurrent(stream);
    await expect(src.acquire()).resolves.toBe(stream);
    src.release();
    src.onEnded(() => undefined)();
    src.onStreamChange(() => undefined)();
    expect(offs).toEqual(["ended", "change"]);
  });
});

describe("preview WHIP (device secret)", () => {
  let mock: MockSada;
  beforeEach(async () => {
    mock = await startMockSada();
  });
  afterEach(() => mock.close());

  async function paired() {
    const api = new SadaHttpApi();
    const c = await api.pairing.start(mock.url);
    mock.approve();
    const p = await api.pairing.poll(mock.url, c.deviceCode);
    if (p.status !== "paired") throw new Error("pairing expected");
    api.useDevice({ baseUrl: mock.url, deviceId: p.deviceId, deviceSecret: p.deviceSecret, mosque: p.mosque });
    return { api, secret: p.deviceSecret };
  }

  it("is refused while nobody asks, then goes to the preview endpoint", async () => {
    const { api, secret } = await paired();
    await expect(api.previewWhip.offer("v=0\r\noffer\r\n")).rejects.toMatchObject({ status: 409 });
    mock.preview = true;
    expect((await api.heartbeat(REPORT)).preview).toBe(true);
    const r = await api.previewWhip.offer("v=0\r\noffer\r\n");
    expect(r).toEqual({ answer: "v=0\r\npreview\r\n", resource: "/api/v1/live/studio/preview/whip/prev-1" });
    const req = mock.requests.at(-1)!;
    expect(req).toMatchObject({ method: "POST", url: "/api/v1/live/studio/preview/whip" });
    expect(req.headers.authorization).toBe(`Bearer ${secret}`);
    await api.previewWhip.close(r.resource);
    expect(mock.requests.at(-1)).toMatchObject({ method: "DELETE", url: "/api/v1/live/studio/preview/whip/prev-1" });
  });

  it("is not asked during a live", async () => {
    const { api } = await paired();
    mock.preview = true;
    mock.setLive({ type: "khutba", title: "Live" });
    expect((await api.heartbeat(REPORT)).preview).toBe(false);
  });
});

const REPORT = {
  state: "standby",
  version: "t",
  camera: true,
  micro: true,
  bitrate: 0,
  health: { checks: [], last_error: null, live_start_failure: null },
};
