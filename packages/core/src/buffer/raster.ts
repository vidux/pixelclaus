import { blendInto, type BlendMode } from '../color/blend.js';
import type { Packed } from '../color/rgba.js';
import { forEachTextPixel, measureText, type BitmapFont } from '../render/font.js';
import { PixelClausError } from '../errors.js';
import type { Rect } from '../util/geometry.js';

/** Hard cap for any image the engine allocates (128 Mpx = 512 MB RGBA). */
export const MAX_RASTER_PIXELS = 1 << 27;

/**
 * Straight-alpha RGBA image (byte layout identical to browser ImageData). Rendering output of the
 * compositor and every preview view.
 */
export class Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;

  constructor(width: number, height: number, data?: Uint8ClampedArray) {
    this.width = Math.max(0, Math.floor(width));
    this.height = Math.max(0, Math.floor(height));
    if (!data && this.width * this.height > MAX_RASTER_PIXELS) {
      throw new PixelClausError(
        'INVALID_ARGUMENT',
        `Image of ${this.width}x${this.height} px is too large to create`,
        'Use a smaller scale, fewer frames per sheet or a region',
      );
    }
    this.data = data ?? new Uint8ClampedArray(this.width * this.height * 4);
    if (this.data.length !== this.width * this.height * 4)
      throw new RangeError('Raster data length mismatch');
  }

  static filled(width: number, height: number, color: Packed): Raster {
    const r = new Raster(width, height);
    r.fillRect({ x: 0, y: 0, w: width, h: height }, color);
    return r;
  }

  clone(): Raster {
    return new Raster(this.width, this.height, this.data.slice());
  }

  get(x: number, y: number): Packed {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    const i = (y * this.width + x) * 4;
    const d = this.data;
    if (d[i + 3] === 0) return 0;
    return ((d[i]! << 24) | (d[i + 1]! << 16) | (d[i + 2]! << 8) | d[i + 3]!) >>> 0;
  }

  set(x: number, y: number, c: Packed): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    this.data[i] = c >>> 24;
    this.data[i + 1] = (c >>> 16) & 255;
    this.data[i + 2] = (c >>> 8) & 255;
    this.data[i + 3] = c & 255;
  }

  /** Alpha-composite colour `c` over pixel (x, y). */
  blend(x: number, y: number, c: Packed, opacity = 1, mode: BlendMode = 'normal'): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    blendInto(
      this.data,
      (y * this.width + x) * 4,
      c >>> 24,
      (c >>> 16) & 255,
      (c >>> 8) & 255,
      c & 255,
      opacity,
      mode,
    );
  }

  fillRect(r: Rect, c: Packed, blend = false): void {
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, r.y);
    const x1 = Math.min(this.width, r.x + r.w);
    const y1 = Math.min(this.height, r.y + r.h);
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        if (blend) this.blend(x, y, c);
        else this.set(x, y, c);
      }
  }

  strokeRect(r: Rect, c: Packed, thickness = 1): void {
    for (let t = 0; t < thickness; t++) {
      this.fillRect({ x: r.x + t, y: r.y + t, w: r.w - 2 * t, h: 1 }, c, true);
      this.fillRect({ x: r.x + t, y: r.y + r.h - 1 - t, w: r.w - 2 * t, h: 1 }, c, true);
      this.fillRect({ x: r.x + t, y: r.y + t + 1, w: 1, h: r.h - 2 * t - 2 }, c, true);
      this.fillRect({ x: r.x + r.w - 1 - t, y: r.y + t + 1, w: 1, h: r.h - 2 * t - 2 }, c, true);
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, c: Packed): void {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0;
    let y = y0;
    for (;;) {
      this.blend(x, y, c);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /** Composite `src` onto this raster at (dx, dy) with integer nearest-neighbour `scale`. */
  draw(src: Raster, dx: number, dy: number, scale = 1, opacity = 1): void {
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const i = (y * src.width + x) * 4;
        const a = src.data[i + 3]!;
        if (a === 0) continue;
        const c = ((src.data[i]! << 24) | (src.data[i + 1]! << 16) | (src.data[i + 2]! << 8) | a) >>> 0;
        if (scale === 1) this.blend(dx + x, dy + y, c, opacity);
        else this.fillRectBlend(dx + x * scale, dy + y * scale, scale, scale, c, opacity);
      }
    }
  }

  private fillRectBlend(x: number, y: number, w: number, h: number, c: Packed, opacity: number): void {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + w);
    const y1 = Math.min(this.height, y + h);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.blend(xx, yy, c, opacity);
  }

  /** Nearest-neighbour integer upscale. */
  scaled(factor: number): Raster {
    const f = Math.max(1, Math.floor(factor));
    if (f === 1) return this.clone();
    const out = new Raster(this.width * f, this.height * f);
    const s = this.data;
    const d = out.data;
    const ow = out.width;
    for (let y = 0; y < out.height; y++) {
      const sy = (y / f) | 0;
      for (let x = 0; x < ow; x++) {
        const si = (sy * this.width + ((x / f) | 0)) * 4;
        const di = (y * ow + x) * 4;
        d[di] = s[si]!;
        d[di + 1] = s[si + 1]!;
        d[di + 2] = s[si + 2]!;
        d[di + 3] = s[si + 3]!;
      }
    }
    return out;
  }

  crop(r: Rect): Raster {
    const out = new Raster(r.w, r.h);
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const sx = r.x + x;
        const sy = r.y + y;
        if (sx < 0 || sy < 0 || sx >= this.width || sy >= this.height) continue;
        const si = (sy * this.width + sx) * 4;
        const di = (y * r.w + x) * 4;
        out.data[di] = this.data[si]!;
        out.data[di + 1] = this.data[si + 1]!;
        out.data[di + 2] = this.data[si + 2]!;
        out.data[di + 3] = this.data[si + 3]!;
      }
    }
    return out;
  }

  /** Draw text with a bitmap font, each font pixel rendered as `scale`×`scale`. Returns drawn width. */
  text(font: BitmapFont, str: string, x: number, y: number, c: Packed, scale = 1): number {
    forEachTextPixel(font, str, 0, 0, (px, py) =>
      this.fillRectBlend(x + px * scale, y + py * scale, scale, scale, c, 1),
    );
    return measureText(font, str).width * scale;
  }

  /** Fill with a two-tone checkerboard (transparency backdrop). */
  checkerboard(cell: number, a: Packed, b: Packed, area?: Rect): void {
    const r = area ?? { x: 0, y: 0, w: this.width, h: this.height };
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const odd = (Math.floor((x - r.x) / cell) + Math.floor((y - r.y) / cell)) & 1;
        this.set(x, y, odd ? b : a);
      }
    }
  }

  /** True when every pixel has alpha 0. */
  isEmpty(): boolean {
    for (let i = 3; i < this.data.length; i += 4) if (this.data[i] !== 0) return false;
    return true;
  }

  /** Bounds of pixels with alpha > 0. */
  bounds(): Rect | null {
    let x0 = this.width;
    let y0 = this.height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.data[(y * this.width + x) * 4 + 3]! > 0) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          y1 = y;
        }
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
}
