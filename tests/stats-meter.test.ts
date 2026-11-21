import { describe, expect, it } from "vitest";
import { levelDb, meterPosition } from "../src/core/audio/meter";
import { BitrateEstimator, formatBitrate, formatDuration } from "../src/core/stats";

describe("statistiques", () => {
  it("débit entre deux relevés, 0 au premier et si le compteur repart", () => {
    const e = new BitrateEstimator();
    expect(e.sample(0, 0)).toBe(0);
    expect(e.sample(250_000, 1000)).toBe(2000);
    expect(e.sample(10, 2000)).toBe(0);
  });
  it("formate durée et débit", () => {
    expect(formatDuration(65_000)).toBe("01:05");
    expect(formatDuration(3_725_000)).toBe("1:02:05");
    expect(formatBitrate(850)).toBe("850 kbit/s");
    expect(formatBitrate(4200)).toBe("4,2 Mbit/s");
  });
});

describe("vu-mètre", () => {
  it("silence, pleine échelle et demi-niveau", () => {
    expect(levelDb(new Float32Array(64)).rms).toBe(-100);
    expect(levelDb(new Float32Array(64).fill(1)).peak).toBeCloseTo(0);
    expect(levelDb(new Float32Array(64).fill(0.5)).rms).toBeCloseTo(-6.02, 1);
  });
  it("position bornée entre 0 et 1", () => {
    expect(meterPosition(-100)).toBe(0);
    expect(meterPosition(0)).toBe(1);
    expect(meterPosition(-30)).toBe(0.5);
  });
});
