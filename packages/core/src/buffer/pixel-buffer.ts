import type { Rect } from '../util/geometry.js';

/**
 * A 2D grid of pixel *values*. In indexed documents a value is a palette index; in RGBA documents it is
 * a packed 0xRRGGBBAA colour. Value 0 is transparent in both modes.
 */
export class PixelBuffer {
  readonly width: number;
  readonly height: number;
  readonly data: Uint32Array;

  constructor(width: number, height: number, data?: Uint32Array) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
      throw new RangeError(`Invalid buffer size ${width}x${height}`);
    }
    this.width = width;
    this.height = height;
    this.data = data ?? new Uint32Array(width * height);
    if (this.data.length !== width * height) throw new RangeError('Buffer data length mismatch');
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  get(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.data[y * this.width + x]!;
  }

  set(x: number, y: number, v: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.data[y * this.width + x] = v;
  }

  clone(): PixelBuffer {
    return new PixelBuffer(this.width, this.height, this.data.slice());
  }

  fill(v: number): this {
    this.data.fill(v);
    return this;
  }

  isEmpty(): boolean {
    for (let i = 0; i < this.data.length; i++) if (this.data[i] !== 0) return false;
    return true;
  }

  /** Bounding rect of non-transparent pixels, or null. */
  bounds(): Rect | null {
    const { width: w, height: h, data } = this;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (data[row + x] !== 0) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          y1 = y;
        }
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /** Copy of a sub-rectangle (out-of-range pixels become 0). */
  crop(r: Rect): PixelBuffer {
    const out = new PixelBuffer(r.w, r.h);
    for (let y = 0; y < r.h; y++) {
      const sy = r.y + y;
      if (sy < 0 || sy >= this.height) continue;
      for (let x = 0; x < r.w; x++) {
        const sx = r.x + x;
        if (sx < 0 || sx >= this.width) continue;
        out.data[y * r.w + x] = this.data[sy * this.width + sx]!;
      }
    }
    return out;
  }

  /** Copy `src` onto this buffer at (dx, dy). `skipTransparent` leaves destination where src is 0. */
  blit(src: PixelBuffer, dx: number, dy: number, skipTransparent = false): void {
    for (let y = 0; y < src.height; y++) {
      const ty = dy + y;
      if (ty < 0 || ty >= this.height) continue;
      for (let x = 0; x < src.width; x++) {
        const tx = dx + x;
        if (tx < 0 || tx >= this.width) continue;
        const v = src.data[y * src.width + x]!;
        if (skipTransparent && v === 0) continue;
        this.data[ty * this.width + tx] = v;
      }
    }
  }

  equals(other: PixelBuffer): boolean {
    if (other.width !== this.width || other.height !== this.height) return false;
    const a = this.data;
    const b = other.data;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** Map every value through `fn` (in place). */
  mapValues(fn: (v: number, x: number, y: number) => number): number {
    let changed = 0;
    const { width: w, data } = this;
    for (let i = 0; i < data.length; i++) {
      const v = data[i]!;
      const nv = fn(v, i % w, (i / w) | 0) >>> 0;
      if (nv !== v) {
        data[i] = nv;
        changed++;
      }
    }
    return changed;
  }

  /** Histogram of values. */
  histogram(): Map<number, number> {
    const m = new Map<number, number>();
    for (let i = 0; i < this.data.length; i++) {
      const v = this.data[i]!;
      m.set(v, (m.get(v) ?? 0) + 1);
    }
    return m;
  }
}

/** Bounding rect of cells that differ between two equally sized buffers. */
export function diffBounds(a: PixelBuffer, b: PixelBuffer): Rect | null {
  if (a.width !== b.width || a.height !== b.height) {
    return { x: 0, y: 0, w: Math.max(a.width, b.width), h: Math.max(a.height, b.height) };
  }
  const w = a.width;
  let x0 = w;
  let y0 = a.height;
  let x1 = -1;
  let y1 = -1;
  const da = a.data;
  const db = b.data;
  for (let i = 0; i < da.length; i++) {
    if (da[i] !== db[i]) {
      const x = i % w;
      const y = (i / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
