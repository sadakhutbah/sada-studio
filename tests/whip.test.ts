import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError, FatalError } from "../src/core/errors";
import { SadaHttpApi, normalizeBaseUrl } from "../src/core/api/sada-api";
import { WhipTransport } from "../src/core/transport/whip";
import { FakePeer, fakeStream, startMockSada, type MockSada } from "./helpers";

let mock: MockSada;
beforeEach(async () => {
  mock = await startMockSada();
});
afterEach(() => mock.close());

/** Appairage complet contre le faux serveur, puis un client prêt à diffuser. */
async function paired() {
  const api = new SadaHttpApi();
  const c = await api.pairing.start(mock.url);
  mock.approve();
  const p = await api.pairing.poll(mock.url, c.deviceCode);
  if (p.status !== "paired") throw new Error("appairage attendu");
  api.useDevice({ baseUrl: mock.url, deviceId: p.deviceId, deviceSecret: p.deviceSecret, mosque: p.mosque });
  return { api, secret: p.deviceSecret };
}

describe("signalisation WHIP (secret d'appareil)", () => {
  it("POST de l'offre en application/sdp avec Bearer, lit Location", async () => {
    const { api, secret } = await paired();
    const r = await api.whip.offer("v=0\r\noffer\r\n");
    expect(r).toEqual({ answer: "v=0\r\nanswer\r\n", resource: "/api/v1/live/studio/whip/sess-1" });
    const req = mock.requests.at(-1)!;
    expect(req).toMatchObject({ method: "POST", url: "/api/v1/live/studio/whip", body: "v=0\r\noffer\r\n" });
    expect(req.headers["content-type"]).toBe("application/sdp");
    expect(req.headers.authorization).toBe(`Bearer ${secret}`);
    expect(req.headers.cookie).toBeUndefined();
  });

  it("PATCH ICE et DELETE sur la ressource", async () => {
    const { api } = await paired();
    await api.whip.patchIce("/api/v1/live/studio/whip/sess-1", "a=candidate:1\r\n");
    await api.whip.close("/api/v1/live/studio/whip/sess-1");
    const [patch, del] = mock.requests.slice(-2);
    expect(patch).toMatchObject({ method: "PATCH", body: "a=candidate:1\r\n" });
    expect(patch.headers["content-type"]).toBe("application/trickle-ice-sdpfrag");
    expect(del.method).toBe("DELETE");
  });

  it("refuse un Location hors de l'instance : le secret ne part jamais ailleurs", async () => {
    const bad = new SadaHttpApi({ fetch: async () => new Response("x", { status: 201, headers: { location: "https://evil.example/whip/1" } }) });
    bad.useDevice({ baseUrl: mock.url, deviceId: "d", deviceSecret: "s", mosque: { name: "M" } });
    await expect(bad.whip.offer("sdp")).rejects.toMatchObject({ status: 502 });
  });

  it("appareil révoqué : 401 devient DeviceRevokedError", async () => {
    const { api } = await paired();
    mock.revokeAll();
    await expect(api.whip.offer("sdp")).rejects.toMatchObject({ name: "DeviceRevokedError" });
  });
});

describe("WhipTransport", () => {
  const transportWith = (api: SadaHttpApi, peer: FakePeer, extra = {}) =>
    new WhipTransport({ signaling: api.whip, createPeer: () => peer as unknown as RTCPeerConnection, disconnectGraceMs: 50, ...extra });

  it("négocie contre le serveur simulé et rend les statistiques", async () => {
    const { api } = await paired();
    const peer = new FakePeer();
    const t = transportWith(api, peer);
    await t.connect(fakeStream());
    expect(peer.remote?.sdp).toBe("v=0\r\nanswer\r\n");
    peer.bytes = 1234;
    expect(await t.getStats()).toEqual({ bytesSent: 1234, fps: 30, rttMs: 25 });
    await t.close();
    expect(peer.closed).toBe(true);
    expect(mock.requests.at(-1)).toMatchObject({ method: "DELETE", url: "/api/v1/live/studio/whip/sess-1" });
  });

  it("signale la perte quand la liaison échoue", async () => {
    const { api } = await paired();
    const peer = new FakePeer();
    const t = transportWith(api, peer);
    const lost = new Promise<string>((r) => t.onLost(r));
    await t.connect(fakeStream());
    peer.setState("failed");
    await expect(lost).resolves.toMatch(/perdue/);
  });

  it("tolère une coupure brève (« disconnected » qui revient)", async () => {
    const { api } = await paired();
    const peer = new FakePeer();
    const t = transportWith(api, peer);
    let fired = false;
    t.onLost(() => (fired = true));
    await t.connect(fakeStream());
    peer.setState("disconnected");
    peer.setState("connected");
    await new Promise((r) => setTimeout(r, 120));
    expect(fired).toBe(false);
  });

  it("traduit 409 en conflit : fatal pour cette tentative, avec l'heure du direct en cours", async () => {
    const { api } = await paired();
    mock.whipStatus = 409;
    const t = transportWith(api, new FakePeer());
    const err = await t.connect(fakeStream()).catch((e) => e);
    expect(err).toBeInstanceOf(FatalError);
    expect(err.code).toBe("conflict");
    expect(err.message).toMatch(/^Un direct est déjà en cours depuis \d\d:\d\d\.$/);
  });

  it("une erreur réseau reste réessayable", async () => {
    const { api } = await paired();
    await mock.close();
    const t = transportWith(api, new FakePeer());
    const err = await t.connect(fakeStream()).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(FatalError);
    mock = await startMockSada();
  });
});

describe("adresse de l'instance", () => {
  it("exige https hors du local", () => {
    expect(() => normalizeBaseUrl("http://console.example.org")).toThrow(/https/);
    expect(normalizeBaseUrl("console.sadakhutbah.org/")).toBe("https://console.sadakhutbah.org");
    expect(normalizeBaseUrl("http://localhost:8080/x")).toBe("http://localhost:8080");
  });
});
