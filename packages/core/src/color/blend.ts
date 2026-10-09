/**
 * Layer blend modes (the 19 Aseprite modes) using W3C compositing formulas on straight-alpha colours.
 */
export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'addition',
  'subtract',
  'divide',
] as const;

export type BlendMode = (typeof BLEND_MODES)[number];

type Sep = (cb: number, cs: number) => number;

const multiply: Sep = (cb, cs) => cb * cs;
const screen: Sep = (cb, cs) => cb + cs - cb * cs;
const hardLight: Sep = (cb, cs) => (cs <= 0.5 ? multiply(cb, 2 * cs) : screen(cb, 2 * cs - 1));

const SEPARABLE: Partial<Record<BlendMode, Sep>> = {
  normal: (_cb, cs) => cs,
  multiply,
  screen,
  overlay: (cb, cs) => hardLight(cs, cb),
  darken: (cb, cs) => Math.min(cb, cs),
  lighten: (cb, cs) => Math.max(cb, cs),
  'color-dodge': (cb, cs) => (cb === 0 ? 0 : cs >= 1 ? 1 : Math.min(1, cb / (1 - cs))),
  'color-burn': (cb, cs) => (cb >= 1 ? 1 : cs <= 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs)),
  'hard-light': hardLight,
  'soft-light': (cb, cs) => {
    if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
    const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
    return cb + (2 * cs - 1) * (d - cb);
  },
  difference: (cb, cs) => Math.abs(cb - cs),
  exclusion: (cb, cs) => cb + cs - 2 * cb * cs,
  addition: (cb, cs) => Math.min(1, cb + cs),
  subtract: (cb, cs) => Math.max(0, cb - cs),
  divide: (cb, cs) => (cs <= 0 ? (cb > 0 ? 1 : 0) : Math.min(1, cb / cs)),
};

type Rgb = [number, number, number];

const lum = (c: Rgb): number => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];

function clipColor(c: Rgb): Rgb {
  const l = lum(c);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  let out: Rgb = [...c];
  if (n < 0) out = out.map((v) => l + ((v - l) * l) / (l - n || 1)) as Rgb;
  if (x > 1) out = out.map((v) => l + ((v - l) * (1 - l)) / (x - l || 1)) as Rgb;
  return out;
}

function setLum(c: Rgb, l: number): Rgb {
  const d = l - lum(c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
}

const sat = (c: Rgb): number => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);

function setSat(c: Rgb, s: number): Rgb {
  const idx = [0, 1, 2].sort((a, b) => c[a]! - c[b]!);
  const [iMin, iMid, iMax] = idx as [number, number, number];
  const out: Rgb = [0, 0, 0];
  const cmax = c[iMax];
  const cmin = c[iMin];
  if (cmax > cmin) {
    out[iMid] = ((c[iMid] - cmin) * s) / (cmax - cmin);
    out[iMax] = s;
  }
  out[iMin] = 0;
  return out;
}

function nonSeparable(mode: BlendMode, cb: Rgb, cs: Rgb): Rgb {
  switch (mode) {
    case 'hue':
      return setLum(setSat(cs, sat(cb)), lum(cb));
    case 'saturation':
      return setLum(setSat(cb, sat(cs)), lum(cb));
    case 'color':
      return setLum(cs, lum(cb));
    case 'luminosity':
      return setLum(cb, lum(cs));
    default:
      return cs;
  }
}

/**
 * Composite a source pixel over a backdrop pixel in place.
 * `dst` is a byte array (RGBA straight alpha), `si` / `di` offsets. `sr..sa` are source bytes,
 * `opacity` 0..1 multiplies source alpha.
 */
export function blendInto(
  dst: Uint8ClampedArray | Uint8Array,
  di: number,
  sr: number,
  sg: number,
  sb: number,
  sa: number,
  opacity: number,
  mode: BlendMode,
): void {
  const as = (sa / 255) * opacity;
  if (as <= 0) return;
  const ab = dst[di + 3]! / 255;
  if (mode === 'normal' || ab === 0) {
    if (as >= 1) {
      dst[di] = sr;
      dst[di + 1] = sg;
      dst[di + 2] = sb;
      dst[di + 3] = 255;
      return;
    }
    const ao = as + ab * (1 - as);
    const k = ab * (1 - as);
    dst[di] = Math.round((sr * as + dst[di]! * k) / ao);
    dst[di + 1] = Math.round((sg * as + dst[di + 1]! * k) / ao);
    dst[di + 2] = Math.round((sb * as + dst[di + 2]! * k) / ao);
    dst[di + 3] = Math.round(ao * 255);
    return;
  }
  const cb: Rgb = [dst[di]! / 255, dst[di + 1]! / 255, dst[di + 2]! / 255];
  const cs: Rgb = [sr / 255, sg / 255, sb / 255];
  const f = SEPARABLE[mode];
  const B: Rgb = f ? [f(cb[0], cs[0]), f(cb[1], cs[1]), f(cb[2], cs[2])] : nonSeparable(mode, cb, cs);
  const ao = as + ab * (1 - as);
  for (let i = 0; i < 3; i++) {
    // W3C: Cs' = (1 - ab) * Cs + ab * B ; Co = as*Cs' + (1-as)*ab*Cb, then un-premultiply
    const csPrime = (1 - ab) * cs[i]! + ab * B[i]!;
    const co = as * csPrime + (1 - as) * ab * cb[i]!;
    dst[di + i] = Math.round(Math.max(0, Math.min(1, co / ao)) * 255);
  }
  dst[di + 3] = Math.round(ao * 255);
}

export function isBlendMode(v: string): v is BlendMode {
  return (BLEND_MODES as readonly string[]).includes(v);
}
