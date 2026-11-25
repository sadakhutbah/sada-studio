import { describe, expect, it, vi } from "vitest";
import { SadaHttpApi } from "../src/core/api/sada-api";

const BASE = "https://sada.example";

function client(responses: unknown[]) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const queue = [...responses];
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), method: String(init.method), headers: init.headers as Record<string, string>, body: init.body as string | undefined });
    return new Response(JSON.stringify(queue.shift() ?? {}), { status: 200, headers: { "content-type": "application/json" } });
  });
  const api = new SadaHttpApi({ fetch: fetchFn as unknown as typeof fetch });
  api.useDevice({ baseUrl: BASE, deviceId: "d1", deviceSecret: "sdev_secret", mosque: { name: "M" } });
  return { api, calls };
}

describe("SadaHttpApi regie & overlays", () => {
  it("fetches the regie state, sends a scene command and updates an overlay, with the device credential", async () => {
    const overlays = {
      qr: { visible: true, url: "https://sada.example/don", label: "Don", corner: "br" },
      banner: { visible: false, title: "", subtitle: "" },
      logo: { visible: true },
    };
    const { api, calls } = client([
      { mosque: "Grande Mosquée", slug: "grande", status: { reachable: true, scene: "direct" }, commands: ["live"], extend_minutes: ["5"], overlays },
      { reachable: true, message: "OK" },
      { ok: true, overlays },
    ]);

    expect((await api.getRegie()).slug).toBe("grande");
    expect(calls[0]).toMatchObject({ method: "GET", url: `${BASE}/api/v1/studio/regie` });
    expect(calls[0]!.headers.Authorization).toBe("Bearer sdev_secret");

    expect((await api.sendLiveCommand("scene", "avant", "cut")).reachable).toBe(true);
    expect(calls[1]).toMatchObject({ method: "POST", url: `${BASE}/api/v1/studio/live/command` });
    expect(JSON.parse(calls[1]!.body ?? "{}")).toEqual({ command: "scene", arg: "avant", transition: "cut" });

    const r = await api.setLiveOverlay("qr", { visible: true, url: "https://sada.example/don", label: "Don", corner: "br" });
    expect(r.overlays.qr.corner).toBe("br");
    expect(calls[2]).toMatchObject({ method: "PATCH", url: `${BASE}/api/v1/studio/live/overlays/qr` });
  });

  it("refuses a regie call when the device is not paired", async () => {
    const api = new SadaHttpApi({ fetch: vi.fn() as unknown as typeof fetch });
    await expect(api.getRegie()).rejects.toThrow();
  });
});
