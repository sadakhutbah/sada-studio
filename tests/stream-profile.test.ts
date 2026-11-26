import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, parseProfile } from "../src/core/stream/profile";
import { scaleDownFor } from "../src/core/transport/whip";
import { INITIAL_KIOSK, kioskTransition, pairedState, type KioskOptions } from "../src/core/kiosk/machine";
import type { HeartbeatReply } from "../src/core/api/types";

const O: KioskOptions = { armMarginMs: 60_000, manualGraceMs: 30_000, conflictTtlMs: 60_000 } as KioskOptions;

const reply = (config: Record<string, unknown>): HeartbeatReply => ({ config, schedule: [], command: "idle", current: null });
const beat = (s: ReturnType<typeof pairedState>, config: Record<string, unknown>) =>
  kioskTransition(s, { type: "HEARTBEAT_OK", reply: reply(config), at: 1000 }, O);

describe("parseProfile", () => {
  it("reads the 1080p profile the server announces", () => {
    expect(parseProfile({ width: 1920, height: 1080, fps: 30, video_kbps: 4500, uplink_kbps: 8100 })).toEqual({
      width: 1920,
      height: 1080,
      fps: 30,
      videoKbps: 4500,
      uplinkKbps: 8100,
    });
  });

  it("derives the width from the height and keeps the uplink at 4500 at least", () => {
    const p = parseProfile({ height: 720, fps: 25, video_kbps: 2500, uplink_kbps: 100 });
    expect(p).toMatchObject({ width: 1280, height: 720, fps: 25, uplinkKbps: 4500 });
  });

  it.each([null, undefined, "x", {}, { height: 480, fps: 25 }, { height: 1080, fps: 120 }, { height: "1080", fps: 25 }])(
    "refuses %j",
    (raw) => expect(parseProfile(raw)).toBeNull(),
  );
});

describe("kiosk machine", () => {
  const paired = pairedState({ name: "M" }, "https://x");

  it("starts at 720p, as the application always did", () => {
    expect(INITIAL_KIOSK.stream).toEqual(DEFAULT_PROFILE);
    expect(DEFAULT_PROFILE).toMatchObject({ width: 1280, height: 720 });
  });

  it("takes the profile of the heartbeat", () => {
    const s = beat(paired, { stream: { width: 1920, height: 1080, fps: 30, video_kbps: 4500, uplink_kbps: 8100 } });
    expect(s.stream).toMatchObject({ width: 1920, height: 1080, fps: 30, uplinkKbps: 8100 });
  });

  it("keeps the last profile when an answer carries none (older server, bad value)", () => {
    const s1 = beat(paired, { stream: { height: 1080, fps: 25, video_kbps: 4500, uplink_kbps: 8100 } });
    expect(beat(s1, {}).stream).toBe(s1.stream);
    expect(beat(s1, { stream: { height: 360, fps: 25 } }).stream).toBe(s1.stream);
  });

  it("keeps the same object when nothing changed", () => {
    const cfg = { stream: { height: 1080, fps: 25, video_kbps: 4500, uplink_kbps: 8100 } };
    const s1 = beat(paired, cfg);
    expect(beat(s1, cfg).stream).toBe(s1.stream);
  });
});

describe("scaleDownFor", () => {
  it("brings a bigger picture down to the profile", () => {
    expect(scaleDownFor(1080, 720)).toBe(1.5);
    expect(scaleDownFor(2160, 1080)).toBe(2);
  });
  it("never scales up and leaves a picture that fits alone", () => {
    expect(scaleDownFor(720, 1080)).toBeUndefined();
    expect(scaleDownFor(720, 720)).toBeUndefined();
    expect(scaleDownFor(undefined, 720)).toBeUndefined();
    expect(scaleDownFor(1080, undefined)).toBeUndefined();
  });
});
