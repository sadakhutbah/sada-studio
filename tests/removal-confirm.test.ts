import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { removalStep } from "../src/core/sources/removal";

describe("removalStep", () => {
  it("asks first: asking never removes", () => {
    expect(removalStep("idle", "ask")).toEqual({ phase: "confirming", remove: false });
  });

  it("removes only when the question was asked and confirmed", () => {
    expect(removalStep("confirming", "confirm")).toEqual({ phase: "idle", remove: true });
    // A stale or double click without a pending question removes nothing.
    expect(removalStep("idle", "confirm")).toEqual({ phase: "idle", remove: false });
  });

  it("keeps the source when the operator cancels", () => {
    expect(removalStep("confirming", "cancel")).toEqual({ phase: "idle", remove: false });
  });
});

describe("web source row", () => {
  const row = readFileSync(new URL("../src/renderer/src/components/LocalSources.tsx", import.meta.url), "utf8");

  it("only reaches the removal callback through the confirmation, and shows or hides without asking", () => {
    // `onRemove()` is called once, from the confirmed step; the button itself only asks.
    expect(row.match(/\bonRemove\(\)/g)).toHaveLength(1);
    expect(row).not.toMatch(/onClick=\{onRemove\}/);
    expect(row).toMatch(/onClick=\{\(\) => onVisible\(!config\.visible\)\}/);
  });
});
