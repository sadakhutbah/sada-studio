const TIME = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** « aujourd'hui à 13:00 », « demain à 13:00 », sinon « vendredi 27 novembre à 13:00 ». */
export function formatWhen(ms: number, now: number): string {
  const time = TIME.format(ms).replace(":", " h ").replace(/ $/, "");
  const clock = time.replace(/ h (\d\d)$/, " h $1");
  if (sameDay(ms, now)) return `aujourd'hui à ${clock}`;
  if (sameDay(ms, now + 24 * 3600_000)) return `demain à ${clock}`;
  return `${DAY.format(ms)} à ${clock}`;
}

/** 90 → « 1:30 » : compte à rebours du code d'appairage. */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
