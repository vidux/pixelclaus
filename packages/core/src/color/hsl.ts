/** HSL/HSV helpers used by colour adjustments. h in degrees, s/l/v in 0..1. */
import { pack, unpack, type Packed } from './rgba.js';

export interface HSL {
  h: number;
  s: number;
  l: number;
}

export function rgbToHsl(r: number, g: number, b: number): HSL {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return { h: h * 60, s, l };
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

export function hslToRgb(hsl: HSL): { r: number; g: number; b: number } {
  const h = (((hsl.h % 360) + 360) % 360) / 360;
  const s = Math.max(0, Math.min(1, hsl.s));
  const l = Math.max(0, Math.min(1, hsl.l));
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

export interface ColorAdjustment {
  /** Hue rotation in degrees */
  hue?: number;
  /** Saturation delta -1..1 (relative) */
  saturation?: number;
  /** Lightness delta -1..1 (absolute) */
  lightness?: number;
  /** Brightness delta -1..1 (adds to RGB) */
  brightness?: number;
  /** Contrast delta -1..1 */
  contrast?: number;
  invert?: boolean;
  desaturate?: boolean;
}

export function adjustColor(c: Packed, adj: ColorAdjustment): Packed {
  if (c === 0) return 0;
  let { r, g, b } = unpack(c);
  const a = c & 255;
  if (adj.invert) {
    r = 255 - r;
    g = 255 - g;
    b = 255 - b;
  }
  if (adj.hue || adj.saturation || adj.lightness || adj.desaturate) {
    const hsl = rgbToHsl(r, g, b);
    if (adj.hue) hsl.h += adj.hue;
    if (adj.saturation) hsl.s = hsl.s * (1 + adj.saturation);
    if (adj.desaturate) hsl.s = 0;
    if (adj.lightness) hsl.l += adj.lightness;
    ({ r, g, b } = hslToRgb(hsl));
  }
  if (adj.brightness) {
    const d = adj.brightness * 255;
    r += d;
    g += d;
    b += d;
  }
  if (adj.contrast) {
    const f = 1 + adj.contrast;
    r = (r - 128) * f + 128;
    g = (g - 128) * f + 128;
    b = (b - 128) * f + 128;
  }
  const cl = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return pack(cl(r), cl(g), cl(b), a);
}
