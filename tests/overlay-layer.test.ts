import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/core/errors";
import { SadaHttpApi } from "../src/core/api/sada-api";
import type { LiveOverlays } from "../src/core/api/types";
import { getLocale, setLocale, t } from "../src/core/messages";
import { LAYER_FAILURES_TO_FALLBACK, layerMode, overlaysKey } from "../src/core/setup/overlay-layer";

const BASE = "https://sada.example";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

type Canned = { status: number; body?: BodyInit | null; headers?: Record<string, string> };

function api(responses: Canned[]) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const queue = [...responses];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string> });
    const r = queue.shift();
    if (!r) throw new TypeError("network down");
    return new Response(r.body ?? null, { status: r.status, headers: r.headers });
  });
  const a = new SadaHttpApi({ fetch: fetchFn as unknown as typeof fetch });
  a.useDevice({ baseUrl: BASE, deviceId: "d1", deviceSecret: "sdev_secret", mosque: { name: "M" } });
  return { a, calls };
}

const overlays = (over: Partial<LiveOverlays> = {}): LiveOverlays => ({
  qr: { visible: false, url: "", label: "", corner: "tr" },
  banner: { visible: false, title: "", subtitle: "" },
  logo: { visible: false },
  ...over,
});

describe("overlay layer: client", () => {
  it("fetches the PNG with the device identity, then revalidates with its ETag (304: unchanged)", async () => {
    const { a, calls } = api([
      { status: 200, body: PNG, headers: { "content-type": "image/png", etag: '"ov-1"' } },
      { status: 304, headers: { etag: '"ov-1"' } },
    ]);
    const first = await a.getOverlayLayer(null);
    expect(first).toEqual({ changed: true, etag: '"ov-1"', png: PNG });
    expect(calls[0].url).toBe(`${BASE}/api/v1/live/regie/overlays.png`);
    expect(calls[0].headers.Authorization).toBe("Bearer sdev_secret");
    expect(calls[0].headers["If-None-Match"]).toBeUndefined();

    expect(await a.getOverlayLayer('"ov-1"')).toEqual({ changed: false });
    expect(calls[1].headers["If-None-Match"]).toBe('"ov-1"');
  });

  it("asks for the rehearsal's layer while the setup view is open", async () => {
    const { a, calls } = api([
      { status: 200, body: JSON.stringify({ active: true, orchestrator: "ready" }), headers: { "content-type": "application/json" } },
      { status: 200, body: PNG, headers: { "content-type": "image/png", etag: '"ov-2"' } },
    ]);
    await a.setup.enter();
    await a.getOverlayLayer(null);
    expect(calls[1].url).toBe(`${BASE}/api/v1/live/regie/overlays.png?setup=1`);
  });

  it("rejects when the engine is down, the server unreachable or the answer is not a PNG", async () => {
    const prev = getLocale();
    setLocale("en");
    try {
      const { a } = api([
        { status: 503, body: JSON.stringify({ error: "engine unreachable", code: "offline" }), headers: { "content-type": "application/json" } },
        { status: 200, body: "<html>", headers: { "content-type": "text/html" } },
      ]);
      await expect(a.getOverlayLayer(null)).rejects.toMatchObject({ status: 503 });
      await expect(a.getOverlayLayer(null)).rejects.toBeInstanceOf(ApiError);
      // nothing queued: the fetch itself fails
      await expect(a.getOverlayLayer(null)).rejects.toMatchObject({ status: 0, message: t("api.unreachable") });
    } finally {
      setLocale(prev);
    }
  });
});

describe("overlay layer: display mode", () => {
  it("shows the server image once there is one, and keeps it through a single failed refresh", () => {
    expect(layerMode(false, 0)).toBe("pending");
    expect(layerMode(true, 0)).toBe("server");
    expect(layerMode(true, 1)).toBe("server");
  });

  it("falls back to the local approximation when the server does not answer", () => {
    expect(layerMode(false, 1)).toBe("fallback");
    expect(layerMode(true, LAYER_FAILURES_TO_FALLBACK)).toBe("fallback");
  });

  it("changes key with any drawn overlay field, so a change on air refetches at once", () => {
    const base = overlays();
    const k = overlaysKey(base);
    expect(overlaysKey(overlays())).toBe(k);
    expect(overlaysKey(overlays({ logo: { visible: true } }))).not.toBe(k);
    expect(overlaysKey(overlays({ qr: { ...base.qr, corner: "bl" } }))).not.toBe(k);
    expect(overlaysKey(overlays({ banner: { visible: false, title: "x", subtitle: "" } }))).not.toBe(k);
    expect(overlaysKey(null)).toBe("");
  });

  it("has its fallback notice in French and English", () => {
    const prev = getLocale();
    try {
      setLocale("fr");
      const fr = t("overlayLayer.fallback");
      setLocale("en");
      expect(t("overlayLayer.fallback")).not.toBe(fr);
      expect(fr).toMatch(/serveur/);
    } finally {
      setLocale(prev);
    }
  });
});
