import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlRequest, ControlResult } from "../src/core/control/actions";
import { ControlHttpHandler, isLocalOrigin, isLoopbackAddress, safeEqual, type ControlHttpRequest } from "../src/main/control-http";
import { ControlServer } from "../src/main/control-server";

const TOKEN = "f".repeat(64);
const PORT = 17420;

function setup(result: ControlResult = { ok: true, state: { micMuted: true } }) {
  const execute = vi.fn(async (_r: ControlRequest) => result);
  let now = 1_000_000;
  const handler = new ControlHttpHandler({ token: () => TOKEN, port: () => PORT, execute, now: () => now });
  const call = (over: Partial<ControlHttpRequest> & { token?: string | null } = {}) => {
    const { token, ...rest } = over;
    return handler.handle({
      method: "POST",
      url: "/v1/actions/mic.toggle",
      headers: { host: `127.0.0.1:${PORT}`, ...(token === null ? {} : { authorization: `Bearer ${token ?? TOKEN}` }) },
      remoteAddress: "127.0.0.1",
      body: "",
      ...rest,
    });
  };
  return { call, execute, tick: (ms: number) => void (now += ms) };
}

describe("token comparison", () => {
  it("compares in constant time on any length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("", TOKEN)).toBe(false);
    expect(safeEqual("a".repeat(5000), TOKEN)).toBe(false);
  });
});

describe("local checks", () => {
  it("recognises loopback peers and local origins only", () => {
    for (const a of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(a), a).toBe(true);
    for (const a of ["192.168.1.5", "10.0.0.1", "::ffff:10.0.0.1", "8.8.8.8", undefined]) expect(isLoopbackAddress(a), String(a)).toBe(false);
    for (const o of ["http://localhost:3000", "http://127.0.0.1:17420", "http://[::1]:8080"]) expect(isLocalOrigin(o), o).toBe(true);
    for (const o of ["https://evil.example", "http://localhost.evil.example", "null", "file://", "http://192.168.1.2", "http://127.0.0.1.evil.example"]) expect(isLocalOrigin(o), o).toBe(false);
  });
});

describe("control API: who may call", () => {
  it("refuses a peer that is not this computer, even with the token", async () => {
    const { call, execute } = setup();
    expect((await call({ remoteAddress: "192.168.1.20" })).status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a request addressed to another name or port (DNS rebinding)", async () => {
    const { call } = setup();
    expect((await call({ headers: { host: "evil.example", authorization: `Bearer ${TOKEN}` } })).body.code).toBe("bad_host");
    expect((await call({ headers: { host: `127.0.0.1:9999`, authorization: `Bearer ${TOKEN}` } })).body.code).toBe("bad_host");
    expect((await call({ headers: { authorization: `Bearer ${TOKEN}` } })).body.code).toBe("bad_host");
    expect((await call({ headers: { host: `localhost:${PORT}`, authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    expect((await call({ headers: { host: `[::1]:${PORT}`, authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
  });

  it("refuses a web page from another origin, and any cross-site fetch, even with the token", async () => {
    const { call, execute } = setup();
    const h = (extra: Record<string, string>) => ({ host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, ...extra });
    expect((await call({ headers: h({ origin: "https://evil.example" }) })).body.code).toBe("origin_refused");
    expect((await call({ headers: h({ origin: "null" }) })).status).toBe(403);
    expect((await call({ headers: h({ "sec-fetch-site": "cross-site" }) })).status).toBe(403);
    expect((await call({ headers: h({ "sec-fetch-site": "same-site" }) })).status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
    // A local page, and a plain client (no Origin at all: Stream Deck, Companion, curl), are fine.
    expect((await call({ headers: h({ origin: "http://localhost:3000" }) })).status).toBe(200);
    expect((await call({ headers: h({ "sec-fetch-site": "none" }) })).status).toBe(200);
  });
});

describe("control API: authentication", () => {
  it("refuses a missing or wrong token without running anything", async () => {
    const { call, execute } = setup();
    expect((await call({ token: null })).status).toBe(401);
    expect((await call({ token: "wrong" })).status).toBe(401);
    expect((await call({ token: TOKEN.slice(0, -1) })).status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("takes the token as a Bearer header, an X-Sada-Token header or a query parameter", async () => {
    const { call } = setup();
    expect((await call()).status).toBe(200);
    expect((await call({ token: null, headers: { host: `127.0.0.1:${PORT}`, "x-sada-token": TOKEN } })).status).toBe(200);
    expect((await call({ token: null, url: `/v1/actions/mic.toggle?token=${TOKEN}` })).status).toBe(200);
  });

  it("slows down guessing: too many failures lock the API for the window, then it recovers", async () => {
    const { call, tick } = setup();
    for (let i = 0; i < 20; i++) expect((await call({ token: "guess" })).status).toBe(401);
    const locked = await call({ token: "guess" });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers?.["Retry-After"])).toBeGreaterThan(0);
    expect((await call()).status).toBe(429); // even the right token waits
    tick(61_000);
    expect((await call()).status).toBe(200);
  });

  it("answers nothing about the actions before the token is checked", async () => {
    const { call } = setup();
    const unknown = await call({ url: "/v1/actions/nope", token: null });
    expect(unknown.status).toBe(401);
  });
});

describe("control API: routing", () => {
  it("lists the actions", async () => {
    const { call } = setup();
    const r = await call({ method: "GET", url: "/v1/actions" });
    expect(r.status).toBe(200);
    expect(r.body.actions).toContain("scene.next");
    expect((await call({ method: "DELETE", url: "/v1/actions" })).status).toBe(405);
  });

  it("runs an action and returns the state the window reports (POST and GET)", async () => {
    const { call, execute } = setup();
    expect(await call()).toMatchObject({ status: 200, body: { ok: true, state: { micMuted: true } } });
    expect((await call({ method: "GET", url: "/v1/actions/screen.toggle" })).status).toBe(200);
    expect(execute.mock.calls.map((c) => c[0])).toEqual([{ action: "mic.toggle" }, { action: "screen.toggle" }]);
  });

  it("routes every action to the service", async () => {
    const { call, execute } = setup();
    for (const a of ["mic.mute", "mic.unmute", "browser.toggle", "browser.show", "browser.hide", "screen.start", "screen.stop", "scene.next", "scene.previous"]) {
      expect((await call({ url: `/v1/actions/${a}` })).status, a).toBe(200);
    }
    expect(execute).toHaveBeenCalledTimes(9);
  });

  it("passes the scene of scene.set from the body or the query, and validates it", async () => {
    const { call, execute } = setup();
    await call({ url: "/v1/actions/scene.set", body: JSON.stringify({ scene: "avant" }) });
    await call({ method: "GET", url: "/v1/actions/scene.set?scene=priere" });
    expect(execute.mock.calls.map((c) => c[0])).toEqual([{ action: "scene.set", scene: "avant" }, { action: "scene.set", scene: "priere" }]);
    expect((await call({ url: "/v1/actions/scene.set" })).body.code).toBe("bad_scene");
    expect((await call({ url: "/v1/actions/scene.set", body: JSON.stringify({ scene: "../x" }) })).body.code).toBe("bad_scene");
    expect((await call({ url: "/v1/actions/mic.toggle", body: "{not json" })).body.code).toBe("bad_json");
  });

  it("answers 404 for an unknown action or address, and has no way to remove a source", async () => {
    const { call, execute } = setup();
    expect((await call({ url: "/v1/actions/browser.remove" })).status).toBe(404);
    expect((await call({ url: "/v1/other" })).status).toBe(404);
    expect((await call({ method: "PUT", url: "/v1/actions/mic.toggle" })).status).toBe(405);
    expect(execute).not.toHaveBeenCalled();
  });

  it("maps a failed action to a status the caller can act on", async () => {
    expect((await setup({ ok: false, code: "ui_unavailable", message: "x" }).call()).status).toBe(503);
    expect((await setup({ ok: false, code: "timeout", message: "x" }).call()).status).toBe(504);
    expect((await setup({ ok: false, code: "no_browser_source", message: "x" }).call()).status).toBe(409);
  });
});

describe("control API over a real socket", () => {
  let server: ControlServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  function send(port: number, headers: Record<string, string>, opts: { method?: string; path?: string; body?: string } = {}) {
    return new Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, unknown> }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, method: opts.method ?? "POST", path: opts.path ?? "/v1/actions/mic.toggle", headers }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown>, headers: res.headers }));
      });
      req.on("error", reject);
      req.end(opts.body);
    });
  }

  async function start() {
    const execute = vi.fn(async () => ({ ok: true } as ControlResult));
    server = new ControlServer((port) => new ControlHttpHandler({ token: () => TOKEN, port, execute }));
    const port = await server.start(0);
    return { port, execute };
  }

  it("listens on 127.0.0.1 only and runs an authorized action", async () => {
    const { port, execute } = await start();
    const addr = await send(port, { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` });
    expect(addr.status).toBe(200);
    expect(execute).toHaveBeenCalledWith({ action: "mic.toggle" });
    // Never reachable through another interface: the socket is bound to the loopback address.
    const { createConnection } = await import("node:net");
    const nonLoopback = await import("node:os").then((os) => Object.values(os.networkInterfaces()).flat().find((i) => i && !i.internal && i.family === "IPv4")?.address);
    if (nonLoopback) {
      const refused = await new Promise<boolean>((resolve) => {
        const s = createConnection({ host: nonLoopback, port }, () => (s.destroy(), resolve(false)));
        s.on("error", () => resolve(true));
      });
      expect(refused).toBe(true);
    }
  });

  it("refuses a foreign origin and a bad token over HTTP, and sends no CORS header", async () => {
    const { port, execute } = await start();
    const foreign = await send(port, { host: `127.0.0.1:${port}`, origin: "https://evil.example", authorization: `Bearer ${TOKEN}` });
    expect(foreign.status).toBe(403);
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();
    const rebind = await send(port, { host: `evil.example:${port}`, authorization: `Bearer ${TOKEN}` });
    expect(rebind.status).toBe(403);
    const bad = await send(port, { host: `127.0.0.1:${port}`, authorization: "Bearer nope" });
    expect(bad.status).toBe(401);
    const preflight = await send(port, { host: `127.0.0.1:${port}`, origin: "https://evil.example", "access-control-request-method": "POST" }, { method: "OPTIONS" });
    expect(preflight.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses an oversized body and reports a busy port", async () => {
    const { port } = await start();
    const big = await send(port, { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` }, { body: "x".repeat(5000) });
    expect(big.status).toBe(413);
    const second = new ControlServer((p) => new ControlHttpHandler({ token: () => TOKEN, port: p, execute: async () => ({ ok: true }) }));
    await expect(second.start(port)).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});
