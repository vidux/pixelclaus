/**
 * PNG encoder/decoder (pure TS + fflate).
 * Encoder: indexed (PLTE/tRNS, 1/2/4/8-bit) when ≤ 256 colours, otherwise RGBA8 with adaptive filters.
 * Decoder: all colour types and bit depths, including Adam7 interlacing; returns straight RGBA.
 */
import { unzlibSync, zlibSync } from 'fflate';
import { ByteWriter, crcFinal, crcUpdate, utf8Encode } from './bytes.js';

export interface RgbaImage {
  width: number;
  height: number;
  /** Straight-alpha RGBA bytes, length = width*height*4 */
  data: Uint8Array | Uint8ClampedArray;
}

export interface PngEncodeOptions {
  /** 'auto' (default) picks indexed when possible. */
  mode?: 'auto' | 'rgba' | 'indexed';
  /** zlib level 0-9 (default 9) */
  level?: number;
  /** tEXt chunks */
  text?: Record<string, string>;
}

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function chunk(w: ByteWriter, type: string, data: Uint8Array): void {
  const t = utf8Encode(type);
  w.u32(data.length);
  w.bytes(t);
  w.bytes(data);
  w.u32(crcFinal(crcUpdate(crcUpdate(0xffffffff, t), data)));
}

/** Map RGBA pixels to a palette if there are ≤ 256 distinct colours. */
export function indexColors(img: RgbaImage): { palette: number[]; indices: Uint8Array } | null {
  const map = new Map<number, number>();
  const palette: number[] = [];
  const n = img.width * img.height;
  const indices = new Uint8Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3]!;
    const key = a === 0 ? 0 : ((d[i * 4]! << 24) | (d[i * 4 + 1]! << 16) | (d[i * 4 + 2]! << 8) | a) >>> 0;
    let idx = map.get(key);
    if (idx === undefined) {
      if (palette.length >= 256) return null;
      idx = palette.length;
      map.set(key, idx);
      palette.push(key);
    }
    indices[i] = idx;
  }
  // put transparent/translucent entries first so tRNS stays short
  const order = palette.map((c, i) => ({ c, i })).sort((a, b) => (a.c & 255) - (b.c & 255) || a.i - b.i);
  const remap = new Uint8Array(palette.length);
  order.forEach((o, ni) => (remap[o.i] = ni));
  for (let i = 0; i < n; i++) indices[i] = remap[indices[i]!]!;
  return { palette: order.map((o) => o.c), indices };
}

function packRows(indices: Uint8Array, width: number, height: number, bits: number): Uint8Array {
  const rowBytes = Math.ceil((width * bits) / 8);
  const out = new Uint8Array(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    const o = y * (rowBytes + 1);
    out[o] = 0; // filter none
    if (bits === 8) {
      out.set(indices.subarray(y * width, (y + 1) * width), o + 1);
      continue;
    }
    const perByte = 8 / bits;
    for (let x = 0; x < width; x++) {
      const v = indices[y * width + x]!;
      const bi = o + 1 + Math.floor(x / perByte);
      const shift = 8 - bits * ((x % perByte) + 1);
      out[bi] = out[bi]! | (v << shift);
    }
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Adaptive filtering (minimum sum of absolute differences per row). */
function filterRows(raw: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(height * (stride + 1));
  const cand = Array.from({ length: 5 }, () => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? raw.subarray((y - 1) * stride, y * stride) : null;
    let best = 0;
    let bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = cand[f]!;
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const x = row[i]!;
        const a = i >= bpp ? row[i - bpp]! : 0;
        const b = prev ? prev[i]! : 0;
        const cc = prev && i >= bpp ? prev[i - bpp]! : 0;
        let v: number;
        switch (f) {
          case 0:
            v = x;
            break;
          case 1:
            v = x - a;
            break;
          case 2:
            v = x - b;
            break;
          case 3:
            v = x - ((a + b) >> 1);
            break;
          default:
            v = x - paeth(a, b, cc);
        }
        v &= 255;
        c[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    out[y * (stride + 1)] = best;
    out.set(cand[best]!, y * (stride + 1) + 1);
  }
  return out;
}

export interface EncodedPngParts {
  ihdr: Uint8Array;
  plte?: Uint8Array;
  trns?: Uint8Array;
  idat: Uint8Array;
}

/** Build PNG chunk payloads (shared by PNG and APNG encoders). */
export function pngParts(
  img: RgbaImage,
  opts: PngEncodeOptions = {},
  shared?: { palette: number[]; lookup: Map<number, number> },
): EncodedPngParts {
  const { width, height } = img;
  const level = (opts.level ?? 9) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  const ihdr = new ByteWriter(13, false);
  if (shared || opts.mode !== 'rgba') {
    let palette: number[];
    let indices: Uint8Array;
    if (shared) {
      palette = shared.palette;
      indices = new Uint8Array(width * height);
      const d = img.data;
      for (let i = 0; i < indices.length; i++) {
        const a = d[i * 4 + 3]!;
        const key =
          a === 0 ? 0 : ((d[i * 4]! << 24) | (d[i * 4 + 1]! << 16) | (d[i * 4 + 2]! << 8) | a) >>> 0;
        indices[i] = shared.lookup.get(key) ?? 0;
      }
    } else {
      const ix = indexColors(img);
      if (!ix) return rgbaParts(img, level); // > 256 colours
      ({ palette, indices } = ix);
    }
    const bits = palette.length <= 2 ? 1 : palette.length <= 4 ? 2 : palette.length <= 16 ? 4 : 8;
    ihdr.u32(width).u32(height).u8(bits).u8(3).u8(0).u8(0).u8(0);
    const plte = new Uint8Array(palette.length * 3);
    let lastAlpha = -1;
    palette.forEach((c, i) => {
      plte[i * 3] = c >>> 24;
      plte[i * 3 + 1] = (c >>> 16) & 255;
      plte[i * 3 + 2] = (c >>> 8) & 255;
      if ((c & 255) !== 255) lastAlpha = i;
    });
    const trns =
      lastAlpha >= 0 ? Uint8Array.from(palette.slice(0, lastAlpha + 1).map((c) => c & 255)) : undefined;
    return {
      ihdr: ihdr.toBytes(),
      plte,
      trns,
      idat: zlibSync(packRows(indices, width, height, bits), { level }),
    };
  }
  return rgbaParts(img, level);
}

function rgbaParts(img: RgbaImage, level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9): EncodedPngParts {
  const ihdr = new ByteWriter(13, false);
  ihdr.u32(img.width).u32(img.height).u8(8).u8(6).u8(0).u8(0).u8(0);
  const raw =
    img.data instanceof Uint8Array
      ? img.data
      : new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return { ihdr: ihdr.toBytes(), idat: zlibSync(filterRows(raw, img.width, img.height, 4), { level }) };
}

export function encodePng(img: RgbaImage, opts: PngEncodeOptions = {}): Uint8Array {
  if (img.width < 1 || img.height < 1) throw new RangeError('PNG must be at least 1x1');
  const parts = pngParts(img, opts);
  const w = new ByteWriter(parts.idat.length + 1024, false);
  w.bytes(SIGNATURE);
  chunk(w, 'IHDR', parts.ihdr);
  if (parts.plte) chunk(w, 'PLTE', parts.plte);
  if (parts.trns) chunk(w, 'tRNS', parts.trns);
  for (const [k, v] of Object.entries(opts.text ?? { Software: 'PixelClaus' }))
    chunk(w, 'tEXt', utf8Encode(`${k}\0${v}`));
  chunk(w, 'IDAT', parts.idat);
  chunk(w, 'IEND', new Uint8Array(0));
  return w.toBytes();
}

export { chunk as writePngChunk, SIGNATURE as PNG_SIGNATURE };

// ───────────────────────────── decoder ─────────────────────────────

export interface DecodedPng extends RgbaImage {
  data: Uint8Array;
  /** Original palette (packed RGBA) for indexed PNGs. */
  palette?: number[];
  /** Original palette indices for indexed PNGs (8-bit expanded). */
  indices?: Uint8Array;
}

function readU32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

export function isPng(b: Uint8Array): boolean {
  return b.length > 8 && SIGNATURE.every((v, i) => b[i] === v);
}

export function decodePng(bytes: Uint8Array): DecodedPng {
  if (!isPng(bytes)) throw new Error('Not a PNG file');
  let o = 8;
  let width = 0;
  let height = 0;
  let depth = 8;
  let ctype = 6;
  let interlace = 0;
  let plte: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (o + 8 <= bytes.length) {
    const len = readU32(bytes, o);
    const type = String.fromCharCode(bytes[o + 4]!, bytes[o + 5]!, bytes[o + 6]!, bytes[o + 7]!);
    const data = bytes.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      width = readU32(data, 0);
      height = readU32(data, 4);
      depth = data[8]!;
      ctype = data[9]!;
      interlace = data[12]!;
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (!width || !height) throw new Error('PNG missing IHDR');
  const total = idat.reduce((s, b) => s + b.length, 0);
  const z = new Uint8Array(total);
  let p = 0;
  for (const b of idat) {
    z.set(b, p);
    p += b.length;
  }
  const raw = unzlibSync(z);
  const channels = ctype === 0 ? 1 : ctype === 2 ? 3 : ctype === 3 ? 1 : ctype === 4 ? 2 : 4;
  const bitsPP = channels * depth;
  const bpp = Math.max(1, bitsPP >> 3);
  const out = new Uint8Array(width * height * 4);
  const indices = ctype === 3 ? new Uint8Array(width * height) : undefined;

  const passes = interlace
    ? [
        [0, 0, 8, 8],
        [4, 0, 8, 8],
        [0, 4, 4, 8],
        [2, 0, 4, 4],
        [0, 2, 2, 4],
        [1, 0, 2, 2],
        [0, 1, 1, 2],
      ]
    : [[0, 0, 1, 1]];
  let pos = 0;
  for (const [x0, y0, dx, dy] of passes as Array<[number, number, number, number]>) {
    const pw = Math.ceil((width - x0) / dx);
    const ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const stride = Math.ceil((pw * bitsPP) / 8);
    let prev = new Uint8Array(stride);
    for (let y = 0; y < ph; y++) {
      const f = raw[pos++]!;
      const row = raw.slice(pos, pos + stride);
      pos += stride;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp]! : 0;
        const b = prev[i]!;
        const c = i >= bpp ? prev[i - bpp]! : 0;
        switch (f) {
          case 1:
            row[i] = (row[i]! + a) & 255;
            break;
          case 2:
            row[i] = (row[i]! + b) & 255;
            break;
          case 3:
            row[i] = (row[i]! + ((a + b) >> 1)) & 255;
            break;
          case 4:
            row[i] = (row[i]! + paeth(a, b, c)) & 255;
            break;
          default:
            break;
        }
      }
      for (let x = 0; x < pw; x++) {
        const tx = x0 + x * dx;
        const ty = y0 + y * dy;
        const di = (ty * width + tx) * 4;
        const sample = (ch: number): number => {
          if (depth === 8) return row[x * channels + ch]!;
          if (depth === 16) return row[(x * channels + ch) * 2]!;
          const bitIndex = (x * channels + ch) * depth;
          const v = (row[bitIndex >> 3]! >> (8 - depth - (bitIndex & 7))) & ((1 << depth) - 1);
          return v;
        };
        const scale = (v: number) => (depth >= 8 ? v : Math.round((v * 255) / ((1 << depth) - 1)));
        if (ctype === 3) {
          const idx = sample(0);
          indices![ty * width + tx] = idx;
          out[di] = plte ? plte[idx * 3]! : 0;
          out[di + 1] = plte ? plte[idx * 3 + 1]! : 0;
          out[di + 2] = plte ? plte[idx * 3 + 2]! : 0;
          out[di + 3] = trns && idx < trns.length ? trns[idx]! : 255;
        } else if (ctype === 0 || ctype === 4) {
          const g = scale(sample(0));
          out[di] = out[di + 1] = out[di + 2] = g;
          let a = ctype === 4 ? sample(1) : 255;
          if (ctype === 0 && trns && trns.length >= 2) {
            const tv = depth === 16 ? trns[0]! : (trns[0]! << 8) | trns[1]!;
            if ((depth === 16 ? row[x * 2]! : sample(0)) === tv) a = 0;
          }
          out[di + 3] = a;
        } else {
          out[di] = sample(0);
          out[di + 1] = sample(1);
          out[di + 2] = sample(2);
          let a = ctype === 6 ? sample(3) : 255;
          if (ctype === 2 && trns && trns.length >= 6 && depth === 8) {
            if (out[di] === trns[1] && out[di + 1] === trns[3] && out[di + 2] === trns[5]) a = 0;
          }
          out[di + 3] = a;
        }
      }
      prev = row;
    }
  }
  const result: DecodedPng = { width, height, data: out };
  if (indices && plte) {
    result.indices = indices;
    result.palette = Array.from(
      { length: plte.length / 3 },
      (_, i) =>
        ((plte![i * 3]! << 24) |
          (plte![i * 3 + 1]! << 16) |
          (plte![i * 3 + 2]! << 8) |
          (trns && i < trns.length ? trns[i]! : 255)) >>>
        0,
    );
  }
  return result;
}
