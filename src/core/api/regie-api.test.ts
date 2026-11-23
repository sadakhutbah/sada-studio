import { describe, it, expect, vi, afterEach } from "vitest";
import { SadaApiClient } from "./sada-api";

describe("SadaApiClient regie & overlays", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches regie state, sends scene command, and updates overlays", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          mosque: "Grande Mosquée",
          slug: "grande",
          status: { reachable: true, scene: "direct" },
          commands: ["live", "before", "auto"],
          extend_minutes: ["5", "15"],
          overlays: {
            qr: { visible: false, url: "", label: "", corner: "tr" },
            banner: { visible: false, title: "", subtitle: "" },
            logo: { visible: false },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ reachable: true, message: "OK" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          overlays: {
            qr: { visible: true, url: "https://sada.example/don", label: "Don", corner: "br" },
            banner: { visible: false, title: "", subtitle: "" },
            logo: { visible: true },
          },
        }),
      });

    const client = new SadaApiClient("https://sada.example", mockFetch as unknown as typeof fetch);

    const regie = await client.getRegie("tok-123");
    expect(regie.slug).toBe("grande");
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "https://sada.example/api/live/regie",
      expect.objectContaining({ method: "GET" })
    );

    const cmdRes = await client.sendLiveCommand("tok-123", "before");
    expect(cmdRes.reachable).toBe(true);
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "https://sada.example/api/live/command/before",
      expect.objectContaining({ method: "POST" })
    );

    const ovRes = await client.setLiveOverlay("tok-123", "qr", {
      visible: true,
      url: "https://sada.example/don",
      label: "Don",
      corner: "br",
    });
    expect(ovRes.ok).toBe(true);
    expect(ovRes.overlays.qr.corner).toBe("br");
    expect(mockFetch).toHaveBeenNthCalledWith(
      3,
      "https://sada.example/api/live/overlays/qr",
      expect.objectContaining({ method: "PUT" })
    );
  });
});
