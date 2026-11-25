import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/core/errors";
import { SadaHttpApi, normalizeSetup } from "../src/core/api/sada-api";
import type { SetupState } from "../src/core/api/types";
import { getLocale, setLocale, t } from "../src/core/messages";
import { WhepPlayer } from "../src/core/transport/whep";
import { IDLE_LIMIT_MS, PHASE_MESSAGE, badge, isIdle, renewDelayMs, retryDelayMs, setupPhase, shouldPlay } from "../src/core/setup/view";
import { FakePeer } from "./helpers";

const BASE = "https://sada.example";
const ready: SetupState = { active: true, expiresIn: 90, orchestrator: "ready", live: false, rehearsing: true, available: true, program: true };

function api(responses: Array<{ status?: number; json?: unknown; text?: string; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; method: string; body: string | undefined; headers: Record<string, string> }> = [];
  const queue = [...responses];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), method: String(init.method), body: init.body as string | undefined, headers: init.headers as Record<string, string> });
    const r = queue.shift() ?? {};
    const status = r.status ?? 200;
    const isJson = r.json !== undefined;
    const headers: Record<string, string> = { ...r.headers };
    if (isJson) headers["content-type"] = "application/json";
    return new Response(isJson ? JSON.stringify(r.json) : (r.text ?? ""), { status, headers });
  });
  const a = new SadaHttpApi({ fetch: fetchFn as unknown as typeof fetch });
  a.useDevice({ baseUrl: BASE, deviceId: "d1", deviceSecret: "sdev_secret", mosque: { name: "M" } });
  return { a, calls };
}

describe("setup mode: client", () => {
  it("normalizes the server answer leniently", () => {
    expect(normalizeSetup({ active: true, expires_in: 88, orchestrator: "ready", live: true, rehearsing: false, available: true, program: false })).toEqual({
      active: true, expiresIn: 88, orchestrator: "ready", live: true, rehearsing: false, available: true, program: false,
    });
    // unknown orchestrator state is "waking", a missing program is unknown (null), nothing throws
    expect(normalizeSetup({ orchestrator: "weird" })).toMatchObject({ active: false, orchestrator: "waking", program: null, available: true });
    expect(normalizeSetup(null).orchestrator).toBe("waking");
  });

  it("enter marks the Régie calls as setup only once the server accepted, leave takes the mark off", async () => {
    const { a: b, calls: c } = api([
      { json: { active: true, expires_in: 90, orchestrator: "waking" } },
      { json: {} },
      { json: {} },
      { json: { active: false } },
      { json: {} },
    ]);
    const state = await b.setup.enter(); // nothing is marked before the server accepted the mode
    expect(state).toMatchObject({ active: true, orchestrator: "waking" });
    expect(c[0]).toMatchObject({ method: "POST", url: `${BASE}/api/v1/studio/setup`, body: JSON.stringify({ on: true }) });
    expect(c[0].headers.Authorization).toBe("Bearer sdev_secret");
    await b.getLiveStatus();
    expect(c[1].url).toBe(`${BASE}/api/v1/studio/live/status?setup=1`);
    await b.sendLiveCommand("scene", "priere", "cut");
    expect(JSON.parse(c[2].body ?? "{}")).toEqual({ command: "scene", arg: "priere", transition: "cut", setup: true });
    await b.setup.leave();
    expect(JSON.parse(c[3].body ?? "{}")).toEqual({ on: false });
    await b.getLiveStatus();
    expect(c[4].url).toBe(`${BASE}/api/v1/studio/live/status`); // the live is addressed again
  });

  it("an enter() answered after leave() is ignored: the live stays addressed", async () => {
    const queue: Array<(r: Response) => void> = [];
    const calls: string[] = [];
    const fetchFn = vi.fn((url: string) => {
      calls.push(String(url));
      return new Promise<Response>((resolve) => queue.push(resolve));
    });
    const a = new SadaHttpApi({ fetch: fetchFn as unknown as typeof fetch });
    a.useDevice({ baseUrl: BASE, deviceId: "d1", deviceSecret: "sdev_secret", mosque: { name: "M" } });
    const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    const entering = a.setup.enter();
    const leaving = a.setup.leave();
    queue[1]!(json({ active: false })); // leave answered first
    await leaving;
    queue[0]!(json({ active: true, expires_in: 90, orchestrator: "ready" })); // the stale enter comes back late
    await expect(entering).rejects.toMatchObject({ code: "setup_stale" });
    const status = a.getLiveStatus();
    expect(calls.at(-1)).toBe(`${BASE}/api/v1/studio/live/status`); // no ?setup=1
    queue[2]!(json({}));
    await status;
  });

  it("a second enter() after leave() works normally", async () => {
    const { a, calls } = api([{ json: { active: true } }, { json: {} }, { json: { active: true } }, { json: {} }]);
    await a.setup.enter();
    await a.setup.leave();
    await a.setup.enter();
    await a.getLiveStatus();
    expect(calls[3].url).toBe(`${BASE}/api/v1/studio/live/status?setup=1`);
  });

  it("marks overlays, mute and transition too, and nothing when the mode is closed", async () => {
    const { a, calls } = api([{ json: { active: true, orchestrator: "ready" } }, {}, {}, {}, {}, {}, {}].map((r) => ({ json: r })) as never);
    await a.setLiveOverlay("qr", { visible: false });
    expect(JSON.parse(calls[0].body ?? "{}")).toEqual({ visible: false });
    await a.setup.enter();
    await a.setLiveOverlay("banner", { visible: true, title: "x" });
    await a.setMute(true);
    await a.setTransition("cut");
    expect(JSON.parse(calls[2].body ?? "{}")).toEqual({ visible: true, title: "x", setup: true });
    expect(JSON.parse(calls[3].body ?? "{}")).toEqual({ muted: true, setup: true });
    expect(JSON.parse(calls[4].body ?? "{}")).toEqual({ mode: "cut", setup: true });
  });

  it("a lapsed lease (409 setup_off) is a distinct error, not a 'live already running'", async () => {
    const { a } = api([{ status: 409, json: { error: "setup mode is not active", code: "setup_off" } }]);
    const e = await a.sendLiveCommand("scene", "avant").catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 409, code: "setup_off" });
    expect(e.message).toBe(t("setup.lapsed"));
  });

  it("WHEP offer: application/sdp with the device credential, Location kept on the instance only", async () => {
    const { a, calls } = api([
      { status: 201, text: "v=0 answer", headers: { location: "/api/v1/studio/setup/whep/abc-123" } },
      { status: 200 },
      { status: 201, text: "x", headers: { location: "https://evil.example/whep/1" } },
    ]);
    const r = await a.setup.whepOffer("v=0 offer");
    expect(r).toEqual({ answer: "v=0 answer", resource: "/api/v1/studio/setup/whep/abc-123" });
    expect(calls[0]).toMatchObject({ method: "POST", url: `${BASE}/api/v1/studio/setup/whep`, body: "v=0 offer" });
    expect(calls[0].headers["Content-Type"]).toBe("application/sdp");
    expect(calls[0].headers.Authorization).toBe("Bearer sdev_secret");
    await a.setup.whepClose(r.resource);
    expect(calls[1]).toMatchObject({ method: "DELETE", url: `${BASE}/api/v1/studio/setup/whep/abc-123` });
    await expect(a.setup.whepOffer("o")).rejects.toMatchObject({ status: 502 }); // the secret never goes elsewhere
  });

  it("WHEP offline (404) surfaces as an ApiError the player retries on", async () => {
    const { a } = api([{ status: 404, json: { error: "offline" } }]);
    await expect(a.setup.whepOffer("o")).rejects.toMatchObject({ status: 404, message: "offline" });
  });
});

describe("setup mode: what the view says", () => {
  const on = { wanted: true, error: null, playing: false } as const;
  it.each([
    [{ ...on, wanted: false, state: null }, "off"],
    [{ ...on, state: null }, "entering"],
    [{ ...on, state: null, error: "server" as const }, "serverDown"],
    [{ ...on, state: ready, error: "lapsed" as const }, "lapsed"],
    [{ ...on, state: { ...ready, orchestrator: "waking" as const } }, "waking"],
    [{ ...on, state: { ...ready, orchestrator: "unreachable" as const } }, "unreachable"],
    [{ ...on, state: { ...ready, available: false } }, "unavailable"],
    [{ ...on, state: ready }, "starting"],
    [{ ...on, state: ready, playing: true }, "watching"],
    [{ ...on, state: { ...ready, live: true }, playing: true }, "watching"], // a live on air: same view, other badge
  ])("%j -> %s", (input, phase) => {
    expect(setupPhase(input)).toBe(phase);
  });

  it("a renewal that fails while a state is known keeps showing that state (no flicker to an error)", () => {
    expect(setupPhase({ wanted: true, state: { ...ready, orchestrator: "waking" }, error: "server", playing: false })).toBe("waking");
  });

  it("asks the relay for the picture only once the orchestrator answers", () => {
    const plays = (["off", "entering", "serverDown", "lapsed", "waking", "unreachable", "unavailable", "starting", "watching"] as const).filter(shouldPlay);
    expect(plays).toEqual(["starting", "watching"]);
  });

  it("every waiting phase has a message in French and English, the picture phase none", () => {
    for (const locale of ["fr", "en"] as const) {
      setLocale(locale);
      for (const [phase, key] of Object.entries(PHASE_MESSAGE)) {
        if (phase === "off" || phase === "watching") expect(key).toBeNull();
        else expect(t(key!)).not.toMatch(/^setup\./);
      }
      expect(t(badge(ready))).not.toBe(t(badge({ ...ready, live: true })));
    }
    setLocale("fr");
    expect(getLocale()).toBe("fr");
  });

  it("badge tells a rehearsal from the real broadcast", () => {
    expect(badge(ready)).toBe("setup.badge.rehearsal");
    expect(badge({ ...ready, live: true })).toBe("setup.badge.live");
    expect(badge(null)).toBe("setup.badge.rehearsal");
  });

  it("renews quickly while waiting and calmly once the picture plays; retries grow but stay bounded", () => {
    expect(renewDelayMs("waking")).toBeLessThan(renewDelayMs("watching"));
    expect([0, 1, 2, 3, 10].map(retryDelayMs)).toEqual([1500, 3000, 6000, 10000, 10000]);
  });

  it("closes by itself after the idle limit", () => {
    expect(isIdle(1000, 1000 + IDLE_LIMIT_MS - 1, IDLE_LIMIT_MS)).toBe(false);
    expect(isIdle(1000, 1000 + IDLE_LIMIT_MS, IDLE_LIMIT_MS)).toBe(true);
  });
});

describe("WhepPlayer", () => {
  const peer = () => {
    const p = new FakePeer() as FakePeer & { ontrack: unknown };
    p.ontrack = null;
    return p;
  };
  const signaling = (over: Partial<{ offer: () => Promise<{ answer: string; resource: string }>; close: (r: string) => Promise<void> }> = {}) => ({
    offer: vi.fn(async () => ({ answer: "v=0\r\nanswer\r\n", resource: "/api/v1/studio/setup/whep/s1" })),
    close: vi.fn(async () => undefined),
    ...over,
  });

  it("negotiates one receive-only offer and closes the resource", async () => {
    const p = peer();
    const sig = signaling();
    const player = new WhepPlayer({ signaling: sig, createPeer: () => p as unknown as RTCPeerConnection });
    await player.connect();
    expect(sig.offer).toHaveBeenCalledWith("v=0\r\noffer\r\n");
    expect(p.remote?.sdp).toBe("v=0\r\nanswer\r\n");
    await player.close();
    expect(sig.close).toHaveBeenCalledWith("/api/v1/studio/setup/whep/s1");
    expect(p.closed).toBe(true);
  });

  it("nothing published yet: the signaling error comes out and the peer is released", async () => {
    const p = peer();
    const sig = signaling({ offer: async () => Promise.reject(new ApiError(404, "offline")) });
    const player = new WhepPlayer({ signaling: sig, createPeer: () => p as unknown as RTCPeerConnection });
    await expect(player.connect()).rejects.toMatchObject({ status: 404 });
    expect(p.closed).toBe(true);
    expect(sig.close).not.toHaveBeenCalled(); // no resource was ever opened
  });

  it("reports a lost link once, after the grace delay for a disconnection", async () => {
    const p = peer();
    const player = new WhepPlayer({ signaling: signaling(), createPeer: () => p as unknown as RTCPeerConnection, disconnectGraceMs: 20 });
    const lost = vi.fn();
    player.onLost(lost);
    await player.connect();
    p.setState("disconnected");
    p.setState("connected"); // it came back by itself: no report
    await new Promise((r) => setTimeout(r, 40));
    expect(lost).not.toHaveBeenCalled();
    p.setState("failed");
    p.setState("failed");
    expect(lost).toHaveBeenCalledTimes(1);
  });
});
