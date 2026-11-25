import { describe, expect, it } from "vitest";
import { evaluateHealth, toChecks, uncoveredSlots, type HealthInput } from "../src/core/health/health";
import { parseActiveHours, parseAutoLogon, parseSleepTimeouts } from "../src/core/health/windows-parsers";

const REG_WINLOGON = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon
    AutoAdminLogon    REG_SZ    1
`;
const REG_UPDATE = `
HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings
    ActiveHoursStart    REG_DWORD    0x8
    ActiveHoursEnd    REG_DWORD    0x16
    SmartActiveHoursState    REG_DWORD    0x0
`;
// Real output of a French-language Windows: the parser must not depend on the system language.
const POWERCFG_FR = `
  GUID de l'alias du paramètre d'alimentation : 29f6c1db-86da-48c5-9fdb-f2b67b1f44da  (STANDBYIDLE)
    Index du paramètre secteur actuel : 0x00000000
    Index du paramètre batterie actuel : 0x00000384
`;
const POWERCFG_EN = `
    Current AC Power Setting Index: 0x00000708
    Current DC Power Setting Index: 0x00000384
`;

describe("Windows output parsing", () => {
  it("automatic sign-in", () => {
    expect(parseAutoLogon(REG_WINLOGON)).toBe(true);
    expect(parseAutoLogon(REG_WINLOGON.replace("    1", "    0"))).toBe(false);
    expect(parseAutoLogon("")).toBeNull();
  });
  it("active hours (hexadecimal)", () => {
    expect(parseActiveHours(REG_UPDATE)).toEqual({ start: 8, end: 22 });
    expect(parseActiveHours("nothing")).toBeNull();
  });
  it("sleep timeout, whatever the system language", () => {
    expect(parseSleepTimeouts(POWERCFG_FR)).toEqual({ acSeconds: 0, dcSeconds: 900 });
    expect(parseSleepTimeouts(POWERCFG_EN)).toEqual({ acSeconds: 1800, dcSeconds: 900 });
    expect(parseSleepTimeouts("")).toBeNull();
  });
});

// Friday 27 November 2026, local time of the test machine.
const at = (h: number, m = 0) => new Date(2026, 10, 27, h, m).getTime();
const khutba = { id: "s1", type: "khutba" as const, title: "Khutba", startsAt: at(13, 15), endsAt: at(14) };
const base: HealthInput = {
  windows: { autoLogon: true, activeHours: { start: 8, end: 22 }, sleepAcSeconds: 0, launchAtLogin: true },
  cameras: 1,
  microphones: 1,
  schedule: [khutba],
  now: at(9),
  vaultPersistent: true,
};
const byId = (items: ReturnType<typeof evaluateHealth>, id: string) => items.find((i) => i.id === id)!;

describe("Workstation health", () => {
  it("everything is fine", () => {
    const items = evaluateHealth(base);
    expect(items.every((i) => i.status === "ok")).toBe(true);
    expect(toChecks(items).every((c) => c.ok)).toBe(true);
  });

  it("every problem has an explanation and steps to follow", () => {
    const items = evaluateHealth({
      ...base,
      windows: { autoLogon: false, activeHours: { start: 8, end: 12 }, sleepAcSeconds: 1800, launchAtLogin: false },
      cameras: 0,
      microphones: 0,
      vaultPersistent: false,
    });
    for (const id of ["camera", "micro", "windows_autologon", "windows_update_active_hours", "sleep"]) {
      const i = byId(items, id);
      expect(i.status).toBe("problem");
      expect(i.fix).toMatch(/\S{5}/);
    }
    expect(byId(items, "sleep").detail).toContain("30 minutes");
    expect(byId(items, "windows_autologon").fix).toContain("netplwiz");
    expect(byId(items, "windows_update_active_hours").detail).toContain("Friday");
    expect(byId(items, "device_vault").status).toBe("warn");
    expect(toChecks(items).filter((c) => !c.ok).map((c) => c.id)).toEqual(
      expect.arrayContaining(["camera", "micro", "windows_autologon", "windows_update_active_hours", "sleep"]),
    );
  });

  it("active hours: covers, does not cover, spans midnight", () => {
    expect(uncoveredSlots([khutba], { start: 8, end: 22 }, at(9))).toEqual([]);
    expect(uncoveredSlots([khutba], { start: 8, end: 13 }, at(9))).toEqual([khutba]);
    expect(uncoveredSlots([khutba], { start: 20, end: 15 }, at(9))).toEqual([]);
    expect(uncoveredSlots([khutba], { start: 14, end: 2 }, at(9))).toEqual([khutba]);
  });

  it("outside Windows, Windows checks are ignored (not applicable, never failing nor displayed)", () => {
    const items = evaluateHealth({ ...base, windows: null });
    for (const id of ["windows_autologon", "windows_update_active_hours", "sleep"]) expect(byId(items, id).status).toBe("na");
    expect(items.some((i) => i.id === "launch_at_login")).toBe(false);
    expect(toChecks(items).every((c) => c.ok)).toBe(true);
  });

  it("outside Windows, micro and vault fixes never mention Windows", () => {
    const items = evaluateHealth({ ...base, windows: null, microphones: 0, vaultPersistent: false });
    for (const id of ["micro", "device_vault"]) expect(byId(items, id).fix).not.toMatch(/Windows/);
    const win = evaluateHealth({ ...base, microphones: 0, vaultPersistent: false });
    expect(byId(win, "micro").fix).toMatch(/Windows/);
  });

  it("unreadable settings: unknown, not a failure", () => {
    const items = evaluateHealth({ ...base, windows: { autoLogon: null, activeHours: null, sleepAcSeconds: null, launchAtLogin: null } });
    expect(byId(items, "windows_autologon").status).toBe("unknown");
    expect(byId(items, "sleep").status).toBe("unknown");
    expect(toChecks(items).find((c) => c.id === "sleep")!.ok).toBe(true);
  });

  it("stable ids expected by the server", () => {
    const ids = toChecks(evaluateHealth(base)).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["camera", "micro", "windows_autologon", "windows_update_active_hours", "sleep"]));
  });
});
