import { describe, expect, it, vi } from "vitest";
import { lockDownBrowserSession } from "../src/main/browser-source";

type Before = (details: { url: string }, cb: (r: { cancel?: boolean }) => void) => void | Promise<void>;

function fakeSession() {
  const s = {
    permissionRequest: null as null | ((wc: unknown, p: string, cb: (ok: boolean) => void) => void),
    permissionCheck: null as null | (() => boolean),
    device: null as null | (() => boolean),
    display: null as null | ((r: unknown, cb: (s: object) => void) => void),
    before: null as null | Before,
    setPermissionRequestHandler(h: never) {
      s.permissionRequest = h;
    },
    setPermissionCheckHandler(h: never) {
      s.permissionCheck = h;
    },
    setDevicePermissionHandler(h: never) {
      s.device = h;
    },
    setDisplayMediaRequestHandler(h: never) {
      s.display = h;
    },
    webRequest: {
      onBeforeRequest(h: Before) {
        s.before = h;
      },
    },
  };
  return s;
}

const verdict = (s: ReturnType<typeof fakeSession>, url: string) =>
  new Promise<boolean>((resolve) => void s.before!({ url }, (r) => resolve(!r.cancel)));

describe("web source session lock-down", () => {
  it.each(["media", "display-capture", "geolocation", "notifications", "clipboard-read", "midi", "hid", "usb"])("denies the %s permission", (permission) => {
    const s = fakeSession();
    lockDownBrowserSession(s as never, async () => ["93.184.216.34"]);
    const answer = vi.fn();
    s.permissionRequest!(null, permission, answer);
    expect(answer).toHaveBeenCalledWith(false);
    expect(s.permissionCheck!()).toBe(false);
    expect(s.device!()).toBe(false);
  });

  it("answers no stream to a screen-capture request of the page", () => {
    const s = fakeSession();
    lockDownBrowserSession(s as never, async () => []);
    const answer = vi.fn();
    s.display!({}, answer);
    expect(answer).toHaveBeenCalledWith({});
  });

  it("lets public pages through and cancels private hosts, schemes outside http(s), and names that resolve to private addresses", async () => {
    const s = fakeSession();
    const dns: Record<string, string[]> = {
      "cdn.example": ["93.184.216.34"],
      "rebind.example": ["93.184.216.34", "127.0.0.1"],
      "intranet.example": ["10.1.2.3"],
    };
    lockDownBrowserSession(s as never, async (h) => dns[h] ?? ["93.184.216.34"]);
    expect(await verdict(s, "https://cdn.example/app.js")).toBe(true);
    expect(await verdict(s, "data:image/png;base64,AAAA")).toBe(true);
    expect(await verdict(s, "http://127.0.0.1:9229/json")).toBe(false);
    expect(await verdict(s, "https://192.168.0.1/")).toBe(false);
    expect(await verdict(s, "file:///etc/passwd")).toBe(false);
    expect(await verdict(s, "https://rebind.example/")).toBe(false);
    expect(await verdict(s, "https://intranet.example/")).toBe(false);
  });

  it("refuses when the name cannot be resolved", async () => {
    const s = fakeSession();
    lockDownBrowserSession(s as never, async () => {
      throw new Error("ENOTFOUND");
    });
    expect(await verdict(s, "https://nowhere.example/")).toBe(false);
  });
});
