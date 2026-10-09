/**
 * OKLab / OKLCH conversions (Björn Ottosson). Used for perceptual nearest-colour matching, ramps,
 * value (lightness) views and contrast lint.
 */
import { pack, unpack, type Packed } from './rgba.js';

export interface Lab {
  L: number;
  a: number;
  b: number;
}

export interface LCH {
  L: number;
  C: number;
  /** Hue in degrees 0..360 */
  h: number;
}

const toLinearTable = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  toLinearTable[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function toSrgb8(x: number): number {
  const c = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(Math.max(x, 0), 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

export function rgbToOklab(r: number, g: number, b: number): Lab {
  const lr = toLinearTable[r & 255]!;
  const lg = toLinearTable[g & 255]!;
  const lb = toLinearTable[b & 255]!;
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

export function oklabToRgb(lab: Lab): { r: number; g: number; b: number } {
  const l = Math.pow(lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b, 3);
  const m = Math.pow(lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b, 3);
  const s = Math.pow(lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b, 3);
  return {
    r: toSrgb8(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: toSrgb8(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: toSrgb8(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

export function packedToOklab(c: Packed): Lab {
  return rgbToOklab(c >>> 24, (c >>> 16) & 255, (c >>> 8) & 255);
}

export function oklabToPacked(lab: Lab, a = 255): Packed {
  const { r, g, b } = oklabToRgb(lab);
  return pack(r, g, b, a);
}

export function labToLch(lab: Lab): LCH {
  const C = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
  let h = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L: lab.L, C, h };
}

export function lchToLab(lch: LCH): Lab {
  const rad = (lch.h * Math.PI) / 180;
  return { L: lch.L, a: lch.C * Math.cos(rad), b: lch.C * Math.sin(rad) };
}

export function packedToOklch(c: Packed): LCH {
  return labToLch(packedToOklab(c));
}

/** OKLCH → packed sRGB, reducing chroma until the colour is in gamut. */
export function oklchToPacked(lch: LCH, a = 255): Packed {
  let C = lch.C;
  for (let i = 0; i < 24; i++) {
    const lab = lchToLab({ L: lch.L, C, h: lch.h });
    if (inGamut(lab)) return oklabToPacked(lab, a);
    C *= 0.9;
  }
  return oklabToPacked(lchToLab({ L: lch.L, C: 0, h: lch.h }), a);
}

function inGamut(lab: Lab): boolean {
  const l = Math.pow(lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b, 3);
  const m = Math.pow(lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b, 3);
  const s = Math.pow(lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b, 3);
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const e = 1e-4;
  return r >= -e && r <= 1 + e && g >= -e && g <= 1 + e && b >= -e && b <= 1 + e;
}

/** Euclidean OKLab distance (ΔE-OK). ~0.02 is barely perceptible; ~0.1 clearly different. */
export function deltaE(a: Lab, b: Lab): number {
  const dL = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

export function deltaEPacked(a: Packed, b: Packed): number {
  return deltaE(packedToOklab(a), packedToOklab(b));
}

/** Perceptual lightness 0..1 */
export function lightness(c: Packed): number {
  return packedToOklab(c).L;
}

/** Signed shortest hue difference b - a in degrees (-180..180]. */
export function hueDelta(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Relative luminance (WCAG) 0..1 for contrast checks. */
export function relativeLuminance(c: Packed): number {
  const { r, g, b } = unpack(c);
  return 0.2126 * toLinearTable[r]! + 0.7152 * toLinearTable[g]! + 0.0722 * toLinearTable[b]!;
}
