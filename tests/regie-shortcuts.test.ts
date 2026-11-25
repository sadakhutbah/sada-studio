import { describe, expect, it } from "vitest";
import { resolveRegieShortcut } from "../src/renderer/src/regie-shortcuts";

describe("resolveRegieShortcut", () => {
  it("stages scenes 1-9 when within range", () => {
    expect(resolveRegieShortcut({ key: "1" }, 5)).toEqual({ type: "stage", index: 0 });
    expect(resolveRegieShortcut({ key: "5" }, 5)).toEqual({ type: "stage", index: 4 });
    expect(resolveRegieShortcut({ key: "6" }, 5)).toBeNull();
    expect(resolveRegieShortcut({ key: "0" }, 5)).toBeNull();
  });

  const onElement = (match: string) => ({ tagName: "BUTTON", closest: (sel: string) => (sel === match ? ({} as Element) : null) });

  it("triggers take on Enter only with the focus on a scene button", () => {
    expect(resolveRegieShortcut({ key: "Enter", target: onElement("button[data-regie-scene]") }, 5)).toEqual({ type: "take" });
    expect(resolveRegieShortcut({ key: "Enter" }, 5)).toBeNull(); // no focus
    expect(resolveRegieShortcut({ key: "Enter", target: { tagName: "BODY", closest: () => null } }, 5)).toBeNull();
    expect(resolveRegieShortcut({ key: "Enter", target: onElement("button, a") }, 5)).toBeNull(); // another button
  });

  it("ignores events from editable elements or with modifiers", () => {
    expect(resolveRegieShortcut({ key: "2", target: { tagName: "INPUT" } }, 5)).toBeNull();
    expect(resolveRegieShortcut({ key: "Enter", target: { tagName: "TEXTAREA" } }, 5)).toBeNull();
    expect(resolveRegieShortcut({ key: "1", target: { tagName: "SELECT" } }, 5)).toBeNull();
    expect(resolveRegieShortcut({ key: "1", target: { isContentEditable: true } }, 5)).toBeNull();
    expect(resolveRegieShortcut({ key: "1", ctrlKey: true }, 5)).toBeNull();
    expect(resolveRegieShortcut({ key: "Enter", metaKey: true }, 5)).toBeNull();
  });
});
