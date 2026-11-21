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

const creds = (over = {}) => ({ baseUrl: "", username: "imam", password: "secret", ...over });

async function signedIn() {
  const api = new SadaHttpApi();
  await api.login(creds({ baseUrl: mock.url }));
  await api.selectMosque(1);
  return api;
}

describe("client API Sada (serveur simulé)", () => {
  it("se connecte avec le défi anti-rejeu, puis choisit la mosquée", async () => {
    const api = new SadaHttpApi();
    const s = await api.login(creds({ baseUrl: mock.url }));
    expect(s.mosques.map((m) => m.slug)).toEqual(["alpha", "beta"]);
    const login = mock.requests.find((r) => r.url === "/api/v1/login")!;
    expect(login.headers.cookie).toContain("sada_pre=pre123");
    expect(new URLSearchParams(login.body).get("pre")).toBe("pre123");
    const chosen = await api.selectMosque(1);
    expect(chosen.mosque?.id).toBe(1);
    const sel = mock.requests.find((r) => r.url === "/api/v1/mosques/select")!;
    expect(sel.headers["x-csrf"]).toBe("csrf-tok1");
    expect(sel.headers.cookie).toContain("sada_session=tok1");
  });

  it("traduit un mauvais mot de passe", async () => {
    await expect(new SadaHttpApi().login(creds({ baseUrl: mock.url, password: "non" }))).rejects.toMatchObject({
      status: 401,
      message: "Identifiant ou mot de passe incorrect.",
    });
  });

  it("signale un serveur injoignable", async () => {
    await expect(new SadaHttpApi().login(creds({ baseUrl: "http://127.0.0.1:1" }))).rejects.toMatchObject({ status: 0 });
  });

  it("exige https hors du local", () => {
    expect(() => normalizeBaseUrl("http://console.example.org")).toThrow(/https/);
    expect(normalizeBaseUrl("console.sadakhutbah.org/")).toBe("https://console.sadakhutbah.org");
    expect(normalizeBaseUrl("http://localhost:8080/x")).toBe("http://localhost:8080");
  });
});

describe("signalisation WHIP", () => {
  it("POST de l'offre en application/sdp avec cookie et X-CSRF, lit Location", async () => {
    const api = await signedIn();
    const r = await api.whip.offer("v=0\r\noffer\r\n");
    expect(r).toEqual({ answer: "v=0\r\nanswer\r\n", resource: "/api/v1/live/studio/whip/sess-1" });
    const req = mock.requests.at(-1)!;
    expect(req).toMatchObject({ method: "POST", url: "/api/v1/live/studio/whip", body: "v=0\r\noffer\r\n" });
    expect(req.headers["content-type"]).toBe("application/sdp");
    expect(req.headers["x-csrf"]).toBeTruthy();
    expect(req.headers.cookie).toContain("sada_session=");
  });

  it("PATCH ICE et DELETE sur la ressource", async () => {
    const api = await signedIn();
    await api.whip.patchIce("/api/v1/live/studio/whip/sess-1", "a=candidate:1\r\n");
    await api.whip.close("/api/v1/live/studio/whip/sess-1");
    const [patch, del] = mock.requests.slice(-2);
    expect(patch).toMatchObject({ method: "PATCH", body: "a=candidate:1\r\n" });
    expect(patch.headers["content-type"]).toBe("application/trickle-ice-sdpfrag");
    expect(del.method).toBe("DELETE");
  });

  it("se reconnecte en silence quand la session a expiré, puis rejoue l'appel", async () => {
    const api = await signedIn();
    mock.expireSessionOnce();
    const r = await api.whip.offer("sdp");
    expect(r.resource).toContain("sess-1");
    const logins = mock.requests.filter((q) => q.url === "/api/v1/login").length;
    expect(logins).toBe(2);
    // la mosquée choisie est rouverte après la reconnexion
    expect(mock.requests.filter((q) => q.url === "/api/v1/mosques/select")).toHaveLength(2);
  });

  it("refuse un Location hors de l'instance", async () => {
    const api = await signedIn();
    const bad = new SadaHttpApi({
      fetch: async () => new Response("x", { status: 201, headers: { location: "https://evil.example/whip/1" } }),
    });
    // simule une session déjà ouverte sur cette instance
    (bad as unknown as { baseUrl: string }).baseUrl = mock.url;
    await expect(bad.whip.offer("sdp")).rejects.toMatchObject({ status: 502 });
    expect(api).toBeDefined();
  });
});

describe("WhipTransport", () => {
  const transportWith = (api: SadaHttpApi, peer: FakePeer, extra = {}) =>
    new WhipTransport({ signaling: api.whip, createPeer: () => peer as unknown as RTCPeerConnection, disconnectGraceMs: 50, ...extra });

  it("négocie contre le serveur simulé et rend les statistiques", async () => {
    const api = await signedIn();
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
    const api = await signedIn();
    const peer = new FakePeer();
    const t = transportWith(api, peer);
    const lost = new Promise<string>((r) => t.onLost(r));
    await t.connect(fakeStream());
    peer.setState("failed");
    await expect(lost).resolves.toMatch(/perdue/);
  });

  it("tolère une coupure brève (« disconnected » qui revient)", async () => {
    const api = await signedIn();
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

  it("traduit 409 (entrée non « push ») en erreur fatale", async () => {
    const api = await signedIn();
    mock.whipStatus = 409;
    const t = transportWith(api, new FakePeer());
    await expect(t.connect(fakeStream())).rejects.toBeInstanceOf(FatalError);
  });

  it("une erreur réseau reste réessayable", async () => {
    const api = await signedIn();
    await mock.close();
    const t = transportWith(api, new FakePeer());
    const err = await t.connect(fakeStream()).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(FatalError);
    mock = await (await import("./helpers")).startMockSada();
  });
});
