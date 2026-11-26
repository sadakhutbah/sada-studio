/**
 * The mosque's HTML screens (imported template), rendered by the studio itself: placeholder filling, countdown
 * text, and which screen goes with which scene. Pure (no DOM): the page is loaded by the main process.
 */

/** Screens and banners a template can provide (`sada/backoffice/gabarit.py::ECRANS`, `BANDEAUX`). */
export const ECRANS = ["avant", "priere", "entracte", "termine", "janaza", "dars_fin"] as const;
export const BANDEAUX = ["khutba", "dars"] as const;
const CONNUS: ReadonlySet<string> = new Set<string>([...ECRANS, ...BANDEAUX]);

/** Variables of a screen, in the order `gabarit.remplir` replaces them (`gabarit.py::VARIABLES`). */
export const VARIABLES = ["heure", "date", "jour", "cours", "titre", "mosquee", "ligne2", "arabe", "orateur", "serie", "seance", "logo"] as const;

/** The template screen of a scene, or null when the scene has none (custom slate, tarawih…: the PNG is used). */
export function ecranFor(sceneId: string): string | null {
  return CONNUS.has(sceneId) ? sceneId : null;
}

/** `html.escape(value, quote=True)`: the values are text, never markup. */
export function escapeHtml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

/** Attribute on the element that wraps the countdown text, so the main process can update it in place. */
export const COUNTDOWN_ATTR = "data-sada-decompte";

/**
 * Is position `i` of `html` in element text, where an inline `<span>` may be inserted? Not inside a tag (attribute
 * value), nor inside `<style>`, `<script>`, `<title>` or `<textarea>` raw text.
 */
export function inText(html: string, i: number): boolean {
  const lt = html.lastIndexOf("<", i);
  const gt = html.lastIndexOf(">", i);
  if (lt > gt) return false;
  const before = html.slice(0, i).toLowerCase();
  for (const tag of ["style", "script", "title", "textarea"]) {
    if (before.lastIndexOf(`<${tag}`) > before.lastIndexOf(`</${tag}`)) return false;
  }
  return true;
}

export interface FilledScreen {
  html: string;
  /** The countdown sits in marked elements (updated in place each second); false: it is baked in the page text. */
  marked: boolean;
}

/**
 * `gabarit.remplir`: each variable `{nom}` replaced, in `VARIABLES` order then the other keys the server sent
 * (the engine's renderer replaces every key it is given), by its value or "" — HTML-escaped.
 * The countdown variable (`countdown.variable`) gets `countdownText`; where it sits in element text it is wrapped in
 * `<span data-sada-decompte>` so that the page need not be reloaded every second.
 */
export function fillScreen(page: string, values: Record<string, string>, countdown: { variable: string; text: string } | null = null): FilledScreen {
  const names: string[] = [...VARIABLES];
  for (const k of Object.keys(values)) if (!names.includes(k)) names.push(k);
  let html = page;
  let marked = false;
  const cdName = countdown?.variable ?? null;
  for (const nom of names) {
    if (nom === cdName) continue;
    html = html.split(`{${nom}}`).join(escapeHtml(values[nom] ?? ""));
  }
  if (countdown && cdName) {
    const token = `{${cdName}}`;
    const text = escapeHtml(countdown.text);
    // Where every occurrence sits in element text they are wrapped (updated in place); one occurrence in an
    // attribute or a style means the whole page depends on the value: it is baked in and re-rendered.
    let occurrences = 0;
    let allInText = true;
    for (let i = html.indexOf(token); i >= 0; i = html.indexOf(token, i + token.length)) {
      occurrences++;
      allInText &&= inText(html, i);
    }
    const replacement = allInText ? `<span ${COUNTDOWN_ATTR}>${text}</span>` : text;
    html = html.split(token).join(replacement);
    marked = occurrences > 0 && allInText;
  }
  return { html, marked };
}

/** `scenes.py::_countdown`: days then hours then minutes:seconds, whichever reads best. */
export function screenCountdown(seconds: number): string {
  let s = Math.max(0, Math.trunc(seconds));
  const d = Math.floor(s / 86400);
  s %= 86400;
  const h = Math.floor(s / 3600);
  s %= 3600;
  const mi = Math.floor(s / 60);
  const se = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  if (d) return `${d} j ${two(h)} h`;
  if (h) return `${h} h ${two(mi)}`;
  return `${two(mi)}:${two(se)}`;
}

/** Countdown text at `now` (ms) towards an ISO-8601 target; "" when the target is unreadable. */
export function countdownAt(target: string, now: number): string {
  const t = Date.parse(target);
  if (Number.isNaN(t)) return "";
  return screenCountdown((t - now) / 1000);
}

/**
 * The scenes likely to come next, pre-rendered so that taking them on air is instant: the engine's usual
 * sequence first, then the scene that follows in the Régie list.
 */
const USUAL_NEXT: Record<string, readonly string[]> = {
  avant: ["khutba"],
  khutba: ["priere"],
  priere: ["termine"],
  entracte: ["khutba", "avant"],
  termine: ["avant"],
  janaza: ["termine"],
  dars: ["dars_fin"],
  dars_fin: ["dars"],
};

export function probableNext(current: string, sceneIds: readonly string[], max = 2): string[] {
  const out: string[] = [];
  const add = (id: string | undefined) => {
    if (id && id !== current && sceneIds.includes(id) && !out.includes(id) && out.length < max) out.push(id);
  };
  for (const id of USUAL_NEXT[current] ?? []) add(id);
  // Then the scenes that follow in the Régie list (the operator takes them with the arrow keys).
  const i = sceneIds.indexOf(current);
  if (i >= 0) for (const id of sceneIds.slice(i + 1)) add(id);
  return out;
}
