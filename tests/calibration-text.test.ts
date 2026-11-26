import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "../src/core/messages";
import { describeCalibration } from "../src/renderer/src/calibration-text";

const done = (result: object) => ({ status: "done", at: 0, result }) as never;

describe("calibration assistant messages", () => {
  it("shows nothing until a run is finished", () => {
    expect(describeCalibration({ status: "idle" })).toBeNull();
    expect(describeCalibration({ status: "running", seconds: 3 })).toBeNull();
  });
  afterEach(() => setLocale("en"));
  it("reports only the applied delay on success, in the current language", () => {
    const result = done({ ok: true, gapMs: 410, delayMs: 400, audioBehind: false });
    expect(describeCalibration(result)).toEqual({ ok: true, text: "Delay set: 400 ms" });
    setLocale("fr");
    expect(describeCalibration(result)).toEqual({ ok: true, text: "Décalage réglé : 400 ms" });
  });
  it("is a failure (with retry) when the clap is missed or the audio is behind", () => {
    expect(describeCalibration(done({ ok: false, reason: "no-clap" }))?.ok).toBe(false);
    expect(describeCalibration(done({ ok: true, gapMs: -20, delayMs: 0, audioBehind: true }))?.ok).toBe(false);
  });
});
