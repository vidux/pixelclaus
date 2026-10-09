/**
 * Packed colour helpers. A packed colour is an unsigned 32-bit integer 0xRRGGBBAA.
 * Fully transparent colours are normalised to 0.
 */
export type Packed = number;

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export const TRANSPARENT: Packed = 0;

export function pack(r: number, g: number, b: number, a = 255): Packed {
  if (a <= 0) return 0;
  return (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | (a & 255)) >>> 0;
}

export const red = (c: Packed): number => c >>> 24;
export const green = (c: Packed): number => (c >>> 16) & 255;
export const blue = (c: Packed): number => (c >>> 8) & 255;
export const alpha = (c: Packed): number => c & 255;

export function unpack(c: Packed): RGBA {
  return { r: c >>> 24, g: (c >>> 16) & 255, b: (c >>> 8) & 255, a: c & 255 };
}

export function fromRGBA(c: RGBA): Packed {
  return pack(Math.round(c.r), Math.round(c.g), Math.round(c.b), Math.round(c.a));
}

/** Normalise any colour with alpha 0 to the canonical transparent value 0. */
export function normalize(c: Packed): Packed {
  return (c & 255) === 0 ? 0 : c >>> 0;
}

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Parse #rgb, #rgba, #rrggbb, #rrggbbaa (leading # optional). Returns null when invalid. */
export function parseHex(input: string): Packed | null {
  const m = HEX_RE.exec(input.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  if (h.length === 6) h += 'ff';
  const v = parseInt(h, 16) >>> 0;
  return normalize(v);
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** '#rrggbb' for opaque colours, '#rrggbbaa' otherwise (or always with `withAlpha`). */
export function toHex(c: Packed, withAlpha = false): string {
  const { r, g, b, a } = unpack(c);
  const base = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  return withAlpha || a !== 255 ? base + hex2(a) : base;
}

/** Canonical 9-char form used in persisted palettes. */
export function toHex8(c: Packed): string {
  return toHex(c, true);
}

/** Write a packed colour into an RGBA byte array. */
export function writeRGBA(out: Uint8Array | Uint8ClampedArray, offset: number, c: Packed): void {
  out[offset] = c >>> 24;
  out[offset + 1] = (c >>> 16) & 255;
  out[offset + 2] = (c >>> 8) & 255;
  out[offset + 3] = c & 255;
}

export function readRGBA(src: Uint8Array | Uint8ClampedArray, offset: number): Packed {
  return pack(src[offset]!, src[offset + 1]!, src[offset + 2]!, src[offset + 3]!);
}

/** Max per-channel difference (0..255), used for fill tolerance. */
export function channelDistance(a: Packed, b: Packed): number {
  return Math.max(
    Math.abs((a >>> 24) - (b >>> 24)),
    Math.abs(((a >>> 16) & 255) - ((b >>> 16) & 255)),
    Math.abs(((a >>> 8) & 255) - ((b >>> 8) & 255)),
    Math.abs((a & 255) - (b & 255)),
  );
}

/** Mix two colours (straight alpha) with weight t of `b`. */
export function mix(a: Packed, b: Packed, t: number): Packed {
  const A = unpack(a);
  const B = unpack(b);
  return pack(
    Math.round(A.r + (B.r - A.r) * t),
    Math.round(A.g + (B.g - A.g) * t),
    Math.round(A.b + (B.b - A.b) * t),
    Math.round(A.a + (B.a - A.a) * t),
  );
}
