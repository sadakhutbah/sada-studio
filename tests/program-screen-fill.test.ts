import { describe, expect, it } from "vitest";
import { COUNTDOWN_ATTR, countdownAt, ecranFor, escapeHtml, fillScreen, inText, probableNext, screenCountdown } from "../src/core/program/screen-fill";

describe("template filling (gabarit.remplir)", () => {
  it("replaces every known variable by its value, an absent one by nothing", () => {
    const page = "<p>{titre} — {mosquee}</p><p>Début à {heure}</p><p>{orateur}</p><p>{inconnu}</p>";
    const { html } = fillScreen(page, { titre: "Khutba", mosquee: "Al Nour", heure: "13 h 30" });
    expect(html).toBe("<p>Khutba — Al Nour</p><p>Début à 13 h 30</p><p></p><p>{inconnu}</p>");
  });

  it("replaces the other keys the server sends too, after the known ones", () => {
    expect(fillScreen("{extra}{titre}", { extra: "a", titre: "b" }).html).toBe("ab");
  });

  it("escapes the values: text is never markup", () => {
    expect(escapeHtml(`<b>"A" & 'B'</b>`)).toBe("&lt;b&gt;&quot;A&quot; &amp; &#x27;B&#x27;&lt;/b&gt;");
    expect(fillScreen("<p>{mosquee}</p><img alt=\"{titre}\">", { mosquee: "<script>x</script>", titre: '" onerror="x' }).html).toBe(
      '<p>&lt;script&gt;x&lt;/script&gt;</p><img alt="&quot; onerror=&quot;x">',
    );
  });

  it("wraps the countdown in a marked span where it sits in text, so it is updated in place", () => {
    const r = fillScreen("<p class=c>Reprise dans {decompte}</p>", {}, { variable: "decompte", text: "04:59" });
    expect(r).toEqual({ html: `<p class=c>Reprise dans <span ${COUNTDOWN_ATTR}>04:59</span></p>`, marked: true });
  });

  it("bakes the countdown in when it sits in an attribute or a style (the page is then re-rendered)", () => {
    const r = fillScreen('<p title="{decompte}">{decompte}</p><style>.x::after{content:"{decompte}"}</style>', {}, { variable: "decompte", text: "1 h 05" });
    expect(r.marked).toBe(false);
    expect(r.html).toBe('<p title="1 h 05">1 h 05</p><style>.x::after{content:"1 h 05"}</style>');
  });

  it("knows text positions from tag and raw-text positions", () => {
    const h = '<p a="x">t</p><style>s</style><title>u</title>';
    expect(inText(h, h.indexOf("x"))).toBe(false);
    expect(inText(h, h.indexOf("t<"))).toBe(true);
    expect(inText(h, h.indexOf("s<"))).toBe(false);
    expect(inText(h, h.indexOf("u<"))).toBe(false);
  });
});

describe("countdown text (scenes.py::_countdown)", () => {
  it("minutes:seconds, then hours, then days", () => {
    expect(screenCountdown(0)).toBe("00:00");
    expect(screenCountdown(299.9)).toBe("04:59");
    expect(screenCountdown(3600 + 5 * 60 + 9)).toBe("1 h 05");
    expect(screenCountdown(3 * 86400 + 6 * 3600 + 59)).toBe("3 j 06 h");
    expect(screenCountdown(-5)).toBe("00:00");
  });
  it("towards an ISO target", () => {
    const now = Date.parse("2026-11-27T12:00:00Z");
    expect(countdownAt("2026-11-27T12:05:00Z", now)).toBe("05:00");
    expect(countdownAt("2026-11-27T12:05:00Z", now + 1500)).toBe("04:58");
    expect(countdownAt("n'importe quoi", now)).toBe("");
  });
});

describe("screens and pre-rendering", () => {
  it("maps scenes to template screens (custom and tarawih have none)", () => {
    expect(ecranFor("priere")).toBe("priere");
    expect(ecranFor("khutba")).toBe("khutba");
    expect(ecranFor("tarawih")).toBeNull();
    expect(ecranFor("custom-12")).toBeNull();
  });
  it("pre-renders the engine's usual next scenes, completed by the ones that follow in the list", () => {
    const ids = ["avant", "khutba", "priere", "termine", "entracte"];
    expect(probableNext("avant", ids)).toEqual(["khutba", "priere"]);
    expect(probableNext("priere", ids)).toEqual(["termine", "entracte"]);
    expect(probableNext("entracte", ids)).toEqual(["khutba", "avant"]);
    expect(probableNext("x", ["x", "y"])).toEqual(["y"]);
    expect(probableNext("entracte", ["entracte"])).toEqual([]);
  });
});
