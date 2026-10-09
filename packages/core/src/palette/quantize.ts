/**
 * Colour quantisation (median cut) and palette mapping with optional dithering.
 */
import { alpha, pack, unpack, type Packed } from '../color/rgba.js';
import { PaletteMatcher } from './match.js';
import { bayerThreshold } from '../draw/dither.js';

interface Box {
  colors: Array<{ c: Packed; n: number }>;
}

function channel(c: Packed, ch: number): number {
  return (c >>> (24 - ch * 8)) & 255;
}

/** Reduce a histogram of opaque colours to at most `max` representative colours. */
export function medianCut(histogram: Map<Packed, number>, max: number): Packed[] {
  const entries = [...histogram.entries()].filter(([c]) => alpha(c) > 0).map(([c, n]) => ({ c, n }));
  if (entries.length <= max) return entries.map((e) => e.c);
  const boxes: Box[] = [{ colors: entries }];
  while (boxes.length < max) {
    // split the box with the largest channel range
    let bestBox = -1;
    let bestRange = -1;
    let bestCh = 0;
    boxes.forEach((b, bi) => {
      if (b.colors.length < 2) return;
      for (let ch = 0; ch < 3; ch++) {
        let lo = 255;
        let hi = 0;
        for (const e of b.colors) {
          const v = channel(e.c, ch);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (hi - lo > bestRange) {
          bestRange = hi - lo;
          bestBox = bi;
          bestCh = ch;
        }
      }
    });
    if (bestBox < 0) break;
    const box = boxes[bestBox]!;
    box.colors.sort((a, b) => channel(a.c, bestCh) - channel(b.c, bestCh));
    const total = box.colors.reduce((s, e) => s + e.n, 0);
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.colors.length - 1; i++) {
      acc += box.colors[i]!.n;
      if (acc >= total / 2) {
        cut = i + 1;
        break;
      }
    }
    boxes.splice(bestBox, 1, { colors: box.colors.slice(0, cut) }, { colors: box.colors.slice(cut) });
  }
  return boxes.map((b) => {
    let r = 0;
    let g = 0;
    let bl = 0;
    let n = 0;
    for (const e of b.colors) {
      const u = unpack(e.c);
      r += u.r * e.n;
      g += u.g * e.n;
      bl += u.b * e.n;
      n += e.n;
    }
    return pack(Math.round(r / n), Math.round(g / n), Math.round(bl / n), 255);
  });
}

export type DitherMethod = 'none' | 'bayer2' | 'bayer4' | 'bayer8' | 'floyd-steinberg';

/**
 * Map RGBA colours (row-major `width`×`height`) to palette indices.
 * Returns an index per pixel; transparent pixels (alpha < 128) map to 0.
 */
export function mapToPalette(
  pixels: ArrayLike<Packed>,
  width: number,
  height: number,
  palette: readonly Packed[],
  dither: DitherMethod = 'none',
  strength = 1,
): Uint32Array {
  const matcher = new PaletteMatcher(palette);
  const out = new Uint32Array(width * height);
  if (dither === 'floyd-steinberg') {
    const err = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const c = pixels[i]!;
        if (alpha(c) < 128) continue;
        const u = unpack(c);
        const r = clamp(u.r + err[i * 3]!);
        const g = clamp(u.g + err[i * 3 + 1]!);
        const b = clamp(u.b + err[i * 3 + 2]!);
        const idx = matcher.nearest(pack(r, g, b, 255));
        out[i] = idx;
        const p = unpack(palette[idx]!);
        const er = (r - p.r) * strength;
        const eg = (g - p.g) * strength;
        const eb = (b - p.b) * strength;
        const spread = (dx: number, dy: number, f: number) => {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny >= height) return;
          const j = (ny * width + nx) * 3;
          err[j] = err[j]! + er * f;
          err[j + 1] = err[j + 1]! + eg * f;
          err[j + 2] = err[j + 2]! + eb * f;
        };
        spread(1, 0, 7 / 16);
        spread(-1, 1, 3 / 16);
        spread(0, 1, 5 / 16);
        spread(1, 1, 1 / 16);
      }
    }
    return out;
  }
  const size = dither === 'bayer2' ? 2 : dither === 'bayer4' ? 4 : dither === 'bayer8' ? 8 : 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const c = pixels[i]!;
      if (alpha(c) < 128) continue;
      if (size === 0) {
        out[i] = matcher.nearest(c);
        continue;
      }
      const t = (bayerThreshold(size, x, y) - 0.5) * 48 * strength;
      const u = unpack(c);
      out[i] = matcher.nearest(pack(clamp(u.r + t), clamp(u.g + t), clamp(u.b + t), 255));
    }
  }
  return out;
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
