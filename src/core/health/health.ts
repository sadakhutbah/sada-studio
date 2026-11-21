import type { HealthCheck, Slot } from "../api/types";
import { slotEnd } from "../kiosk/schedule";
import { intlLocale, t } from "../messages";

/** What the main process could read on Windows; `null` (rather than an object) outside Windows. */
export interface WindowsFacts {
  /** Automatic sign-in (no password). */
  autoLogon: boolean | null;
  activeHours: { start: number; end: number } | null;
  sleepAcSeconds: number | null;
  /** The application is registered to start with the session. */
  launchAtLogin: boolean | null;
}

export interface HealthInput {
  windows: WindowsFacts | null;
  /** Number of cameras and microphones seen by the system; `null` while unknown. */
  cameras: number | null;
  microphones: number | null;
  schedule: Slot[];
  now: number;
  /** The device secret survives a restart. */
  vaultPersistent: boolean;
}

/** `na`: not applicable on this system (Windows check outside Windows); never displayed. */
export type HealthStatus = "ok" | "warn" | "problem" | "unknown" | "na";

export interface HealthItem {
  id: string;
  title: string;
  status: HealthStatus;
  /** What was observed. */
  detail: string;
  /** Steps to follow, in the current locale, when something is wrong. */
  fix?: string;
}

const HORIZON_MS = 14 * 24 * 3600_000;

/** Windows active hours: [start, end) in local hours; end < start = the range spans midnight. */
export function hourInActiveHours(hourFloat: number, h: { start: number; end: number }): boolean {
  if (h.start === h.end) return true;
  return h.start < h.end ? hourFloat >= h.start && hourFloat < h.end : hourFloat >= h.start || hourFloat < h.end;
}

const localHour = (ms: number) => {
  const d = new Date(ms);
  return d.getHours() + d.getMinutes() / 60;
};

/** Slots in the next two weeks that the active hours do not fully cover. */
export function uncoveredSlots(schedule: Slot[], h: { start: number; end: number }, now: number): Slot[] {
  return schedule.filter((s) => {
    if (s.startsAt > now + HORIZON_MS || slotEnd(s) <= now) return false;
    const endMs = slotEnd(s);
    // A range longer than 18 h, or crossing the end of the active hours, is not protected.
    const spanOk = (endMs - s.startsAt) / 3600_000 <= 18;
    const sh = localHour(s.startsAt);
    const eh = localHour(endMs - 1);
    const sameDay = new Date(s.startsAt).toDateString() === new Date(endMs - 1).toDateString();
    const covered = hourInActiveHours(sh, h) && hourInActiveHours(eh, h) && (sameDay || h.start >= h.end);
    return !(spanOk && covered);
  });
}

const hh = (n: number) => t("health.hours.hour", { n });
const fmtSlot = (s: Slot) =>
  new Date(s.startsAt).toLocaleString(intlLocale(), { weekday: "long", hour: "2-digit", minute: "2-digit" });

/** All the checks, in the current locale. Outside Windows, the Windows-specific checks are simply omitted. */
export function evaluateHealth(i: HealthInput): HealthItem[] {
  const out: HealthItem[] = [];

  out.push(
    i.cameras === null
      ? { id: "camera", title: t("health.camera.title"), status: "unknown", detail: t("health.camera.unknown") }
      : i.cameras > 0
        ? { id: "camera", title: t("health.camera.title"), status: "ok", detail: i.cameras === 1 ? t("health.camera.one") : t("health.camera.many", { n: i.cameras }) }
        : {
            id: "camera",
            title: t("health.camera.title"),
            status: "problem",
            detail: t("health.camera.none"),
            fix: t("health.camera.fix"),
          },
  );
  out.push(
    i.microphones === null
      ? { id: "micro", title: t("health.micro.title"), status: "unknown", detail: t("health.micro.unknown") }
      : i.microphones > 0
        ? { id: "micro", title: t("health.micro.title"), status: "ok", detail: i.microphones === 1 ? t("health.micro.one") : t("health.micro.many", { n: i.microphones }) }
        : {
            id: "micro",
            title: t("health.micro.title"),
            status: "problem",
            detail: t("health.micro.none"),
            fix: t("health.micro.fix"),
          },
  );

  out.push(
    i.vaultPersistent
      ? { id: "device_vault", title: t("health.vault.title"), status: "ok", detail: t("health.vault.ok") }
      : {
          id: "device_vault",
          title: t("health.vault.title"),
          status: "warn",
          detail: t("health.vault.none"),
          fix: t("health.vault.fix"),
        },
  );

  const w = i.windows;
  if (!w) {
    for (const id of ["windows_autologon", "windows_update_active_hours", "sleep"]) {
      out.push({ id, title: id, status: "na", detail: t("health.na") });
    }
    return out;
  }

  if (w.launchAtLogin !== null) {
    out.push(
      w.launchAtLogin
        ? { id: "launch_at_login", title: t("health.launch.title"), status: "ok", detail: t("health.launch.ok") }
        : {
            id: "launch_at_login",
            title: t("health.launch.title"),
            status: "warn",
            detail: t("health.launch.no"),
            fix: t("health.launch.fix"),
          },
    );
  }

  out.push(
    w.autoLogon === null
      ? { id: "windows_autologon", title: t("health.autologon.title"), status: "unknown", detail: t("health.unreadable") }
      : w.autoLogon
        ? { id: "windows_autologon", title: t("health.autologon.title"), status: "ok", detail: t("health.autologon.ok") }
        : {
            id: "windows_autologon",
            title: t("health.autologon.title"),
            status: "problem",
            detail: t("health.autologon.no"),
            fix: t("health.autologon.fix"),
          },
  );

  if (!w.activeHours) {
    out.push({
      id: "windows_update_active_hours",
      title: t("health.hours.title"),
      status: "unknown",
      detail: t("health.hours.unset"),
      fix: t("health.hours.fixUnset"),
    });
  } else {
    const bad = uncoveredSlots(i.schedule, w.activeHours, i.now);
    const range = t("health.hours.range", { start: hh(w.activeHours.start), end: hh(w.activeHours.end) });
    out.push(
      bad.length === 0
        ? { id: "windows_update_active_hours", title: t("health.hours.title"), status: "ok", detail: i.schedule.length ? t("health.hours.covered", { range }) : t("health.hours.noSlots", { range }) }
        : {
            id: "windows_update_active_hours",
            title: t("health.hours.title"),
            status: "problem",
            detail: bad.length === 1 ? t("health.hours.uncoveredOne", { range, slot: fmtSlot(bad[0]) }) : t("health.hours.uncoveredMany", { range, n: bad.length, slot: fmtSlot(bad[0]) }),
            fix: t("health.hours.fixWiden"),
          },
    );
  }

  if (w.sleepAcSeconds === null) {
    out.push({ id: "sleep", title: t("health.sleep.title"), status: "unknown", detail: t("health.unreadable") });
  } else if (w.sleepAcSeconds === 0) {
    out.push({ id: "sleep", title: t("health.sleep.title"), status: "ok", detail: t("health.sleep.never") });
  } else {
    out.push({
      id: "sleep",
      title: t("health.sleep.title"),
      status: "problem",
      detail: t("health.sleep.after", { n: Math.round(w.sleepAcSeconds / 60) }),
      fix: t("health.sleep.fix"),
    });
  }
  return out;
}

/**
 * Checks as the server receives them. An unreadable or not-applicable setting is not a failure (`ok: true`):
 * the server only writes to operators for real problems.
 */
export function toChecks(items: HealthItem[]): HealthCheck[] {
  return items.map((i) => ({ id: i.id, ok: i.status !== "problem" && i.status !== "warn", detail: i.detail }));
}
