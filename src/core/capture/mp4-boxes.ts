/** One unit handed to the player: the initialization segment (ftyp + moov) or one media fragment (moof + mdat). */
export interface Mp4Chunk {
  init: boolean;
  data: Uint8Array;
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

/**
 * Cuts the fragmented MP4 that ffmpeg writes on stdout (`frag_keyframe+empty_moov`) into whole units the browser's
 * MediaSource accepts: [ftyp moov] once, then [moof mdat] per fragment. Other boxes (free, sidx, mfra) are dropped.
 * One instance per ffmpeg process.
 */
export class Mp4Splitter {
  private buf: Uint8Array = new Uint8Array(0);
  private init: Uint8Array[] = [];
  private fragment: Uint8Array[] = [];

  /** Feeds raw bytes; returns the units completed by them. */
  push(bytes: Uint8Array): Mp4Chunk[] {
    this.buf = this.buf.length ? concat([this.buf, bytes]) : bytes;
    const out: Mp4Chunk[] = [];
    for (;;) {
      if (this.buf.length < 8) break;
      const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
      let size = view.getUint32(0);
      const type = fourcc(this.buf, 4);
      if (size === 1) {
        // 64-bit size (not written by ffmpeg for live fragments, handled for safety).
        if (this.buf.length < 16) break;
        size = Number(view.getBigUint64(8));
      }
      if (size < 8) throw new Error(`Invalid MP4 box size ${size} (${type})`);
      if (this.buf.length < size) break;
      const box = this.buf.slice(0, size);
      this.buf = this.buf.subarray(size);
      if (type === "ftyp") this.init = [box];
      else if (type === "moov") {
        this.init.push(box);
        out.push({ init: true, data: concat(this.init) });
        this.init = [];
      } else if (type === "moof") this.fragment = [box];
      else if (type === "mdat" && this.fragment.length) {
        this.fragment.push(box);
        out.push({ init: false, data: concat(this.fragment) });
        this.fragment = [];
      }
    }
    return out;
  }
}
