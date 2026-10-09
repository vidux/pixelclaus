import type { Point, Rect } from '../util/geometry.js';

/** Binary selection mask in canvas space. Masks are treated as immutable once stored in a document. */
export class Mask {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  constructor(width: number, height: number, data?: Uint8Array) {
    this.width = width;
    this.height = height;
    this.data = data ?? new Uint8Array(width * height);
  }

  static full(width: number, height: number): Mask {
    return new Mask(width, height, new Uint8Array(width * height).fill(1));
  }

  static fromRect(width: number, height: number, r: Rect): Mask {
    const m = new Mask(width, height);
    const x0 = Math.max(0, Math.round(r.x));
    const y0 = Math.max(0, Math.round(r.y));
    const x1 = Math.min(width, Math.round(r.x) + Math.round(r.w));
    const y1 = Math.min(height, Math.round(r.y) + Math.round(r.h));
    for (let y = y0; y < y1; y++) m.data.fill(1, y * width + x0, y * width + x1);
    return m;
  }

  static fromPredicate(width: number, height: number, fn: (x: number, y: number) => boolean): Mask {
    const m = new Mask(width, height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (fn(x, y)) m.data[y * width + x] = 1;
    return m;
  }

  static fromPoints(width: number, height: number, pts: Iterable<Point>): Mask {
    const m = new Mask(width, height);
    for (const p of pts) m.set(p.x, p.y, true);
    return m;
  }

  has(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    return this.data[y * this.width + x] === 1;
  }

  set(x: number, y: number, on: boolean): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.data[y * this.width + x] = on ? 1 : 0;
  }

  clone(): Mask {
    return new Mask(this.width, this.height, this.data.slice());
  }

  count(): number {
    let n = 0;
    for (let i = 0; i < this.data.length; i++) n += this.data[i]!;
    return n;
  }

  isEmpty(): boolean {
    for (let i = 0; i < this.data.length; i++) if (this.data[i]) return false;
    return true;
  }

  bounds(): Rect | null {
    const { width: w, height: h, data } = this;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[y * w + x]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          y1 = y;
        }
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  invert(): Mask {
    const m = new Mask(this.width, this.height);
    for (let i = 0; i < this.data.length; i++) m.data[i] = this.data[i] ? 0 : 1;
    return m;
  }

  combine(other: Mask, mode: 'replace' | 'add' | 'subtract' | 'intersect'): Mask {
    if (mode === 'replace') return other.clone();
    const m = new Mask(this.width, this.height);
    for (let i = 0; i < m.data.length; i++) {
      const a = this.data[i]!;
      const b = other.data[i] ?? 0;
      m.data[i] = mode === 'add' ? a | b : mode === 'subtract' ? a & (b ^ 1) : a & b;
    }
    return m;
  }

  /** Dilate (n > 0) or erode (n < 0) by |n| pixels using 4- or 8-connectivity. */
  grow(n: number, connectivity: 4 | 8 = 8): Mask {
    let cur: Mask = this.clone();
    const steps = Math.abs(n);
    const dilate = n > 0;
    const nb = connectivity === 4 ? N4 : N8;
    for (let s = 0; s < steps; s++) {
      const next = cur.clone();
      for (let y = 0; y < this.height; y++) {
        for (let x = 0; x < this.width; x++) {
          const on = cur.has(x, y);
          if (dilate && !on) {
            if (nb.some(([dx, dy]) => cur.has(x + dx, y + dy))) next.set(x, y, true);
          } else if (!dilate && on) {
            if (nb.some(([dx, dy]) => !cur.has(x + dx, y + dy))) next.set(x, y, false);
          }
        }
      }
      cur = next;
    }
    return cur;
  }

  /** Pixels of the mask that touch the outside (inner border of width n). */
  border(n = 1, connectivity: 4 | 8 = 8): Mask {
    const inner = this.grow(-n, connectivity);
    return this.combine(inner, 'subtract');
  }

  translate(dx: number, dy: number): Mask {
    const m = new Mask(this.width, this.height);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.data[y * this.width + x]) m.set(x + dx, y + dy, true);
      }
    }
    return m;
  }

  /** Resize the mask canvas, placing old content at (ox, oy). */
  resized(width: number, height: number, ox: number, oy: number): Mask {
    const m = new Mask(width, height);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.data[y * this.width + x]) m.set(x + ox, y + oy, true);
      }
    }
    return m;
  }
}

export const N4: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export const N8: ReadonlyArray<readonly [number, number]> = [...N4, [1, 1], [-1, -1], [1, -1], [-1, 1]];
