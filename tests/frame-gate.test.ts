import { describe, expect, it } from "vitest";
import { bgraPremulToRgba, FRAME_ACK_TIMEOUT_MS, FrameGate, fitWithin, MAX_FRAME_FPS } from "../src/core/sources/frame-gate";

describe("FrameGate", () => {
  it("lets through at most 15 frames per second", () => {
    const gate = new FrameGate(15);
    let sent = 0;
    // 60 paints per second for 2 s, each one consumed right away.
    for (let t = 0; t < 2000; t += 1000 / 60) {
      if (gate.tryBegin(t)) {
        sent++;
        gate.ack();
      }
    }
    // Paints land on a 16.7 ms grid, so the 67 ms interval rounds up to 83 ms: never above 15 fps.
    expect(sent).toBeLessThanOrEqual(30);
    expect(sent).toBeGreaterThanOrEqual(20);
  });

  it("spaces frames by the minimum interval", () => {
    const gate = new FrameGate(10); // 100 ms
    expect(gate.tryBegin(1000)).toBe(true);
    gate.ack();
    expect(gate.tryBegin(1050)).toBe(false);
    expect(gate.tryBegin(1099)).toBe(false);
    expect(gate.tryBegin(1100)).toBe(true);
  });

  it("drops frames while the previous one is not consumed, then resumes on ack", () => {
    const gate = new FrameGate(30);
    expect(gate.tryBegin(0)).toBe(true);
    // Far beyond the rate limit, but the UI has not acknowledged: nothing queues up.
    expect(gate.tryBegin(200)).toBe(false);
    expect(gate.tryBegin(900)).toBe(false);
    gate.ack();
    expect(gate.tryBegin(901)).toBe(true);
  });

  it("stops waiting for an acknowledgement that never comes (UI reloaded)", () => {
    const gate = new FrameGate(15);
    expect(gate.tryBegin(0)).toBe(true);
    expect(gate.tryBegin(FRAME_ACK_TIMEOUT_MS - 1)).toBe(false);
    expect(gate.tryBegin(FRAME_ACK_TIMEOUT_MS)).toBe(true);
  });

  it("clamps the requested rate and starts clean after a reset", () => {
    const gate = new FrameGate(500);
    expect(gate.tryBegin(0)).toBe(true);
    gate.ack();
    expect(gate.tryBegin(Math.round(1000 / MAX_FRAME_FPS) - 1)).toBe(false);
    gate.reset();
    expect(gate.tryBegin(1)).toBe(true);
    gate.setFps(1);
    gate.ack();
    expect(gate.tryBegin(900)).toBe(false);
    expect(gate.tryBegin(1001)).toBe(true);
  });
});

describe("fitWithin", () => {
  it("never upscales and keeps the aspect ratio when scaling down", () => {
    expect(fitWithin(640, 360)).toEqual({ width: 640, height: 360 });
    expect(fitWithin(1920, 1080)).toEqual({ width: 1280, height: 720 });
    expect(fitWithin(1000, 1000)).toEqual({ width: 720, height: 720 });
    expect(fitWithin(3840, 400)).toEqual({ width: 1280, height: 133 });
  });
});

describe("bgraPremulToRgba", () => {
  it("swaps B and R and keeps opaque pixels", () => {
    const out = bgraPremulToRgba(new Uint8Array([10, 20, 30, 255]), 1, 1);
    expect([...out]).toEqual([30, 20, 10, 255]);
  });

  it("un-premultiplies translucent pixels and clears fully transparent ones", () => {
    // alpha 128: premultiplied BGR (50,25,100) -> straight RGB (199,50,100).
    const src = new Uint8Array([50, 25, 100, 128, 7, 8, 9, 0]);
    const out = bgraPremulToRgba(src, 2, 1);
    expect(Array.from(out.slice(0, 4))).toEqual([199, 50, 100, 128]);
    expect(Array.from(out.slice(4))).toEqual([0, 0, 0, 0]);
  });

  it("reuses the destination buffer and refuses a frame whose pixels do not match its size", () => {
    const dst = new Uint8ClampedArray(4);
    expect(bgraPremulToRgba(new Uint8Array([1, 2, 3, 255]), 1, 1, dst)).toBe(dst);
    expect(() => bgraPremulToRgba(new Uint8Array(3), 1, 1)).toThrow();
    expect(() => bgraPremulToRgba(new Uint8Array(16), 0, 4)).toThrow();
    expect(() => bgraPremulToRgba(new Uint8Array(4), 2, 2)).toThrow();
  });
});
