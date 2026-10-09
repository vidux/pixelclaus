import type { Mask } from '../buffer/mask.js';
import type { PixelBuffer } from '../buffer/pixel-buffer.js';
import { blendInto } from '../color/blend.js';
import type { ColorResolver } from '../model/colors.js';
import { unionRect, type Rect } from '../util/geometry.js';
import { ensureCovers, targetImage, type DrawTarget } from './target.js';

/**
 * Ink modes:
 * - replace: write the value (default)
 * - behind: only write where the pixel is empty
 * - inside: only write where the pixel is non-empty (alpha lock)
 * - blend: alpha-composite the colour over the existing pixel (useful for semi-transparent RGBA colours)
 */
export type Ink = 'replace' | 'behind' | 'inside' | 'blend';

/** Mirror axes in canvas space. `true` → canvas centre. */
export interface Symmetry {
  x?: number | true;
  y?: number | true;
}

export interface WriterOptions {
  clip?: Mask | null;
  symmetry?: Symmetry | null;
  ink?: Ink;
  resolver: ColorResolver;
}

/** Writes pixels into a draw target honouring canvas bounds, clip masks, symmetry and ink. */
export class PixelWriter {
  readonly target: DrawTarget;
  written = 0;
  clipped = 0;
  private x0 = Infinity;
  private y0 = Infinity;
  private x1 = -Infinity;
  private y1 = -Infinity;

  private img: PixelBuffer;
  private readonly clip: Mask | null;
  private readonly ink: Ink;
  private readonly resolver: ColorResolver;
  private readonly ax: number | null;
  private readonly ay: number | null;
  private readonly w: number;
  private readonly h: number;
  private prepared = false;

  constructor(target: DrawTarget, opts: WriterOptions) {
    this.target = target;
    this.clip = opts.clip ?? null;
    this.ink = opts.ink ?? 'replace';
    this.resolver = opts.resolver;
    this.w = target.tx.state.width;
    this.h = target.tx.state.height;
    const s = opts.symmetry;
    this.ax = s?.x === undefined ? null : s.x === true ? (this.w - 1) / 2 : s.x;
    this.ay = s?.y === undefined ? null : s.y === true ? (this.h - 1) / 2 : s.y;
    this.img = targetImage(target);
  }

  /** Grow the cel so that `area` (plus mirrored copies) is writable. `null` = whole canvas. */
  prepare(area: Rect | null): void {
    let r: Rect | null = area;
    if (r && this.ax !== null)
      r = unionRect(r, { x: Math.round(2 * this.ax - (r.x + r.w - 1)), y: r.y, w: r.w, h: r.h });
    if (r && this.ay !== null)
      r = unionRect(r, { x: r.x, y: Math.round(2 * this.ay - (r.y + r.h - 1)), w: r.w, h: r.h });
    ensureCovers(this.target, r);
    this.img = targetImage(this.target);
    this.prepared = true;
  }

  /** Current value at canvas coordinates. */
  get(x: number, y: number): number {
    return this.img.get(x - this.target.cel.x, y - this.target.cel.y);
  }

  plot(x: number, y: number, value: number): void {
    if (!this.prepared) this.prepare(null);
    this.plotOne(x, y, value);
    if (this.ax !== null) {
      const mx = Math.round(2 * this.ax - x);
      if (mx !== x) this.plotOne(mx, y, value);
      if (this.ay !== null) {
        const my = Math.round(2 * this.ay - y);
        if (my !== y) {
          this.plotOne(x, my, value);
          if (mx !== x) this.plotOne(mx, my, value);
        }
      }
    } else if (this.ay !== null) {
      const my = Math.round(2 * this.ay - y);
      if (my !== y) this.plotOne(x, my, value);
    }
  }

  private plotOne(x: number, y: number, value: number): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    if (this.clip && !this.clip.has(x, y)) {
      this.clipped++;
      return;
    }
    const ix = x - this.target.cel.x;
    const iy = y - this.target.cel.y;
    if (ix < 0 || iy < 0 || ix >= this.img.width || iy >= this.img.height) return;
    const i = iy * this.img.width + ix;
    const cur = this.img.data[i]!;
    let v = value;
    switch (this.ink) {
      case 'behind':
        if (cur !== 0) return;
        break;
      case 'inside':
        if (cur === 0) return;
        break;
      case 'blend':
        v = this.blendValue(cur, value);
        break;
      default:
        break;
    }
    if (cur === v) return;
    this.img.data[i] = v;
    this.written++;
    if (x < this.x0) this.x0 = x;
    if (y < this.y0) this.y0 = y;
    if (x > this.x1) this.x1 = x;
    if (y > this.y1) this.y1 = y;
  }

  /** Canvas-space bounding rect of written pixels. */
  get dirty(): Rect | null {
    return this.written === 0
      ? null
      : { x: this.x0, y: this.y0, w: this.x1 - this.x0 + 1, h: this.y1 - this.y0 + 1 };
  }

  private blendValue(cur: number, value: number): number {
    const src = this.resolver.rgba(value);
    if ((src & 255) === 255 || cur === 0) return value;
    const dst = this.resolver.rgba(cur);
    const tmp = new Uint8Array([dst >>> 24, (dst >>> 16) & 255, (dst >>> 8) & 255, dst & 255]);
    blendInto(tmp, 0, src >>> 24, (src >>> 16) & 255, (src >>> 8) & 255, src & 255, 1, 'normal');
    const c = ((tmp[0]! << 24) | (tmp[1]! << 16) | (tmp[2]! << 8) | tmp[3]!) >>> 0;
    return this.resolver.fromRgba(c);
  }
}
