import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeLocaleChoice, resolveLocale, systemLocale } from "../src/core/locale";
import { getLocale, intlLocale, setLocale } from "../src/core/messages";
import { catalogs, en, fr, setUiLocale, str, subscribeLocale } from "../src/renderer/src/strings";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const flatten = (o: unknown, prefix = ""): Record<string, string> =>
  Object.entries(o as Record<string, unknown>).reduce<Record<string, string>>((acc, [k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return typeof v === "string" ? { ...acc, [key]: v } : { ...acc, ...flatten(v, key) };
  }, {});

describe("renderer catalogues", () => {
  const a = flatten(fr);
  const b = flatten(en);

  it("have exactly the same keys in French and English", () => {
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
  });

  it("have no empty text and the same placeholders in both languages", () => {
    for (const k of Object.keys(a)) {
      expect(b[k], k).not.toBe("");
      expect(placeholders(b[k]!), k).toEqual(placeholders(a[k]!));
    }
  });

  it("serve the current language through `str`, and tell the subscribers when it changes", () => {
    let calls = 0;
    const off = subscribeLocale(() => calls++);
    setUiLocale("fr");
    expect(str.settings.title).toBe("Réglages");
    setUiLocale("en");
    expect(str.settings.title).toBe("Settings");
    expect(str.control.actions["mic.toggle"]).toBe(catalogs.en.control.actions["mic.toggle"]);
    expect(intlLocale()).toBe("en-GB");
    setUiLocale("en"); // no change, no notification
    off();
    expect(calls).toBeGreaterThanOrEqual(1);
    setUiLocale("fr");
    expect(intlLocale()).toBe("fr-FR");
    expect(getLocale()).toBe("fr");
    setLocale("fr");
  });
});

describe("language choice", () => {
  it("follows the system language by default: French for fr*, English otherwise", () => {
    for (const tag of ["fr", "fr-FR", "fr-CA", "FR-be"]) expect(resolveLocale(tag, "auto"), tag).toBe("fr");
    for (const tag of ["en-US", "en-GB", "de-DE", "ar", "", "fra"]) expect(resolveLocale(tag, "auto"), tag).toBe("en");
    expect(systemLocale("fr-FR")).toBe("fr");
  });

  it("lets the saved choice override the system language", () => {
    expect(resolveLocale("fr-FR", "en")).toBe("en");
    expect(resolveLocale("en-US", "fr")).toBe("fr");
  });

  it("reads a stored choice, and falls back to auto on anything unreadable", () => {
    expect(normalizeLocaleChoice({ choice: "en" })).toBe("en");
    expect(normalizeLocaleChoice("fr")).toBe("fr");
    for (const bad of [null, undefined, 3, {}, { choice: "de" }, "klingon"]) expect(normalizeLocaleChoice(bad)).toBe("auto");
  });
});

describe("saved choice file", () => {
  it("round-trips through the store used by the main process", async () => {
    // The store only needs node:fs, but its module imports electron: stub it for this test.
    const { vi } = await import("vitest");
    vi.doMock("electron", () => ({ app: {}, BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: () => undefined } }));
    const { LocaleStore } = await import("../src/main/locale");
    const dir = mkdtempSync(join(tmpdir(), "sada-locale-"));
    const store = new LocaleStore(dir);
    expect(store.load()).toBe("auto");
    store.save("en");
    expect(JSON.parse(readFileSync(join(dir, "locale.json"), "utf8"))).toEqual({ choice: "en" });
    expect(new LocaleStore(dir).load()).toBe("en");
    writeFileSync(join(dir, "locale.json"), "{not json");
    expect(store.load()).toBe("auto");
    vi.doUnmock("electron");
  });
});
