import { useState } from "react";
import { LOCALE_CHOICES, type LocaleChoice, type LocaleView } from "@core/locale";
import { useEffect } from "react";
import { unwrap } from "../bridge";
import { str } from "../strings";
import { Card, Field, Kicker, selectClass } from "../ui";

/** Interface language: follow the system, or force French or English. Saved by the main process, applied at once. */
export function LanguageSettings() {
  const [choice, setChoice] = useState<LocaleChoice | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.studio.locale.get().then((v) => alive && setChoice(v.choice), () => undefined);
    const off = window.studio.locale.onChange((v: LocaleView) => setChoice(v.choice));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const pick = (next: LocaleChoice) => {
    setError(null);
    void window.studio.locale.set(next).then(
      (r) => setChoice(unwrap(r).choice),
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );
  };

  return (
    <Card>
      <Kicker>{str.language.kicker}</Kicker>
      <Field label={str.language.label} help={str.language.help}>
        <select value={choice ?? "auto"} disabled={choice === null} onChange={(e) => pick(e.target.value as LocaleChoice)} className={selectClass}>
          {LOCALE_CHOICES.map((c) => (
            <option key={c} value={c}>
              {str.language[c]}
            </option>
          ))}
        </select>
      </Field>
      {error && (
        <p role="alert" className="mb-0 mt-2 text-[0.82rem] text-live">
          {error}
        </p>
      )}
    </Card>
  );
}
