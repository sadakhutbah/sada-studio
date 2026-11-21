import type { HealthItem, HealthStatus } from "@core/health/health";
import { fr } from "../strings";
import { Card, Kicker } from "../ui";

const TONE: Record<Exclude<HealthStatus, "na">, string> = {
  ok: "bg-green",
  warn: "bg-warn",
  problem: "bg-live",
  unknown: "bg-dot-off",
};

/** « Santé du poste » : chaque problème est expliqué avec sa marche à suivre. Lecture seule. */
export function HealthPanel({ items }: { items: HealthItem[] }) {
  const t = fr.health;
  const shown = items.filter((i) => i.status !== "na");
  const issues = shown.filter((i) => i.status === "problem" || i.status === "warn");
  return (
    <Card>
      <Kicker>{t.kicker}</Kicker>
      <p className="mb-3 mt-0 text-[0.85rem] text-muted">{issues.length === 0 ? t.allGood : t.hint}</p>
      <ul className="m-0 grid list-none gap-2.5 p-0">
        {shown.map((i) => {
          const status = i.status as Exclude<HealthStatus, "na">;
          return (
            <li key={i.id} className="text-[0.92rem]">
              <p className="m-0 flex items-center gap-2 font-semibold text-deeper">
                <span aria-hidden className={`size-2 shrink-0 rounded-full ${TONE[status]}`} />
                {i.title}
                <span className="ml-auto text-[0.75rem] font-normal text-muted">{t[status]}</span>
              </p>
              <p className="m-0 mt-0.5 text-[0.85rem] text-muted">{i.detail}</p>
              {i.fix && (
                <p className="m-0 mt-1 rounded-lg bg-warn-bg px-2.5 py-1.5 text-[0.82rem] text-ink">
                  <strong>{t.how} : </strong>
                  {i.fix}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
