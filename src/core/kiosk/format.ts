import { getLocale, intlLocale, t } from "../messages";

const TIME = () => new Intl.DateTimeFormat(intlLocale(), { hour: "2-digit", minute: "2-digit" });
const DAY = () => new Intl.DateTimeFormat(intlLocale(), { weekday: "long", day: "numeric", month: "long" });

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** "today at 13:00", "tomorrow at 13:00", otherwise "Friday 27 November at 13:00" (worded per locale). */
export function formatWhen(ms: number, now: number): string {
  const time = TIME().format(ms);
  const clock = getLocale() === "fr" ? time.replace(":", " h ").replace(/ $/, "").replace(/ h (\d\d)$/, " h $1") : time;
  if (sameDay(ms, now)) return t("when.today", { clock });
  if (sameDay(ms, now + 24 * 3600_000)) return t("when.tomorrow", { clock });
  return t("when.day", { day: DAY().format(ms), clock });
}

/** 90 → "1:30": countdown of the pairing code. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
