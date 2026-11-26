import { describe, expect, it } from "vitest";
import { encodeQr, reedSolomon } from "../src/core/program/qr";

/** Reads the codewords back (unmasked, zigzag order), skipping the function modules of a version-1 code. */
function readV1(q: ReturnType<typeof encodeQr>): number[] {
  const size = q.size;
  const fn = (x: number, y: number) => x === 6 || y === 6 || (x < 9 && y < 9) || (x >= size - 8 && y < 9) || (x < 9 && y >= size - 8);
  const masks = [(x: number, y: number) => (x + y) % 2 === 0];
  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fn(x, y)) bits.push((q.isDark(y, x) ? 1 : 0) ^ (masks[0]!(x, y) ? 1 : 0));
      }
    }
  }
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  return out;
}

describe("QR encoder", () => {
  it("picks the smallest version for byte mode at level L (the engine's module count)", () => {
    expect(encodeQr("HELLO").size).toBe(21);
    expect(encodeQr("https://sadakhutbah.org/don").size).toBe(25); // version 2
    expect(encodeQr("https://example.org/" + "a".repeat(120)).version).toBe(7); // as segno / reportlab
  });

  it("computes the Reed-Solomon bytes of the standard (same as segno for the same data)", () => {
    const data = "40 54 84 54 c4 c4 f0 00 ec 11 ec 11 ec 11 ec 11 ec 11 ec".split(" ").map((h) => parseInt(h, 16));
    expect(reedSolomon(data, 7)).toEqual([0x3d, 0x85, 0x35, 0xa8, 0xbf, 0xeb, 0x54]);
  });

  it("places mode, length, data, terminator, padding and error correction where a reader expects them", () => {
    const q = encodeQr("HELLO", "L", 0);
    const words = readV1(q);
    const data = [0x40, 0x54, 0x84, 0x54, 0xc4, 0xc4, 0xf0, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
    expect(words.slice(0, 19)).toEqual(data);
    expect(words.slice(19, 26)).toEqual(reedSolomon(data, 7));
  });

  it("draws the finder patterns, timing lines and the dark module", () => {
    const q = encodeQr("https://sadakhutbah.org/don");
    const n = q.size;
    for (const [r, c] of [
      [0, 0],
      [0, n - 7],
      [n - 7, 0],
    ] as const) {
      for (let i = 0; i < 7; i++) {
        expect(q.isDark(r, c + i)).toBe(true);
        expect(q.isDark(r + 6, c + i)).toBe(true);
      }
      expect(q.isDark(r + 1, c + 1)).toBe(false);
      expect(q.isDark(r + 3, c + 3)).toBe(true);
    }
    for (let i = 8; i < n - 8; i++) expect(q.isDark(6, i)).toBe(i % 2 === 0);
    expect(q.isDark(n - 8, 8)).toBe(true);
  });

  it("encodes UTF-8 (accents) as bytes", () => {
    expect(() => encodeQr("https://exemple.fr/don?m=mosquée")).not.toThrow();
  });
});
