/**
 * Annotated previews tuned for an AI reviewer: integer upscale, checkerboard, pixel grid, 0-indexed rulers,
 * 1x/2x actual-size insets and a palette strip.
 */
import { Raster } from '../buffer/raster.js';
import { relativeLuminance } from '../color/oklab.js';
import { pack, type Packed } from '../color/rgba.js';
import type { Rect } from '../util/geometry.js';
import { FONT_3X5, measureText } from './font.js';

export const PREVIEW_BG = pack(38, 38, 42);
export const PREVIEW_TEXT = pack(224, 224, 224);
export const PREVIEW_DIM = pack(140, 140, 150);
// low-contrast checks, two per source pixel, so empty cells never read as drawn grey/white pixels
export const CHECKER_A = pack(196, 196, 200);
export const CHECKER_B = pack(214, 214, 218);
const GRID_DARK = pack(0, 0, 0, 80);
const GRID_LIGHT = pack(255, 255, 255, 70);
const GRID_MAJOR = pack(40, 110, 255, 220);
const INSET_BG = pack(128, 128, 128);

export interface SwatchInfo {
  index: number;
  color: Packed;
  count?: number;
}

export interface PreviewOptions {
  /** Integer upscale. Default: auto so the longest side is ~`maxSize`. */
  scale?: number;
  /** Target size of the longest side for auto scale (default 640, cap 1024). */
  maxSize?: number;
  /** Per-pixel grid (default when scale ≥ 8). */
  grid?: boolean;
  /** Major grid spacing in source pixels (default 8; 0 disables). */
  majorGrid?: number;
  rulers?: boolean;
  /** Solid background colour; null → checkerboard. */
  background?: Packed | null;
  /** 1x and 2x actual-size insets (default true when scale ≥ 3). */
  inset?: boolean;
  /** Swatches to list under the image. */
  swatches?: readonly SwatchInfo[];
  /** Canvas-space crop. Rulers keep absolute coordinates. */
  region?: Rect;
  /** Per-pixel label (e.g. palette index) drawn when cells are large enough. */
  label?: (x: number, y: number) => string | null;
  /** Lines of text appended under the preview. */
  caption?: readonly string[];
  /** Extra overlay drawn in output space after the grid: receives (raster, toOutX, toOutY, scale). */
  overlay?: (out: Raster, ox: number, oy: number, scale: number) => void;
}

export function autoScale(w: number, h: number, maxSize = 640): number {
  const m = Math.max(w, h, 1);
  return Math.max(1, Math.min(64, Math.floor(Math.min(1024, maxSize) / m)));
}

function rulerStep(scale: number, digits: number, ls: number): number {
  const labelW = digits * 4 * ls + 2;
  for (const s of [1, 2, 4, 5, 8, 10, 16, 20, 25, 32, 50, 64, 100, 128, 200, 256, 500])
    if (s * scale >= labelW + 3) return s;
  return 1000;
}

export function buildPreview(src: Raster, opts: PreviewOptions = {}): Raster {
  const region = opts.region ?? { x: 0, y: 0, w: src.width, h: src.height };
  const img = opts.region ? src.crop(region) : src;
  const scale = Math.max(1, Math.floor(opts.scale ?? autoScale(img.width, img.height, opts.maxSize)));
  const ls = scale >= 4 ? 2 : 1; // label font scale
  const font = FONT_3X5;
  const rulers = opts.rulers ?? true;
  const maxCoord = Math.max(region.x + region.w, region.y + region.h);
  const digits = String(Math.max(0, maxCoord - 1)).length;
  const leftW = rulers ? digits * 4 * ls + 8 : 4;
  const topH = rulers ? font.height * ls + 8 : 4;
  const iw = img.width * scale;
  const ih = img.height * scale;
  const showInset = opts.inset ?? scale >= 3;
  const insetW = showInset ? Math.max(img.width * 2 + 8, 24) + 12 : 0;
  const swatches = opts.swatches ?? [];
  const sw = 26;
  const swGap = 6;
  const swLabelH = font.height * 2 + 3 + font.height + 2;
  const contentW = leftW + iw + insetW + 8;
  const perRow = Math.max(1, Math.floor((contentW - 8) / (sw + swGap)));
  const swRows = swatches.length ? Math.ceil(swatches.length / perRow) : 0;
  const swH = swRows ? swRows * (sw + swLabelH + 4) + 6 : 0;
  const caption = opts.caption ?? [];
  const capH = caption.length ? caption.length * (font.height + 3) + 6 : 0;
  const insetH = showInset ? 10 + img.height + 12 + img.height * 2 + 8 : 0;
  const W = contentW;
  const H = Math.max(topH + ih + 6, topH + insetH) + swH + capH;
  const out = Raster.filled(W, H, PREVIEW_BG);
  const ox = leftW;
  const oy = topH;

  // backdrop
  if (opts.background) out.fillRect({ x: ox, y: oy, w: iw, h: ih }, opts.background);
  else
    out.checkerboard(scale >= 8 ? Math.max(4, scale >> 1) : 8, CHECKER_A, CHECKER_B, {
      x: ox,
      y: oy,
      w: iw,
      h: ih,
    });
  out.draw(img, ox, oy, scale);

  // grid
  const grid = opts.grid ?? scale >= 8;
  const major = opts.majorGrid ?? 8;
  if (grid && scale >= 4) {
    // per-cell line colour: dark lines over light pixels, light lines over dark pixels
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const c = img.get(x, y);
        const ink = c !== 0 && (c & 255) > 128 && relativeLuminance(c) < 0.18 ? GRID_LIGHT : GRID_DARK;
        if (x > 0) out.fillRect({ x: ox + x * scale, y: oy + y * scale, w: 1, h: scale }, ink, true);
        if (y > 0) out.fillRect({ x: ox + x * scale + 1, y: oy + y * scale, w: scale - 1, h: 1 }, ink, true);
      }
    }
  }
  if (major > 0 && scale >= 2) {
    for (let x = 0; x <= img.width; x++)
      if ((region.x + x) % major === 0 && x > 0 && x < img.width)
        out.fillRect({ x: ox + x * scale, y: oy, w: 1, h: ih }, GRID_MAJOR, true);
    for (let y = 0; y <= img.height; y++)
      if ((region.y + y) % major === 0 && y > 0 && y < img.height)
        out.fillRect({ x: ox, y: oy + y * scale, w: iw, h: 1 }, GRID_MAJOR, true);
  }

  // labels in cells
  if (opts.label && scale >= 12) {
    const lsc = scale >= 26 ? 2 : 1;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const t = opts.label(region.x + x, region.y + y);
        if (!t) continue;
        const m = measureText(font, t);
        if (m.width * lsc > scale - 2) continue;
        const c = img.get(x, y);
        const lum = c === 0 ? 1 : relativeLuminance(c);
        const ink = lum > 0.35 ? pack(0, 0, 0) : pack(255, 255, 255);
        out.text(
          font,
          t,
          ox + x * scale + Math.floor((scale - m.width * lsc) / 2),
          oy + y * scale + Math.floor((scale - m.height * lsc) / 2),
          ink,
          lsc,
        );
      }
    }
  }

  opts.overlay?.(out, ox, oy, scale);
  out.strokeRect({ x: ox - 1, y: oy - 1, w: iw + 2, h: ih + 2 }, PREVIEW_DIM);

  // rulers
  if (rulers) {
    const step = rulerStep(scale, digits, ls);
    for (let x = 0; x < img.width; x++) {
      const ax = region.x + x;
      const cx = ox + x * scale + Math.floor(scale / 2);
      if (ax % step === 0) {
        const t = String(ax);
        const tw = measureText(font, t).width * ls;
        out.text(font, t, Math.min(W - tw - 1, Math.max(0, cx - Math.floor(tw / 2))), 2, PREVIEW_TEXT, ls);
        out.fillRect({ x: cx, y: topH - 4, w: 1, h: 3 }, PREVIEW_TEXT);
      } else if (scale >= 6) out.fillRect({ x: cx, y: topH - 2, w: 1, h: 1 }, PREVIEW_DIM);
    }
    for (let y = 0; y < img.height; y++) {
      const ay = region.y + y;
      const cy = oy + y * scale + Math.floor(scale / 2);
      if (ay % step === 0) {
        const t = String(ay);
        const tw = measureText(font, t).width * ls;
        out.text(
          font,
          t,
          leftW - tw - 5,
          Math.max(topH, cy - Math.floor((font.height * ls) / 2)),
          PREVIEW_TEXT,
          ls,
        );
        out.fillRect({ x: leftW - 4, y: cy, w: 3, h: 1 }, PREVIEW_TEXT);
      } else if (scale >= 6) out.fillRect({ x: leftW - 2, y: cy, w: 1, h: 1 }, PREVIEW_DIM);
    }
  }

  // insets
  if (showInset) {
    const ix = ox + iw + 12;
    let iy = oy;
    out.text(font, '1X', ix, iy, PREVIEW_DIM, 1);
    iy += 8;
    out.fillRect({ x: ix, y: iy, w: img.width + 4, h: img.height + 4 }, opts.background ?? INSET_BG);
    out.draw(img, ix + 2, iy + 2, 1);
    iy += img.height + 8;
    out.text(font, '2X', ix, iy, PREVIEW_DIM, 1);
    iy += 8;
    out.fillRect({ x: ix, y: iy, w: img.width * 2 + 4, h: img.height * 2 + 4 }, opts.background ?? INSET_BG);
    out.draw(img, ix + 2, iy + 2, 2);
  }

  // palette strip
  let y0 = Math.max(topH + ih + 6, topH + insetH);
  if (swatches.length) {
    y0 += 4;
    swatches.forEach((s, i) => {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const x = 8 + col * (sw + swGap);
      const y = y0 + row * (sw + swLabelH + 4);
      if (s.color === 0) out.checkerboard(4, CHECKER_A, CHECKER_B, { x, y, w: sw, h: sw });
      else out.fillRect({ x, y, w: sw, h: sw }, s.color);
      out.strokeRect({ x: x - 1, y: y - 1, w: sw + 2, h: sw + 2 }, PREVIEW_DIM);
      const t = s.index >= 0 ? String(s.index) : '-';
      const tw = measureText(font, t).width * 2;
      out.text(font, t, x + Math.floor((sw - tw) / 2), y + sw + 3, PREVIEW_TEXT, 2);
      const hex = s.color === 0 ? '' : (s.color >>> 8).toString(16).padStart(6, '0').toUpperCase();
      const hw = measureText(font, hex).width;
      out.text(font, hex, x + Math.floor((sw - hw) / 2), y + sw + 3 + font.height * 2 + 2, PREVIEW_DIM, 1);
    });
    y0 += swH;
  }
  caption.forEach((line, i) =>
    out.text(font, line.toUpperCase(), 8, y0 + 3 + i * (font.height + 3), PREVIEW_TEXT, 1),
  );
  return out;
}
