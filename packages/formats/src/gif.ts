/**
 * GIF89a encoder (animated), with LZW compression, a global palette and 1-bit transparency.
 * Limitations are reported as warnings: > 255 colours (quantised), semi-transparency (thresholded),
 * delays (centiseconds, minimum 20 ms in browsers).
 */
import { ByteWriter } from './bytes.js';
import type { AnimFrame } from './apng.js';

export interface GifOptions {
  /** 0 = infinite (default). */
  loops?: number;
  /** Alpha below this is transparent (default 128). */
  alphaThreshold?: number;
  /** Optional quantiser for > 255 colours: maps a list of colours to ≤ 255 colours. */
  quantize?: (colors: Map<number, number>, max: number) => number[];
}

export interface GifResult {
  bytes: Uint8Array;
  warnings: string[];
  colors: number;
}

class BitWriter {
  private bytes: number[] = [];
  private cur = 0;
  private bits = 0;
  write(code: number, size: number): void {
    this.cur |= code << this.bits;
    this.bits += size;
    while (this.bits >= 8) {
      this.bytes.push(this.cur & 255);
      this.cur >>>= 8;
      this.bits -= 8;
    }
  }
  finish(): number[] {
    if (this.bits > 0) this.bytes.push(this.cur & 255);
    this.cur = 0;
    this.bits = 0;
    return this.bytes;
  }
}

/** GIF-flavoured LZW (variable code size up to 12 bits, clear on full table). */
export function lzwEncode(indices: Uint8Array, minCodeSize: number): number[] {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let next = eoi + 1;
  let size = minCodeSize + 1;
  let table = new Map<number, number>();
  const out = new BitWriter();
  out.write(clear, size);
  if (indices.length === 0) {
    out.write(eoi, size);
    return out.finish();
  }
  let prefix = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const kk = (prefix << 8) | k;
    const code = table.get(kk);
    if (code !== undefined) {
      prefix = code;
      continue;
    }
    out.write(prefix, size);
    if (next === 4096) {
      out.write(clear, size);
      next = eoi + 1;
      size = minCodeSize + 1;
      table = new Map();
    } else {
      if (next >= 1 << size) size++;
      table.set(kk, next++);
    }
    prefix = k;
  }
  out.write(prefix, size);
  out.write(eoi, size);
  return out.finish();
}

function rgbKey(d: Uint8Array | Uint8ClampedArray, i: number): number {
  return ((d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!) >>> 0;
}

export function encodeGif(frames: readonly AnimFrame[], opts: GifOptions = {}): GifResult {
  if (!frames.length) throw new RangeError('GIF needs at least one frame');
  const { width, height } = frames[0]!.image;
  const threshold = opts.alphaThreshold ?? 128;
  const warnings: string[] = [];
  // collect colours
  const counts = new Map<number, number>();
  let semi = 0;
  let hasTransparent = false;
  for (const f of frames) {
    if (f.image.width !== width || f.image.height !== height)
      throw new RangeError('All GIF frames must share the same size');
    const d = f.image.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3]!;
      if (a > 0 && a < 255) semi++;
      if (a < threshold) {
        hasTransparent = true;
        continue;
      }
      const k = rgbKey(d, i);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  if (semi)
    warnings.push(
      `${semi} semi-transparent pixel(s) were thresholded at alpha ${threshold} (GIF supports only 1-bit transparency)`,
    );
  const maxColors = hasTransparent ? 255 : 256;
  let palette: number[];
  let mapColor: (rgb: number) => number;
  if (counts.size <= maxColors) {
    palette = [...counts.keys()];
    const lut = new Map(palette.map((c, i) => [c, i + (hasTransparent ? 1 : 0)]));
    mapColor = (rgb) => lut.get(rgb)!;
  } else {
    if (!opts.quantize)
      throw new RangeError(
        `GIF supports ${maxColors} colours, animation has ${counts.size}; provide a quantiser`,
      );
    palette = opts.quantize(counts, maxColors).slice(0, maxColors);
    warnings.push(`Animation has ${counts.size} colours; quantised to ${palette.length} for GIF`);
    const cache = new Map<number, number>();
    mapColor = (rgb) => {
      let idx = cache.get(rgb);
      if (idx !== undefined) return idx;
      let best = 0;
      let bestD = Infinity;
      const r = rgb >>> 16;
      const g = (rgb >>> 8) & 255;
      const b = rgb & 255;
      palette.forEach((c, i) => {
        const dr = (c >>> 16) - r;
        const dg = ((c >>> 8) & 255) - g;
        const db = (c & 255) - b;
        const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      idx = best + (hasTransparent ? 1 : 0);
      cache.set(rgb, idx);
      return idx;
    };
  }
  const entries = palette.length + (hasTransparent ? 1 : 0);
  let tableBits = 1;
  while (1 << tableBits < Math.max(2, entries)) tableBits++;
  const w = new ByteWriter(64 * 1024, true);
  w.bytes(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])); // GIF89a
  w.u16(width).u16(height);
  w.u8(0x80 | ((tableBits - 1) << 4) | (tableBits - 1)); // global table, colour resolution, size
  w.u8(0).u8(0); // background index, aspect
  const tableSize = 1 << tableBits;
  for (let i = 0; i < tableSize; i++) {
    const pi = hasTransparent ? i - 1 : i;
    const c = pi >= 0 && pi < palette.length ? palette[pi]! : 0;
    w.u8(c >>> 16)
      .u8((c >>> 8) & 255)
      .u8(c & 255);
  }
  if (frames.length > 1) {
    w.u8(0x21).u8(0xff).u8(11);
    for (const ch of 'NETSCAPE2.0') w.u8(ch.charCodeAt(0));
    w.u8(3)
      .u8(1)
      .u16(opts.loops ?? 0)
      .u8(0);
  }
  let rounded = 0;
  let clamped = 0;
  for (const f of frames) {
    let cs = Math.round(f.duration / 10);
    if (cs * 10 !== f.duration) rounded++;
    if (cs < 2) {
      cs = 2;
      clamped++;
    }
    // graphic control extension: disposal 2 (restore to background)
    w.u8(0x21).u8(0xf9).u8(4);
    w.u8((2 << 2) | (hasTransparent ? 1 : 0));
    w.u16(cs);
    w.u8(0).u8(0);
    // crop to opaque bounds (safe with disposal 2)
    const d = f.image.data;
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        if (d[(y * width + x) * 4 + 3]! >= threshold) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    if (x1 < 0) x0 = y0 = x1 = y1 = 0;
    const fw = x1 - x0 + 1;
    const fh = y1 - y0 + 1;
    w.u8(0x2c).u16(x0).u16(y0).u16(fw).u16(fh).u8(0);
    const indices = new Uint8Array(fw * fh);
    for (let y = 0; y < fh; y++)
      for (let x = 0; x < fw; x++) {
        const i = ((y0 + y) * width + (x0 + x)) * 4;
        indices[y * fw + x] = d[i + 3]! < threshold ? 0 : mapColor(rgbKey(d, i));
      }
    const minCode = Math.max(2, tableBits);
    w.u8(minCode);
    const data = lzwEncode(indices, minCode);
    for (let i = 0; i < data.length; i += 255) {
      const n = Math.min(255, data.length - i);
      w.u8(n);
      for (let k = 0; k < n; k++) w.u8(data[i + k]!);
    }
    w.u8(0);
  }
  w.u8(0x3b);
  if (rounded) warnings.push(`${rounded} frame duration(s) rounded to 10 ms steps (GIF stores centiseconds)`);
  if (clamped)
    warnings.push(
      `${clamped} frame(s) shorter than 20 ms were clamped to 20 ms (browsers slow shorter GIF delays to 100 ms)`,
    );
  return { bytes: w.toBytes(), warnings, colors: palette.length };
}

// ───────────────────────────── decoder (for imports/tests) ─────────────────────────────

export interface DecodedGifFrame {
  /** Full canvas RGBA after compositing this frame. */
  data: Uint8Array;
  duration: number;
}

export interface DecodedGif {
  width: number;
  height: number;
  frames: DecodedGifFrame[];
  loops: number;
}

function lzwDecode(data: Uint8Array, minCodeSize: number, pixelCount: number): Uint8Array {
  const out = new Uint8Array(pixelCount);
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let size = minCodeSize + 1;
  let next = eoi + 1;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const lengths = new Uint16Array(4096);
  for (let i = 0; i < clear; i++) {
    suffix[i] = i;
    lengths[i] = 1;
    prefix[i] = -1;
  }
  let pos = 0;
  let prev = -1;
  let o = 0;
  const firstOf = (code: number): number => {
    while (prefix[code]! >= 0) code = prefix[code]!;
    return suffix[code]!;
  };
  const emit = (code: number) => {
    const len = lengths[code]!;
    let c = code;
    for (let k = len - 1; k >= 0; k--) {
      if (o + k < pixelCount) out[o + k] = suffix[c]!;
      c = prefix[c]!;
    }
    o += len;
  };
  while (o < pixelCount) {
    if (pos + size > data.length * 8) break;
    let code = 0;
    for (let k = 0; k < size; k++) {
      const b = (data[(pos + k) >> 3]! >> ((pos + k) & 7)) & 1;
      code |= b << k;
    }
    pos += size;
    if (code === clear) {
      size = minCodeSize + 1;
      next = eoi + 1;
      prev = -1;
      continue;
    }
    if (code === eoi) break;
    if (prev === -1) {
      emit(code);
      prev = code;
      continue;
    }
    if (code < next) {
      emit(code);
      if (next < 4096) {
        prefix[next] = prev;
        suffix[next] = firstOf(code);
        lengths[next] = lengths[prev]! + 1;
        next++;
      }
    } else {
      const f = firstOf(prev);
      if (next < 4096) {
        prefix[next] = prev;
        suffix[next] = f;
        lengths[next] = lengths[prev]! + 1;
        next++;
      }
      emit(next - 1);
    }
    if (next >= 1 << size && size < 12) size++;
    prev = code;
  }
  return out;
}

export function decodeGif(bytes: Uint8Array): DecodedGif {
  const sig = String.fromCharCode(...bytes.subarray(0, 6));
  if (sig !== 'GIF89a' && sig !== 'GIF87a') throw new Error('Not a GIF file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = dv.getUint16(6, true);
  const height = dv.getUint16(8, true);
  const flags = bytes[10]!;
  let p = 13;
  let global: Uint8Array | null = null;
  if (flags & 0x80) {
    const n = 1 << ((flags & 7) + 1);
    global = bytes.subarray(p, p + n * 3);
    p += n * 3;
  }
  const canvas = new Uint8Array(width * height * 4);
  const frames: DecodedGifFrame[] = [];
  let loops = 1;
  let delay = 0;
  let transparent = -1;
  let disposal = 0;
  const subBlocks = (): Uint8Array => {
    const parts: number[] = [];
    while (p < bytes.length) {
      const n = bytes[p++]!;
      if (n === 0) break;
      for (let k = 0; k < n; k++) parts.push(bytes[p + k]!);
      p += n;
    }
    return Uint8Array.from(parts);
  };
  while (p < bytes.length) {
    const b = bytes[p++]!;
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = bytes[p++]!;
      if (label === 0xf9) {
        p++; // size
        const pf = bytes[p]!;
        disposal = (pf >> 2) & 7;
        delay = dv.getUint16(p + 1, true) * 10;
        transparent = pf & 1 ? bytes[p + 3]! : -1;
        p += 4;
        p++; // terminator
      } else if (label === 0xff) {
        const blk = subBlocks();
        if (blk.length >= 14 && String.fromCharCode(...blk.subarray(0, 11)) === 'NETSCAPE2.0')
          loops = blk[12]! | (blk[13]! << 8);
      } else subBlocks();
    } else if (b === 0x2c) {
      const x = dv.getUint16(p, true);
      const y = dv.getUint16(p + 2, true);
      const fw = dv.getUint16(p + 4, true);
      const fh = dv.getUint16(p + 6, true);
      const lf = bytes[p + 8]!;
      p += 9;
      let table = global;
      if (lf & 0x80) {
        const n = 1 << ((lf & 7) + 1);
        table = bytes.subarray(p, p + n * 3);
        p += n * 3;
      }
      const min = bytes[p++]!;
      const idx = lzwDecode(subBlocks(), min, fw * fh);
      const before = disposal === 3 ? canvas.slice() : null;
      for (let yy = 0; yy < fh; yy++)
        for (let xx = 0; xx < fw; xx++) {
          const v = idx[yy * fw + xx]!;
          if (v === transparent) continue;
          const di = ((y + yy) * width + (x + xx)) * 4;
          canvas[di] = table ? table[v * 3]! : 0;
          canvas[di + 1] = table ? table[v * 3 + 1]! : 0;
          canvas[di + 2] = table ? table[v * 3 + 2]! : 0;
          canvas[di + 3] = 255;
        }
      frames.push({ data: canvas.slice(), duration: delay });
      if (disposal === 2)
        for (let yy = 0; yy < fh; yy++)
          canvas.fill(0, ((y + yy) * width + x) * 4, ((y + yy) * width + x + fw) * 4);
      else if (disposal === 3 && before) canvas.set(before);
      transparent = -1;
      disposal = 0;
      delay = 0;
    } else break;
  }
  return { width, height, frames, loops };
}
