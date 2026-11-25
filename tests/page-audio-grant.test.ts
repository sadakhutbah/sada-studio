import { describe, expect, it } from "vitest";
import { PAGE_AUDIO_GRANT_MS, PageAudioGrant } from "../src/core/sources/page-audio-grant";

describe("PageAudioGrant", () => {
  it("grants nothing until the window armed it", () => {
    expect(new PageAudioGrant().consume(1000)).toBe(false);
  });

  it("grants the page's sound once per arming", () => {
    const g = new PageAudioGrant();
    g.arm(1000);
    expect(g.consume(1500)).toBe(true);
    expect(g.consume(1600)).toBe(false); // the next getDisplayMedia is the screen share again
  });

  it("lapses when the window does not ask in time, and never leaks to a later request", () => {
    const g = new PageAudioGrant();
    g.arm(0);
    expect(g.consume(PAGE_AUDIO_GRANT_MS + 1)).toBe(false);
    expect(g.consume(PAGE_AUDIO_GRANT_MS + 2)).toBe(false);
  });
});
