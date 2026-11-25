import { describe, expect, it } from "vitest";
import {
  computeBrowserSourceRect,
  isAllowedBrowserRequest,
  isReportableLoadFailure,
  isReportableLoadRejection,
  isPrivateOrLocalHost,
  DEFAULT_BROWSER_SOURCE,
  normalizeBrowserSourceConfig,
  validateBrowserSourceUrl,
} from "../src/core/sources/browser-source";

describe("validateBrowserSourceUrl", () => {
  it("accepts public http and https URLs and prefixes bare hosts with https://", () => {
    expect(validateBrowserSourceUrl("https://cagnotte.example/live")).toBe("https://cagnotte.example/live");
    expect(validateBrowserSourceUrl("http://cagnotte.example:8080/counter")).toBe("http://cagnotte.example:8080/counter");
    expect(validateBrowserSourceUrl("cagnotte.example/widget")).toBe("https://cagnotte.example/widget");
    expect(validateBrowserSourceUrl("cagnotte.example:8080/widget")).toBe("https://cagnotte.example:8080/widget");
    expect(validateBrowserSourceUrl("https://8.8.8.8/")).toBe("https://8.8.8.8/");
    expect(validateBrowserSourceUrl("https://[2606:4700:4700::1111]/")).toBe("https://[2606:4700:4700::1111]/");
  });

  it("rejects empty, overly long, or dangerous schemes", () => {
    expect(() => validateBrowserSourceUrl("   ")).toThrow();
    expect(() => validateBrowserSourceUrl("file:///etc/passwd")).toThrow();
    expect(() => validateBrowserSourceUrl("javascript:alert(1)")).toThrow();
    expect(() => validateBrowserSourceUrl("data:text/html,<h1>hi</h1>")).toThrow();
    expect(() => validateBrowserSourceUrl("ftp://cagnotte.example/")).toThrow();
    expect(() => validateBrowserSourceUrl(`https://example.com/${"a".repeat(2100)}`)).toThrow();
  });

  it.each([
    "http://localhost:3000/counter",
    "localhost",
    "https://app.localhost/",
    "http://127.0.0.1/",
    "http://127.255.255.254:8080/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[::]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://10.0.0.5/",
    "http://10.255.255.255/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.20/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://169.254.0.1/",
    "http://[fe80::1]/",
    "http://[febf::1]/",
    "http://[fc00::1]/",
    "http://[fd12:3456:789a::1]/",
    "http://100.64.0.1/",
    "http://2130706433/", // 127.0.0.1 written as one integer
    "http://0x7f.1/", // and in hexadecimal
    "http://017700000001/", // and in octal
    "https://printer.local/",
    "https://nas.internal/",
    "https://router/",
    "http://user:pass@127.0.0.1/",
  ])("refuses %s", (url) => {
    expect(() => validateBrowserSourceUrl(url)).toThrow();
  });

  it.each(["http://172.15.255.255/", "http://172.32.0.1/", "http://192.169.0.1/", "http://11.0.0.1/", "http://[2001:db8::1]/", "http://[2a00:1450::1]/x"])(
    "accepts the public neighbour %s",
    (url) => {
      expect(validateBrowserSourceUrl(url)).toContain("http://");
    },
  );
});

describe("isPrivateOrLocalHost", () => {
  it("judges bare IPs, bracketed IPv6 and names", () => {
    expect(isPrivateOrLocalHost("::1")).toBe(true);
    expect(isPrivateOrLocalHost("[fe80::abcd]")).toBe(true);
    expect(isPrivateOrLocalHost("fe80::1%eth0")).toBe(true);
    expect(isPrivateOrLocalHost("LOCALHOST.")).toBe(true);
    expect(isPrivateOrLocalHost("192.168.0.1")).toBe(true);
    expect(isPrivateOrLocalHost("93.184.216.34")).toBe(false);
    expect(isPrivateOrLocalHost("sadakhutbah.org")).toBe(false);
    expect(isPrivateOrLocalHost("")).toBe(true);
  });
});

describe("isAllowedBrowserRequest", () => {
  it("lets the page load public resources and inline content", () => {
    for (const u of ["https://cdn.example/app.js", "http://cagnotte.example/x", "wss://live.example/socket", "data:image/png;base64,AAAA", "blob:https://cagnotte.example/1", "about:blank"]) {
      expect(isAllowedBrowserRequest(u), u).toBe(true);
    }
  });

  it("blocks private hosts (also reached by a redirect or a sub-resource), local files and other schemes", () => {
    for (const u of [
      "http://127.0.0.1:9229/json",
      "https://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "ws://localhost:8080/",
      "file:///home/nabil/.ssh/id_ed25519",
      "ftp://cagnotte.example/",
      "chrome://gpu",
      "devtools://devtools/bundled/inspector.html",
      "about:srcdoc",
      "not a url",
    ]) {
      expect(isAllowedBrowserRequest(u), u).toBe(false);
    }
  });
});

describe("computeBrowserSourceRect", () => {
  it("covers the entire canvas in fullscreen mode", () => {
    const rect = computeBrowserSourceRect(1280, 720, { mode: "fullscreen", corner: "br", size: "md" });
    expect(rect).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
  });

  it("places overlay inside each corner with increasing size presets", () => {
    const sm = computeBrowserSourceRect(1280, 720, { mode: "overlay", corner: "tl", size: "sm" });
    const md = computeBrowserSourceRect(1280, 720, { mode: "overlay", corner: "tr", size: "md" });
    const lg = computeBrowserSourceRect(1280, 720, { mode: "overlay", corner: "br", size: "lg" });
    const bl = computeBrowserSourceRect(1280, 720, { mode: "overlay", corner: "bl", size: "md" });

    expect(sm.width).toBeLessThan(md.width);
    expect(md.width).toBeLessThan(lg.width);
    expect(sm.x).toBeGreaterThan(0);
    expect(sm.y).toBeGreaterThan(0);
    expect(md.x + md.width).toBeLessThan(1280);
    expect(lg.x + lg.width).toBeLessThan(1280);
    expect(lg.y + lg.height).toBeLessThan(720);
    expect(bl.x).toBe(sm.x);
    expect(bl.y + bl.height).toBe(lg.y + lg.height);
  });
});

describe("normalizeBrowserSourceConfig", () => {
  it("falls back to defaults for missing or invalid values", () => {
    expect(normalizeBrowserSourceConfig(undefined)).toEqual(DEFAULT_BROWSER_SOURCE);
    expect(
      normalizeBrowserSourceConfig({
        url: "https://sada.example",
        visible: true,
        mode: "fullscreen",
        corner: "tl",
        size: "lg",
      }),
    ).toEqual({
      url: "https://sada.example",
      visible: true,
      mode: "fullscreen",
      corner: "tl",
      size: "lg",
    });
  });
});

describe("load failure reporting", () => {
  it("ignores sub-frame failures and cancelled loads (ERR_ABORTED -3), keeps real main-frame failures", () => {
    expect(isReportableLoadFailure(-105, true)).toBe(true);
    expect(isReportableLoadFailure(-105, false)).toBe(false);
    expect(isReportableLoadFailure(-3, true)).toBe(false);
  });

  it("ignores a loadURL rejection caused by a cancelled load", () => {
    expect(isReportableLoadRejection(Object.assign(new Error("ERR_ABORTED (-3) loading 'https://x.example/'"), { errno: -3, code: "ERR_ABORTED" }))).toBe(false);
    expect(isReportableLoadRejection(new Error("ERR_ABORTED (-3) loading 'https://x.example/'"))).toBe(false);
    expect(isReportableLoadRejection(Object.assign(new Error("ERR_NAME_NOT_RESOLVED (-105) loading"), { errno: -105 }))).toBe(true);
    expect(isReportableLoadRejection("boom")).toBe(true);
  });
});
