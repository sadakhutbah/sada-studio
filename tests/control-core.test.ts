import { afterEach, describe, expect, it, vi } from "vitest";
import { acceleratorFromKeyEvent, normalizeAccelerator } from "../src/core/control/accelerator";
import { isSceneAction, normalizeControlResult, parseControlRequest, SHORTCUT_ACTIONS, type ControlRequest } from "../src/core/control/actions";
import { RendererLink } from "../src/core/control/renderer-link";
import { commandFor, pickScene } from "../src/core/control/scenes";
import { ControlService } from "../src/core/control/service";
import { DEFAULT_API_PORT, DEFAULT_SHORTCUTS, normalizeControlSettings, parseShortcutChange } from "../src/core/control/settings";
import { ShortcutRegistry, type ShortcutBackend } from "../src/core/control/shortcuts";

describe("normalizeAccelerator", () => {
  it("writes an accepted accelerator in canonical form", () => {
    expect(normalizeAccelerator("ctrl+alt+m")).toBe("Control+Alt+M");
    expect(normalizeAccelerator("shift+cmdorctrl+f5")).toBe("CommandOrControl+Shift+F5");
    expect(normalizeAccelerator("Alt+left")).toBe("Alt+Left");
  });

  it("refuses what could hijack ordinary typing or is not an accelerator", () => {
    for (const bad of ["M", "Shift+M", "F5", "", "Ctrl+", "Ctrl+Alt", "Ctrl+Alt+M+N", "Ctrl+Ctrl+M", "Ctrl+Win+M", "Ctrl+Escape", "Ctrl+Tab", "CommandOrControl+Control+M", "Ctrl+F25", 42, null]) {
      expect(normalizeAccelerator(bad), String(bad)).toBeNull();
    }
  });
});

describe("acceleratorFromKeyEvent", () => {
  const ev = (code: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

  it("builds the accelerator from the physical key, whatever the layout or Shift", () => {
    expect(acceleratorFromKeyEvent(ev("KeyM", { ctrlKey: true, altKey: true }), false)).toBe("CommandOrControl+Alt+M");
    expect(acceleratorFromKeyEvent(ev("Digit3", { ctrlKey: true, shiftKey: true }), false)).toBe("CommandOrControl+Shift+3");
    expect(acceleratorFromKeyEvent(ev("ArrowRight", { altKey: true }), false)).toBe("Alt+Right");
  });

  it("maps Command to CommandOrControl on macOS and the Windows key to Super elsewhere", () => {
    expect(acceleratorFromKeyEvent(ev("KeyS", { metaKey: true, altKey: true }), true)).toBe("CommandOrControl+Alt+S");
    expect(acceleratorFromKeyEvent(ev("KeyS", { metaKey: true }), false)).toBe("Super+S");
  });

  it("keeps waiting on a modifier alone, an unsupported key or a key without modifier", () => {
    expect(acceleratorFromKeyEvent(ev("ControlLeft", { ctrlKey: true }), false)).toBeNull();
    expect(acceleratorFromKeyEvent(ev("Escape", { ctrlKey: true }), false)).toBeNull();
    expect(acceleratorFromKeyEvent(ev("KeyM"), false)).toBeNull();
  });
});

describe("control settings", () => {
  const token = () => "a".repeat(64);

  it("starts with the default shortcuts, the API off and a fresh token", () => {
    const s = normalizeControlSettings(null, token);
    expect(s.shortcuts).toEqual(DEFAULT_SHORTCUTS);
    expect(s.api).toEqual({ enabled: false, port: DEFAULT_API_PORT, token: "a".repeat(64) });
  });

  it("keeps what is valid, keeps a removed shortcut removed, and repairs the rest", () => {
    const stored = { shortcuts: { "mic.toggle": "ctrl+alt+x", "screen.toggle": "", "scene.next": "nonsense" }, api: { enabled: true, port: 18000, token: "b".repeat(64) } };
    const s = normalizeControlSettings(stored, token);
    expect(s.shortcuts["mic.toggle"]).toBe("Control+Alt+X");
    expect(s.shortcuts["screen.toggle"]).toBe("");
    expect(s.shortcuts["scene.next"]).toBe(DEFAULT_SHORTCUTS["scene.next"]);
    expect(s.api).toEqual({ enabled: true, port: 18000, token: "b".repeat(64) });
  });

  it("replaces a malformed token and an out-of-range port, and never trusts a truthy 'enabled'", () => {
    const s = normalizeControlSettings({ api: { enabled: "yes", port: 80, token: "short" } }, token);
    expect(s.api).toEqual({ enabled: false, port: DEFAULT_API_PORT, token: "a".repeat(64) });
  });

  it("accepts a shortcut change only for a known action and a valid accelerator", () => {
    expect(parseShortcutChange("mic.toggle", "ctrl+alt+k")).toEqual({ action: "mic.toggle", accelerator: "Control+Alt+K" });
    expect(parseShortcutChange("mic.toggle", "")).toEqual({ action: "mic.toggle", accelerator: "" });
    expect(parseShortcutChange("mic.mute", "ctrl+alt+k")).toBeNull();
    expect(parseShortcutChange("mic.toggle", "k")).toBeNull();
  });
});

describe("ShortcutRegistry", () => {
  function backend(refuse: string[] = []) {
    const registered = new Map<string, () => void>();
    const b: ShortcutBackend = {
      register: (a, cb) => {
        if (refuse.includes(a)) return false;
        registered.set(a, cb);
        return true;
      },
      unregister: (a) => void registered.delete(a),
    };
    return { b, registered };
  }

  it("registers every configured shortcut and routes a press to its action", () => {
    const { b, registered } = backend();
    const pressed: string[] = [];
    const reg = new ShortcutRegistry(b, (a) => pressed.push(a));
    const status = reg.apply(DEFAULT_SHORTCUTS);
    expect(Object.values(status)).toEqual(SHORTCUT_ACTIONS.map(() => "registered"));
    registered.get(DEFAULT_SHORTCUTS["mic.toggle"])!();
    registered.get(DEFAULT_SHORTCUTS["scene.next"])!();
    expect(pressed).toEqual(["mic.toggle", "scene.next"]);
  });

  it("reports a refused, a duplicated and an empty shortcut, and keeps the others working", () => {
    const { b, registered } = backend(["Alt+B"]);
    const reg = new ShortcutRegistry(b, () => undefined);
    const status = reg.apply({ ...DEFAULT_SHORTCUTS, "browser.toggle": "Alt+B", "screen.toggle": "", "scene.previous": DEFAULT_SHORTCUTS["scene.next"].toLowerCase() });
    expect(status["browser.toggle"]).toBe("failed");
    expect(status["screen.toggle"]).toBe("disabled");
    expect(status["scene.previous"]).toBe("duplicate");
    expect(status["mic.toggle"]).toBe("registered");
    expect(registered.size).toBe(2);
  });

  it("removes the previous shortcuts when applying again, and on dispose", () => {
    const { b, registered } = backend();
    const reg = new ShortcutRegistry(b, () => undefined);
    reg.apply(DEFAULT_SHORTCUTS);
    reg.apply({ ...DEFAULT_SHORTCUTS, "mic.toggle": "Alt+M" });
    expect(registered.has(DEFAULT_SHORTCUTS["mic.toggle"])).toBe(false);
    expect(registered.has("Alt+M")).toBe(true);
    reg.dispose();
    expect(registered.size).toBe(0);
  });

  it("survives a backend that throws", () => {
    const reg = new ShortcutRegistry({ register: () => { throw new Error("boom"); }, unregister: () => undefined }, () => undefined);
    expect(reg.apply(DEFAULT_SHORTCUTS)["mic.toggle"]).toBe("failed");
  });
});

describe("scenes", () => {
  const ids = ["khutba", "avant", "priere"];
  it("goes to the next or previous scene and stops at the ends", () => {
    expect(pickScene(ids, "avant", "next")).toBe("priere");
    expect(pickScene(ids, "avant", "previous")).toBe("khutba");
    expect(pickScene(ids, "priere", "next")).toBeNull();
    expect(pickScene(ids, "khutba", "previous")).toBeNull();
  });
  it("starts from the first scene when the current one is unknown", () => {
    expect(pickScene(ids, undefined, "next")).toBe("khutba");
    expect(pickScene(ids, "inconnue", "previous")).toBeNull();
    expect(pickScene([], "x", "next")).toBeNull();
  });
  it("uses the funeral prayer command for janaza only", () => {
    expect(commandFor("janaza")).toEqual({ command: "janaza" });
    expect(commandFor("avant")).toEqual({ command: "scene", arg: "avant" });
  });
});

describe("requests", () => {
  it("parses only known actions, and a scene only where one is needed", () => {
    expect(parseControlRequest("mic.toggle")).toEqual({ action: "mic.toggle" });
    expect(parseControlRequest("mic.toggle", "x")).toEqual({ action: "mic.toggle" });
    expect(parseControlRequest("scene.set", "avant")).toEqual({ action: "scene.set", scene: "avant" });
    expect(parseControlRequest("scene.set")).toBeNull();
    expect(parseControlRequest("scene.set", "../x")).toBeNull();
    expect(parseControlRequest("source.remove")).toBeNull();
    expect(parseControlRequest(42)).toBeNull();
  });

  it("keeps only the expected fields of an answer from the window", () => {
    expect(normalizeControlResult({ ok: true, state: { micMuted: true, browser: "weird", extra: 1 }, secret: "x" })).toEqual({ ok: true, state: { micMuted: true } });
    expect(normalizeControlResult("nope")).toEqual({ ok: false, code: "bad_result" });
    expect(normalizeControlResult({ ok: 1 }).ok).toBe(false);
  });
});

describe("ControlService", () => {
  it("sends scene actions to the main process and the others to the window", async () => {
    const window = vi.fn(async () => ({ ok: true }));
    const scene = vi.fn(async () => ({ ok: true }));
    const svc = new ControlService({ window, scene });
    await svc.execute({ action: "mic.toggle" });
    await svc.execute({ action: "scene.next" });
    await svc.execute({ action: "scene.set", scene: "avant" });
    expect(window).toHaveBeenCalledTimes(1);
    expect(scene).toHaveBeenCalledTimes(2);
    expect(isSceneAction("scene.previous")).toBe(true);
    expect(isSceneAction("screen.toggle")).toBe(false);
  });

  it("turns an exception into a failed result", async () => {
    const svc = new ControlService({ window: async () => { throw new Error("down"); }, scene: async () => ({ ok: true }) });
    expect(await svc.execute({ action: "mic.mute" })).toMatchObject({ ok: false, code: "failed", message: "down" });
  });
});

describe("RendererLink", () => {
  afterEach(() => vi.useRealTimers());

  it("resolves a request with the window's answer, matched by id", async () => {
    const sent: { id: number; request: ControlRequest }[] = [];
    const link = new RendererLink((id, request) => (sent.push({ id, request }), true));
    const p = link.request({ action: "mic.toggle" });
    link.resolve(sent[0]!.id, { ok: true, state: { micMuted: true } });
    expect(await p).toEqual({ ok: true, state: { micMuted: true } });
  });

  it("fails at once without a window", async () => {
    const link = new RendererLink(() => false);
    expect(await link.request({ action: "mic.toggle" })).toMatchObject({ ok: false, code: "ui_unavailable" });
  });

  it("fails when the window never answers, and ignores a late answer", async () => {
    vi.useFakeTimers();
    const ids: number[] = [];
    const link = new RendererLink((id) => (ids.push(id), true), 1000);
    const p = link.request({ action: "screen.toggle" });
    await vi.advanceTimersByTimeAsync(1001);
    expect(await p).toMatchObject({ ok: false, code: "timeout" });
    expect(() => link.resolve(ids[0], { ok: true })).not.toThrow();
  });
});
