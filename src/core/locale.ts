import type { Locale } from "./messages";

/** What the operator picked in the settings: a language, or "auto" to follow the system. */
export type LocaleChoice = "auto" | Locale;

/** Language in use and the choice behind it, as the UI sees them. */
export interface LocaleView {
  locale: Locale;
  choice: LocaleChoice;
}

export const LOCALE_CHOICES: readonly LocaleChoice[] = ["auto", "fr", "en"];

export const isLocaleChoice = (v: unknown): v is LocaleChoice => typeof v === "string" && (LOCALE_CHOICES as readonly string[]).includes(v);

/** The stored choice (any shape: old file, hand edit) as a valid one; "auto" when unreadable. */
export function normalizeLocaleChoice(raw: unknown): LocaleChoice {
  const v = raw && typeof raw === "object" ? (raw as Record<string, unknown>).choice : raw;
  return isLocaleChoice(v) ? v : "auto";
}

/** Language of the system (`app.getLocale()`, e.g. "fr", "fr-CA", "en-US"): French when it starts with "fr", English otherwise. */
export function systemLocale(tag: string): Locale {
  return /^fr(?![a-z])/i.test(tag.trim()) ? "fr" : "en";
}

/** The language to use: the operator's choice when there is one, the system's otherwise. */
export function resolveLocale(systemTag: string, choice: LocaleChoice): Locale {
  return choice === "auto" ? systemLocale(systemTag) : choice;
}
