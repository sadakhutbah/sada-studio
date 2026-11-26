import { bgraPremulToRgba } from "./frame-gate";
import type { BrowserSourceFrame } from "./types";

/**
 * A raw frame from an offscreen window (web source, mosque screen) kept as a canvas the compositor draws from:
 * one `putImageData` per frame, the pixel buffer reused while the size stays the same, no decoding.
 */
export class FrameCanvas {
  readonly canvas: HTMLCanvasElement;
  private pixels: Uint8ClampedArray<ArrayBuffer> | null = null;
  private filled = false;

  constructor() {
    this.canvas = document.createElement("canvas");
  }

  get hasFrame(): boolean {
    return this.filled;
  }

  put(frame: BrowserSourceFrame): void {
    const { width, height } = frame;
    const canvas = this.canvas;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      this.pixels = null;
    }
    const rgba = bgraPremulToRgba(frame.bgra, width, height, this.pixels ?? undefined);
    this.pixels = rgba;
    canvas.getContext("2d")?.putImageData(new ImageData(rgba, width, height), 0, 0);
    this.filled = true;
  }

  /** Forgets the frame (the canvas keeps its pixels until the next `put`, but is no longer offered). */
  clear(): void {
    this.filled = false;
  }

  /** Frees the pixel memory. */
  release(): void {
    this.filled = false;
    this.pixels = null;
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}
