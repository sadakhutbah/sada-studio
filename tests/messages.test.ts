import { afterEach, describe, expect, it } from "vitest";
import { getLocale, quitSystemLabel, setLocale, t } from "../src/core/messages";
import { formatWhen } from "../src/core/kiosk/format";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("core messages", () => {
  afterEach(() => setLocale("en"));

  it("uses the same placeholders in French and English", () => {
    const text = (locale: "fr" | "en", key: Parameters<typeof t>[0]) => {
      setLocale(locale);
      // Fill every placeholder with itself to read the set back.
      return t(key, new Proxy({}, { get: (_, k) => `{${String(k)}}` }) as Record<string, string>);
    };
    const keys = [
      "api.liveActiveSince", "api.httpError", "api.whipUnexpected", "sup.heartbeatsMissed", "sup.noLongerAuthorized",
      "when.today", "when.tomorrow", "when.day", "quit.title", "health.camera.many", "health.micro.many",
      "health.hours.range", "health.hours.hour", "health.hours.covered", "health.hours.noSlots",
      "health.hours.uncoveredOne", "health.hours.uncoveredMany", "health.sleep.after", "setup.idleClosed",
    ] as const;
    for (const k of keys) expect(placeholders(text("fr", k)), k).toEqual(placeholders(text("en", k)));
  });

  it("defaults to French wording and switches to English", () => {
    setLocale("fr");
    expect(getLocale()).toBe("fr");
    expect(t("api.liveActiveSince", { time: "12:05" })).toBe("Un direct est déjà en cours depuis 12:05.");
    const now = new Date(2026, 10, 27, 9, 0).getTime();
    expect(formatWhen(new Date(2026, 10, 27, 13, 0).getTime(), now)).toBe("aujourd'hui à 13 h 00");
    setLocale("en");
    expect(t("api.liveActiveSince", { time: "12:05" })).toBe("A live is already running since 12:05.");
    expect(formatWhen(new Date(2026, 10, 27, 13, 0).getTime(), now)).toMatch(/^today at 13:00$/);
  });
});

describe("quit dialog system name", () => {
  afterEach(() => setLocale("en"));

  it("names Windows and macOS, and stays neutral elsewhere", () => {
    setLocale("fr");
    expect(t("quit.detail", { os: quitSystemLabel("darwin") })).toContain("démarrage de macOS ou de l'application");
    expect(t("quit.detail", { os: quitSystemLabel("win32") })).toContain("démarrage de Windows ou de l'application");
    expect(t("quit.detail", { os: quitSystemLabel("linux") })).toContain("démarrage de l'ordinateur ou de l'application");
    setLocale("en");
    expect(t("quit.detail", { os: quitSystemLabel("darwin") })).toBe(
      "Once closed, the application will no longer broadcast scheduled lives until macOS or the application starts again.",
    );
    expect(quitSystemLabel("win32")).toBe("Windows");
    expect(quitSystemLabel("freebsd")).toBe("the computer");
  });

  it("never says Windows on macOS or Linux", () => {
    for (const locale of ["fr", "en"] as const) {
      setLocale(locale);
      for (const p of ["darwin", "linux"]) expect(t("quit.detail", { os: quitSystemLabel(p) })).not.toMatch(/Windows/);
    }
  });
});
