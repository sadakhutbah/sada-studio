import { describe, expect, it, vi } from "vitest";
import { resolveUpdateFeed } from "../src/core/kiosk/update-feed";
import { UpdateGate } from "../src/core/kiosk/update-gate";

describe("update feed override", () => {
  it("keeps the built-in feed when nothing is configured", () => {
    expect(resolveUpdateFeed({ env: {}, file: undefined })).toBeNull();
    expect(resolveUpdateFeed({ env: {}, file: "garbage" })).toBeNull();
  });
  it("prefers the environment over update.json", () => {
    const feed = resolveUpdateFeed({
      env: { SADA_STUDIO_UPDATE_URL: "https://a.example/studio/", SADA_STUDIO_UPDATE_CHANNEL: "beta" },
      file: { url: "https://b.example/", channel: "latest" },
    });
    expect(feed).toEqual({ url: "https://a.example/studio/", channel: "beta", source: "environment" });
  });
  it("reads update.json and defaults to the stable channel", () => {
    expect(resolveUpdateFeed({ env: {}, file: { url: "https://b.example/x/" } })).toEqual({ url: "https://b.example/x/", channel: "latest", source: "file" });
  });
  it("accepts http only on loopback and rejects bad channels", () => {
    expect(resolveUpdateFeed({ env: { SADA_STUDIO_UPDATE_URL: "http://127.0.0.1:8099/" }, file: undefined })?.url).toBe("http://127.0.0.1:8099/");
    expect(resolveUpdateFeed({ env: { SADA_STUDIO_UPDATE_URL: "http://evil.example/" }, file: undefined })).toBeNull();
    expect(resolveUpdateFeed({ env: { SADA_STUDIO_UPDATE_URL: "https://a.example/", SADA_STUDIO_UPDATE_CHANNEL: "../x" }, file: undefined })?.channel).toBe("latest");
  });
});

describe("UpdateGate download progress", () => {
  it("reports progress without ever installing, then installs once downloaded", () => {
    const install = vi.fn();
    const gate = new UpdateGate({ context: () => ({ sessionActive: false, wantLive: false, nextSlotAt: null, slotRunning: false }), install });
    gate.onProgress("0.2.0", 42.4);
    expect(gate.status).toEqual({ version: "0.2.0", waiting: "", downloading: 42 });
    gate.check();
    expect(install).not.toHaveBeenCalled();
    gate.onDownloaded("0.2.0");
    expect(install).toHaveBeenCalledTimes(1);
    gate.dispose();
  });
});

describe("dev Electron bundle branding", () => {
  it("renames CFBundleName and adds CFBundleDisplayName", async () => {
    const { brandPlist } = (await import("../scripts/brand-dev-electron.mjs")) as { brandPlist: (x: string, n: string) => string };
    const xml = "<dict>\n\t<key>CFBundleName</key>\n\t<string>Electron</string>\n</dict>";
    const out = brandPlist(xml, "Sada Studio");
    expect(out).toContain("<key>CFBundleName</key>\n\t<string>Sada Studio</string>");
    expect(out).toContain("<key>CFBundleDisplayName</key>\n\t<string>Sada Studio</string>");
    expect(brandPlist(out, "Sada Studio")).toBe(out);
  });
});
