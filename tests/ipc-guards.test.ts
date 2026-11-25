import { describe, expect, it } from "vitest";
import { isDesktopSourceId, isResourcePath, parseBrowserSourceUrl, parseOverlay, parseRegieCommand } from "../src/main/ipc-guards";

describe("isResourcePath", () => {
  it.each(["/api/v1/live/studio/whip/sess-1", "/api/v1/studio/setup/whep/abc-123"])("accepts %s", (p) => {
    expect(isResourcePath(p)).toBe(true);
  });
  it.each([
    "/api/v1/studio/unpair",
    "/api/v1/studio/live/overlays/qr",
    "/api/v1/live/",
    "/api/v1/live/../studio/unpair",
    "/api/v1/live/%2e%2e/x",
    "/api/v1/live/x?y=1",
    "//evil.example/api/v1/live/x",
    "https://evil.example/api/v1/live/x",
    "api/v1/live/x",
    "",
    42,
    null,
  ])("refuses %j", (p) => {
    expect(isResourcePath(p)).toBe(false);
  });
});

describe("parseRegieCommand", () => {
  it("accepts the commands the UI sends", () => {
    expect(parseRegieCommand("scene", "priere", "cut")).toEqual({ cmd: "scene", arg: "priere", transition: "cut" });
    expect(parseRegieCommand("janaza", undefined, "fade")).toEqual({ cmd: "janaza", transition: "fade" });
    expect(parseRegieCommand("auto", undefined, undefined)).toEqual({ cmd: "auto" });
  });
  it("refuses unknown commands, a missing scene and bad arguments", () => {
    expect(parseRegieCommand("stop", undefined, undefined)).toBeNull();
    expect(parseRegieCommand("scene", undefined, undefined)).toBeNull();
    expect(parseRegieCommand("scene", "../x", undefined)).toBeNull();
    expect(parseRegieCommand("scene", "a", "wipe")).toBeNull();
    expect(parseRegieCommand({}, "a", "cut")).toBeNull();
  });
});

describe("parseOverlay", () => {
  it("keeps exactly the known fields", () => {
    expect(parseOverlay("logo", { visible: true, extra: 1 })).toEqual({ kind: "logo", payload: { visible: true } });
    expect(parseOverlay("banner", { visible: true, title: "t", subtitle: "s", x: 1 })?.payload).toEqual({ visible: true, title: "t", subtitle: "s" });
    expect(parseOverlay("qr", { visible: false, url: "https://a.b", label: "l", corner: "br" })?.payload).toEqual({
      visible: false, url: "https://a.b", label: "l", corner: "br",
    });
  });
  it("refuses unknown kinds, bad types and over-long fields", () => {
    expect(parseOverlay("../x", { visible: true })).toBeNull();
    expect(parseOverlay("logo", null)).toBeNull();
    expect(parseOverlay("logo", { visible: "yes" })).toBeNull();
    expect(parseOverlay("banner", { visible: true, title: "x".repeat(121), subtitle: "" })).toBeNull();
    expect(parseOverlay("qr", { visible: true, url: "u", label: "l", corner: "center" })).toBeNull();
  });
});

describe("parseBrowserSourceUrl", () => {
  it("returns the normalized public address", () => {
    expect(parseBrowserSourceUrl("cagnotte.example/widget")).toBe("https://cagnotte.example/widget");
  });
  it.each(["http://127.0.0.1:8080/", "http://localhost/", "http://192.168.1.1/", "http://169.254.169.254/", "http://[fd00::1]/", "file:///etc/passwd", "", 42, null, { href: "https://a.example" }])(
    "refuses %j",
    (v) => {
      expect(() => parseBrowserSourceUrl(v)).toThrow();
    },
  );
});

describe("isDesktopSourceId", () => {
  it.each(["screen:0:0", "window:1234:0", "screen:1:0"])("accepts %s", (id) => {
    expect(isDesktopSourceId(id)).toBe(true);
  });
  it.each(["", "screen", "file:///x", "window:../../x", "screen:0:0\n", "x".repeat(100), `window:${"1".repeat(80)}`, null, 3, { id: "screen:0:0" }])("refuses %j", (id) => {
    expect(isDesktopSourceId(id)).toBe(false);
  });
});
