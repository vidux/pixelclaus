/**
 * Animated PNG encoder. Frames after the first only encode the changed rectangle (blend SOURCE,
 * dispose NONE), which keeps files small for sprite animations. Uses a shared palette when the
 * whole animation has ≤ 256 colours.
 */
import { zlibSync } from 'fflate';
import { ByteWriter, utf8Encode } from './bytes.js';
import { PNG_SIGNATURE, pngParts, writePngChunk, type RgbaImage } from './png.js';

export interface AnimFrame {
  image: RgbaImage;
  /** Duration in milliseconds. */
  duration: number;
}

export interface ApngOptions {
  /** 0 = infinite */
  loops?: number;
  level?: number;
}

function key(d: Uint8Array | Uint8ClampedArray, i: number): number {
  const a = d[i + 3]!;
  return a === 0 ? 0 : ((d[i]! << 24) | (d[i + 1]! << 16) | (d[i + 2]! << 8) | a) >>> 0;
}

function sharedPalette(
  frames: readonly AnimFrame[],
): { palette: number[]; lookup: Map<number, number> } | null {
  const lookup = new Map<number, number>();
  const palette: number[] = [];
  for (const f of frames) {
    const d = f.image.data;
    for (let i = 0; i < d.length; i += 4) {
      const k = key(d, i);
      if (lookup.has(k)) continue;
      if (palette.length >= 256) return null;
      lookup.set(k, palette.length);
      palette.push(k);
    }
  }
  // translucent first for a short tRNS
  const order = palette.map((c, i) => ({ c, i })).sort((a, b) => (a.c & 255) - (b.c & 255) || a.i - b.i);
  const sorted = order.map((o) => o.c);
  const lk = new Map<number, number>();
  sorted.forEach((c, i) => lk.set(c, i));
  return { palette: sorted, lookup: lk };
}

function changedRect(a: RgbaImage, b: RgbaImage): { x: number; y: number; w: number; h: number } | null {
  let x0 = b.width;
  let y0 = b.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      const i = (y * b.width + x) * 4;
      if (key(a.data, i) !== key(b.data, i)) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function crop(img: RgbaImage, r: { x: number; y: number; w: number; h: number }): RgbaImage {
  const out = new Uint8Array(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++)
    out.set(
      img.data.subarray(((r.y + y) * img.width + r.x) * 4, ((r.y + y) * img.width + r.x + r.w) * 4),
      y * r.w * 4,
    );
  return { width: r.w, height: r.h, data: out };
}

export function encodeApng(frames: readonly AnimFrame[], opts: ApngOptions = {}): Uint8Array {
  if (!frames.length) throw new RangeError('APNG needs at least one frame');
  const { width, height } = frames[0]!.image;
  for (const f of frames)
    if (f.image.width !== width || f.image.height !== height)
      throw new RangeError('All APNG frames must share the same size');
  const shared = sharedPalette(frames) ?? undefined;
  const w = new ByteWriter(64 * 1024, false);
  w.bytes(PNG_SIGNATURE);
  const first = pngParts(frames[0]!.image, { mode: shared ? 'indexed' : 'rgba', level: opts.level }, shared);
  writePngChunk(w, 'IHDR', first.ihdr);
  writePngChunk(
    w,
    'acTL',
    new ByteWriter(8, false)
      .u32(frames.length)
      .u32(opts.loops ?? 0)
      .toBytes(),
  );
  if (first.plte) writePngChunk(w, 'PLTE', first.plte);
  if (first.trns) writePngChunk(w, 'tRNS', first.trns);
  writePngChunk(w, 'tEXt', utf8Encode('Software\0PixelClaus'));
  let seq = 0;
  const fctl = (fw: number, fh: number, x: number, y: number, ms: number) => {
    const b = new ByteWriter(26, false);
    b.u32(seq++).u32(fw).u32(fh).u32(x).u32(y);
    b.u16(Math.max(1, Math.round(ms))).u16(1000);
    b.u8(0).u8(0); // dispose NONE, blend SOURCE
    writePngChunk(w, 'fcTL', b.toBytes());
  };
  fctl(width, height, 0, 0, frames[0]!.duration);
  writePngChunk(w, 'IDAT', first.idat);
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1]!.image;
    const cur = frames[i]!.image;
    const r = changedRect(prev, cur) ?? { x: 0, y: 0, w: 1, h: 1 };
    const sub = crop(cur, r);
    const parts = pngParts(sub, { mode: shared ? 'indexed' : 'rgba', level: opts.level }, shared);
    fctl(r.w, r.h, r.x, r.y, frames[i]!.duration);
    const fd = new ByteWriter(parts.idat.length + 4, false);
    fd.u32(seq++).bytes(parts.idat);
    writePngChunk(w, 'fdAT', fd.toBytes());
  }
  writePngChunk(w, 'IEND', new Uint8Array(0));
  return w.toBytes();
}

/** Re-export to keep zlib tree-shaken usage explicit for consumers that need raw deflate. */
export const deflateZlib = (b: Uint8Array): Uint8Array => zlibSync(b, { level: 9 });
