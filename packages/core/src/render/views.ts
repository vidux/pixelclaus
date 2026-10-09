/**
 * Render views for the agent feedback loop: composite, silhouette, value, indexed, onion, diff, tile,
 * filmstrip, trail, timing, contact sheet, palette.
 */
import { rasterDiffCount, rasterMetrics, playbackFrames } from '../analysis/metrics.js';
import { Raster } from '../buffer/raster.js';
import { deltaEPacked, lightness, relativeLuminance } from '../color/oklab.js';
import { mix, pack, parseHex, toHex, type Packed } from '../color/rgba.js';
import { invalidArg } from '../errors.js';
import { ColorResolver } from '../model/colors.js';
import type { SpriteDocument } from '../model/document.js';
import { assertFrame, getCel, resolveLayer, type FrameSpec } from '../model/lookup.js';
import { paletteValues } from '../model/palette-state.js';
import { PaletteMatcher } from '../palette/match.js';
import { sliceKeyAt } from '../ops/tags-slices.js';
import type { Rect } from '../util/geometry.js';
import { compositeFrame } from './composite.js';
import { FONT_3X5, measureText } from './font.js';
import {
  autoScale,
  buildPreview,
  CHECKER_A,
  CHECKER_B,
  PREVIEW_BG,
  PREVIEW_DIM,
  PREVIEW_TEXT,
  type SwatchInfo,
} from './preview.js';

export const VIEW_MODES = [
  'composite',
  'silhouette',
  'value',
  'indexed',
  'onion',
  'diff',
  'tile',
  'filmstrip',
  'trail',
  'timing',
  'contact',
  'palette',
] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

export interface RenderRequest {
  view?: ViewMode;
  frame?: number;
  /** Frames for filmstrip/trail/timing (default: all, or the tag). */
  frames?: FrameSpec;
  tag?: string;
  /** Isolate layers (ids or names). */
  layers?: readonly string[];
  includeHidden?: boolean;
  scale?: number;
  maxSize?: number;
  grid?: boolean;
  rulers?: boolean;
  inset?: boolean;
  /** Palette strip under the image (default true). */
  palette?: boolean;
  /** '#rrggbb' backdrop instead of checkerboard (defaults to settings.previewBackground). */
  background?: string | null;
  region?: Rect;
  /** Onion skin: `outline` (default) draws prev/next silhouettes in red/blue on top; `tint` ghosts them behind. */
  onion?: { prev?: number; next?: number; mode?: 'outline' | 'tint' };
  /** Second frame for diff (default frame+1, wrapping). */
  compareFrame?: number;
  /** Value view: quantise lightness into N bands. */
  posterize?: number;
  /** Baseline row drawn on filmstrip/trail. */
  baseline?: number;
  columns?: number;
  /** Tile view repetitions per axis (default 3). */
  tiles?: number;
}

export interface RenderOutput {
  raster: Raster;
  info: Record<string, unknown>;
}

function isolateIds(doc: SpriteDocument, refs?: readonly string[]): string[] | undefined {
  return refs?.length ? refs.map((r) => resolveLayer(doc, r).id) : undefined;
}

function frameRaster(doc: SpriteDocument, frame: number, req: RenderRequest): Raster {
  return compositeFrame(doc, {
    frame,
    isolate: isolateIds(doc, req.layers),
    includeHidden: req.includeHidden,
  });
}

function backgroundOf(doc: SpriteDocument, req: RenderRequest): Packed | null {
  const bg = req.background !== undefined ? req.background : doc.state.settings.previewBackground;
  if (!bg) return null;
  const v = parseHex(bg);
  if (v === null) throw invalidArg(`Invalid background '${bg}'`);
  return v;
}

/** Colours used in a raster with counts, mapped to palette indices when possible. */
export function swatchesFor(doc: SpriteDocument, r: Raster, region?: Rect): SwatchInfo[] {
  const matcher = new PaletteMatcher(paletteValues(doc.state.palette));
  const counts = new Map<Packed, number>();
  const area = region ?? { x: 0, y: 0, w: r.width, h: r.height };
  for (let y = area.y; y < area.y + area.h; y++) {
    for (let x = area.x; x < area.x + area.w; x++) {
      const c = r.get(x, y);
      if (c !== 0) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([color, count]) => ({ index: matcher.exact(color), color, count }))
    .sort((a, b) => (a.index < 0 ? 999 : a.index) - (b.index < 0 ? 999 : b.index) || b.count - a.count)
    .slice(0, 96);
}

function baseInfo(doc: SpriteDocument, r: Raster, extra: Record<string, unknown>): Record<string, unknown> {
  const m = rasterMetrics(r);
  return { size: `${doc.state.width}x${doc.state.height}`, bbox: m.bbox, opaquePixels: m.pixels, ...extra };
}

function swatchSummary(sw: SwatchInfo[]): string {
  return sw
    .slice(0, 40)
    .map((s) => `${s.index >= 0 ? s.index : toHex(s.color)}×${s.count}`)
    .join(' ');
}

/** No view ever returns an image larger than this (the render tool's maxSize ceiling). */
export const MAX_VIEW_SIZE = 1600;

/**
 * Render a feedback view. An explicit `scale` is honoured only while the image stays within
 * `maxSize` (≤ 1600 px): images are the most expensive thing an agent reads, and very large ones are
 * rejected by model APIs. When the scale is reduced, `info.scaleReduced` says so.
 */
export function renderView(doc: SpriteDocument, req: RenderRequest = {}): RenderOutput {
  if (req.scale === undefined) return renderViewAt(doc, req);
  const limit = Math.min(MAX_VIEW_SIZE, req.maxSize ?? MAX_VIEW_SIZE);
  const asked = Math.max(1, Math.round(req.scale));
  const span = Math.max(1, req.region?.w ?? doc.state.width, req.region?.h ?? doc.state.height);
  const repeat = req.view === 'tile' ? Math.max(2, Math.min(5, req.tiles ?? 3)) : 1;
  // cheap estimate first (content only) so a huge request never renders at full size
  let scale = Math.max(1, Math.min(asked, Math.floor(limit / (span * repeat))));
  let out = renderViewAt(doc, { ...req, scale });
  for (let i = 0; i < 4; i++) {
    const size = Math.max(out.raster.width, out.raster.height);
    if (size <= limit || scale === 1) break;
    scale = Math.max(1, Math.min(scale - 1, Math.floor((scale * limit) / size)));
    out = renderViewAt(doc, { ...req, scale });
  }
  if (scale !== asked)
    out.info.scaleReduced = `scale ${asked} → ${scale} to keep the image ≤ ${limit} px (use region to zoom in)`;
  return out;
}

function renderViewAt(doc: SpriteDocument, req: RenderRequest): RenderOutput {
  const view = req.view ?? 'composite';
  const frame = req.frame ?? 0;
  assertFrame(doc.state, frame);
  const bg = backgroundOf(doc, req);
  const common = {
    scale: req.scale,
    maxSize: req.maxSize,
    grid: req.grid,
    rulers: req.rulers,
    inset: req.inset,
    region: req.region,
    majorGrid: doc.state.grid.w >= 4 ? Math.min(doc.state.grid.w, doc.state.grid.h) : 8,
  };
  switch (view) {
    case 'composite': {
      const r = frameRaster(doc, frame, req);
      const sw = req.palette === false ? [] : swatchesFor(doc, r, req.region);
      const scale = req.scale ?? autoScale(req.region?.w ?? r.width, req.region?.h ?? r.height, req.maxSize);
      const clash =
        bg !== null
          ? swatchesFor(doc, r).filter((s) => s.color === bg || deltaEPacked(s.color, bg) < 0.03)
          : [];
      return {
        raster: buildPreview(r, { ...common, scale, background: bg, swatches: sw }),
        info: baseInfo(doc, r, {
          view,
          frame,
          scale,
          colors: sw.length,
          usage: swatchSummary(sw),
          layers: req.layers ?? 'all visible',
          ...(clash.length
            ? {
                warning: `backdrop ${toHex(bg!)} matches colour(s) ${clash.map((s) => (s.index >= 0 ? s.index : toHex(s.color))).join(',')} used in the sprite — those pixels are invisible in this preview`,
              }
            : {}),
        }),
      };
    }
    case 'silhouette': {
      const r = frameRaster(doc, frame, req);
      const s = new Raster(r.width, r.height);
      for (let i = 0; i < r.data.length; i += 4) if (r.data[i + 3]! > 0) s.data.set([0, 0, 0, 255], i);
      const scale = req.scale ?? autoScale(r.width, r.height, req.maxSize);
      return {
        raster: buildPreview(s, { ...common, scale, background: pack(255, 255, 255) }),
        info: baseInfo(doc, r, { view, frame, scale }),
      };
    }
    case 'value': {
      const r = frameRaster(doc, frame, req);
      const v = new Raster(r.width, r.height);
      const levels = req.posterize && req.posterize >= 2 ? req.posterize : 0;
      const used = new Set<number>();
      for (let i = 0; i < r.data.length; i += 4) {
        const a = r.data[i + 3]!;
        if (a === 0) continue;
        let L = lightness(pack(r.data[i]!, r.data[i + 1]!, r.data[i + 2]!));
        if (levels) L = Math.round(L * (levels - 1)) / (levels - 1);
        const g = Math.round(Math.max(0, Math.min(1, L)) * 255);
        used.add(g);
        v.data.set([g, g, g, a], i);
      }
      const scale = req.scale ?? autoScale(r.width, r.height, req.maxSize);
      return {
        raster: buildPreview(v, { ...common, scale, background: bg ?? pack(255, 0, 255) }),
        info: baseInfo(doc, r, {
          view,
          frame,
          scale,
          distinctValues: used.size,
          note: 'grayscale = OKLab lightness; regions should separate by value, not only hue',
        }),
      };
    }
    case 'indexed': {
      const r = frameRaster(doc, frame, req);
      const ids = isolateIds(doc, req.layers);
      const resolver = new ColorResolver(doc);
      const matcher = new PaletteMatcher(paletteValues(doc.state.palette));
      let label: (x: number, y: number) => string | null;
      if (ids && ids.length === 1) {
        const cel = getCel(doc.state, ids[0]!, frame);
        const img = cel ? doc.image(cel.imageId) : null;
        label = (x, y) => {
          if (!cel || !img) return null;
          const v = img.get(x - cel.x, y - cel.y);
          if (v === 0) return null;
          const i = resolver.indexOf(v);
          return i >= 0 ? String(i) : '?';
        };
      } else {
        label = (x, y) => {
          const c = r.get(x, y);
          if (c === 0) return null;
          const i = matcher.exact(c);
          return i >= 0 ? String(i) : '?';
        };
      }
      const span = Math.max(req.region?.w ?? r.width, req.region?.h ?? r.height);
      // labels need big cells; keep the image ≤ ~1024 px (no insets: the numbers are the point)
      const scale =
        req.scale ?? Math.max(1, Math.min(26, Math.floor((Math.min(1024, req.maxSize ?? 1024) - 60) / span)));
      const sw = swatchesFor(doc, r, req.region);
      return {
        raster: buildPreview(r, {
          ...common,
          scale,
          background: bg,
          swatches: sw,
          label,
          grid: true,
          inset: false,
        }),
        info: baseInfo(doc, r, {
          view,
          frame,
          scale,
          note:
            scale < 12
              ? 'canvas too large for per-cell labels; use region to zoom in or read_pixels'
              : 'each cell shows its palette index',
          usage: swatchSummary(sw),
        }),
      };
    }
    case 'onion': {
      const prev = req.onion?.prev ?? 1;
      const next = req.onion?.next ?? 1;
      const mode = req.onion?.mode ?? 'outline';
      const cur = frameRaster(doc, frame, req);
      const out = new Raster(cur.width, cur.height);
      const n = doc.state.frames.length;
      const others = (k: number) => frameRaster(doc, (((frame + k) % n) + n) % n, req);
      if (mode === 'tint') {
        const ghost = (r: Raster, tint: Packed, alphaK: number) => {
          for (let i = 0; i < r.data.length; i += 4) {
            if (r.data[i + 3] === 0) continue;
            const c = mix(pack(r.data[i]!, r.data[i + 1]!, r.data[i + 2]!), tint, 0.6);
            out.blend((i / 4) % r.width, Math.floor(i / 4 / r.width), c, alphaK);
          }
        };
        for (let k = prev; k >= 1; k--) ghost(others(-k), pack(255, 40, 40), 0.45 / k);
        for (let k = next; k >= 1; k--) ghost(others(k), pack(40, 90, 255), 0.45 / k);
        out.draw(cur, 0, 0, 1);
      } else {
        // current frame dimmed, neighbour silhouettes drawn ON TOP as solid edges so overlaps stay visible
        out.draw(cur, 0, 0, 1, 0.55);
        const edges = (r: Raster, color: Packed) => {
          for (let y = 0; y < r.height; y++) {
            for (let x = 0; x < r.width; x++) {
              if (r.get(x, y) === 0) continue;
              const edge =
                r.get(x + 1, y) === 0 ||
                r.get(x - 1, y) === 0 ||
                r.get(x, y + 1) === 0 ||
                r.get(x, y - 1) === 0 ||
                x === 0 ||
                y === 0 ||
                x === r.width - 1 ||
                y === r.height - 1;
              if (edge) out.set(x, y, color);
            }
          }
        };
        for (let k = prev; k >= 1; k--) edges(others(-k), pack(255, 50, 50, k === 1 ? 255 : 150));
        for (let k = next; k >= 1; k--) edges(others(k), pack(60, 110, 255, k === 1 ? 255 : 150));
      }
      const scale = req.scale ?? autoScale(cur.width, cur.height, req.maxSize);
      return {
        raster: buildPreview(out, { ...common, scale, background: bg }),
        info: baseInfo(doc, cur, {
          view,
          frame,
          scale,
          onion: { prev, next, mode },
          legend:
            mode === 'tint'
              ? 'current = full colour, previous = red ghost, next = blue ghost'
              : 'current = dimmed colour, previous frame silhouette edge = red, next = blue',
        }),
      };
    }
    case 'diff': {
      const n = doc.state.frames.length;
      const other = req.compareFrame ?? (frame + 1) % n;
      assertFrame(doc.state, other);
      const a = frameRaster(doc, frame, req);
      const b = frameRaster(doc, other, req);
      const out = new Raster(a.width, a.height);
      let added = 0;
      let removed = 0;
      let changed = 0;
      for (let y = 0; y < a.height; y++) {
        for (let x = 0; x < a.width; x++) {
          const ca = a.get(x, y);
          const cb = b.get(x, y);
          if (ca === cb) {
            if (ca !== 0) out.set(x, y, (ca & 0xffffff00) | 64);
          } else if (ca === 0) {
            out.set(x, y, pack(255, 0, 255));
            added++;
          } else if (cb === 0) {
            out.set(x, y, pack(0, 220, 255));
            removed++;
          } else {
            out.set(x, y, pack(255, 210, 0));
            changed++;
          }
        }
      }
      const scale = req.scale ?? autoScale(a.width, a.height, req.maxSize);
      return {
        raster: buildPreview(out, { ...common, scale, background: pack(40, 40, 40) }),
        info: {
          view,
          frameA: frame,
          frameB: other,
          scale,
          added,
          removed,
          recoloured: changed,
          total: rasterDiffCount(a, b),
          legend: 'dim = unchanged, magenta = added in B, cyan = removed in B, yellow = recoloured',
        },
      };
    }
    case 'tile': {
      const r = frameRaster(doc, frame, req);
      const k = Math.max(2, Math.min(5, req.tiles ?? 3));
      const t = new Raster(r.width * k, r.height * k);
      for (let ty = 0; ty < k; ty++) for (let tx = 0; tx < k; tx++) t.draw(r, tx * r.width, ty * r.height);
      const scale = req.scale ?? autoScale(t.width, t.height, req.maxSize ?? 768);
      // no grid/rulers/edge lines: they would sit exactly on the seams being judged
      return {
        raster: buildPreview(t, {
          ...common,
          region: undefined,
          scale,
          background: bg ?? PREVIEW_BG,
          grid: false,
          majorGrid: 0,
          rulers: false,
          inset: false,
        }),
        info: {
          view,
          frame,
          scale,
          tiles: `${k}x${k}`,
          note: 'look for visible seams and repeating hot spots; coordinates here are not canvas coordinates',
        },
      };
    }
    case 'filmstrip':
      return filmstrip(doc, req, bg);
    case 'trail':
      return trail(doc, req, bg);
    case 'timing':
      return timing(doc, req);
    case 'contact': {
      const span = Math.max(doc.state.width, doc.state.height);
      const panelScale = req.scale ?? Math.max(1, Math.floor(280 / span));
      const a = renderView(doc, {
        ...req,
        view: 'composite',
        palette: false,
        inset: false,
        scale: panelScale,
      });
      const s = renderView(doc, { ...req, view: 'silhouette', inset: false, scale: panelScale });
      const v = renderView(doc, { ...req, view: 'value', inset: false, scale: panelScale });
      const colors = swatchesFor(doc, frameRaster(doc, frame, req)).length;
      const gap = 8;
      const out = Raster.filled(
        a.raster.width + s.raster.width + v.raster.width + gap * 2,
        Math.max(a.raster.height, s.raster.height, v.raster.height) + 14,
        PREVIEW_BG,
      );
      out.text(FONT_3X5, 'COMPOSITE', 8, 3, PREVIEW_TEXT, 1);
      out.text(FONT_3X5, 'SILHOUETTE', a.raster.width + gap + 8, 3, PREVIEW_TEXT, 1);
      out.text(FONT_3X5, 'VALUE', a.raster.width + s.raster.width + 2 * gap + 8, 3, PREVIEW_TEXT, 1);
      out.draw(a.raster, 0, 12);
      out.draw(s.raster, a.raster.width + gap, 12);
      out.draw(v.raster, a.raster.width + s.raster.width + 2 * gap, 12);
      return { raster: out, info: { ...a.info, view, colors } };
    }
    case 'palette':
      return paletteView(doc);
  }
}

function filmstrip(doc: SpriteDocument, req: RenderRequest, bg: Packed | null): RenderOutput {
  const order = playbackFrames(doc, req);
  if (!order.length) throw invalidArg('No frames to show');
  const W = doc.state.width;
  const H = doc.state.height;
  const maxW = Math.min(1024, req.maxSize ?? 1024);
  const maxH = 760;
  const gap = 8;
  const labelH = 26; // two label lines at 2x
  // choose columns/scale to use the budget: biggest scale that fits all frames in ≤ maxW × maxH
  const options: Array<{ cols: number; scale: number; rows: number }> = [];
  for (let cols = 1; cols <= Math.min(order.length, req.columns ?? 32); cols++) {
    if (req.columns && cols !== req.columns) continue;
    const rows = Math.ceil(order.length / cols);
    const sw = Math.floor((maxW - gap * (cols + 1)) / (cols * W));
    const sh = Math.floor((maxH - 18 - rows * (labelH + gap)) / (rows * H));
    options.push({ cols, rows, scale: Math.max(1, Math.min(16, sw, sh)) });
  }
  // fewest rows (reads like a timeline) among layouts within 75% of the largest possible scale
  const top = Math.max(...options.map((o) => o.scale));
  const best = options
    .filter((o) => o.scale >= top * 0.75)
    .sort((a, b) => a.rows - b.rows || b.scale - a.scale)[0]!;
  const cols = best.cols;
  const scale = req.scale ?? best.scale;
  const rows = Math.ceil(order.length / cols);
  const cw = W * scale;
  const ch = H * scale;
  const out = Raster.filled(gap + cols * (cw + gap), gap + rows * (ch + labelH + gap) + 14, PREVIEW_BG);
  const metrics: Array<Record<string, unknown>> = [];
  let prev: Raster | null = null;
  order.forEach((f, i) => {
    const r = frameRaster(doc, f, req);
    const x = gap + (i % cols) * (cw + gap);
    const y = gap + Math.floor(i / cols) * (ch + labelH + gap);
    if (bg) out.fillRect({ x, y, w: cw, h: ch }, bg);
    else out.checkerboard(Math.max(4, scale >> 1), CHECKER_A, CHECKER_B, { x, y, w: cw, h: ch });
    out.draw(r, x, y, scale);
    if (req.baseline !== undefined) {
      out.fillRect(
        { x, y: y + (req.baseline + 1) * scale - 1, w: cw, h: Math.max(2, Math.floor(scale / 6)) },
        pack(255, 0, 0, 220),
        true,
      );
    }
    for (const s of doc.state.slices) {
      const k = sliceKeyAt(s, f);
      if (k?.pivot) {
        const px = x + (k.bounds.x + k.pivot.x) * scale + Math.floor(scale / 2);
        const py = y + (k.bounds.y + k.pivot.y) * scale + Math.floor(scale / 2);
        out.fillRect({ x: px - 3, y: py, w: 7, h: 1 }, pack(0, 255, 0));
        out.fillRect({ x: px, y: py - 3, w: 1, h: 7 }, pack(0, 255, 0));
      }
    }
    // 2-px separator that stays visible on any backdrop
    out.strokeRect({ x: x - 2, y: y - 2, w: cw + 4, h: ch + 4 }, PREVIEW_TEXT, 1);
    out.strokeRect({ x: x - 1, y: y - 1, w: cw + 2, h: ch + 2 }, pack(0, 0, 0));
    const d = doc.state.frames[f]!.duration;
    const m = rasterMetrics(r);
    const changed = prev ? rasterDiffCount(prev, r) : null;
    out.text(FONT_3X5, `#${f} ${d}MS`, x, y + ch + 4, PREVIEW_TEXT, 2);
    out.text(FONT_3X5, `BOT ${m.bottom ?? '-'}  D${changed ?? '-'}`, x, y + ch + 16, PREVIEW_DIM, 1);
    metrics.push({ frame: f, ms: d, bbox: m.bbox, bottom: m.bottom, centroid: m.centroid, changed });
    prev = r;
  });
  const total = order.reduce((s, f) => s + doc.state.frames[f]!.duration, 0);
  const foot = `${order.length} FRAMES  TOTAL ${total}MS${req.tag ? `  TAG ${req.tag}` : ''}${req.baseline !== undefined ? `  RED LINE = ROW ${req.baseline}` : ''}  BOT = LOWEST ROW  D = PX CHANGED`;
  out.text(FONT_3X5, foot, gap, out.height - 10, PREVIEW_DIM, 1);
  return {
    raster: out,
    info: { view: 'filmstrip', order, scale, columns: cols, totalMs: total, frames: metrics },
  };
}

function trail(doc: SpriteDocument, req: RenderRequest, bg: Packed | null): RenderOutput {
  const order = playbackFrames(doc, req);
  const W = doc.state.width;
  const H = doc.state.height;
  const acc = new Raster(W, H);
  const pts: Array<{ f: number; x: number; y: number }> = [];
  const k = 1 / Math.max(1, order.length);
  for (const f of order) {
    const r = frameRaster(doc, f, req);
    acc.draw(r, 0, 0, 1, Math.max(0.15, k * 1.5));
    const m = rasterMetrics(r);
    if (m.centroid) pts.push({ f, ...m.centroid });
  }
  const scale = req.scale ?? autoScale(W, H, req.maxSize);
  const raster = buildPreview(acc, {
    scale,
    background: bg,
    inset: false,
    grid: false,
    overlay: (out, ox, oy, s) => {
      const P = (p: { x: number; y: number }) => ({
        x: Math.round(ox + (p.x + 0.5) * s),
        y: Math.round(oy + (p.y + 0.5) * s),
      });
      for (let i = 1; i < pts.length; i++) {
        const a = P(pts[i - 1]!);
        const b = P(pts[i]!);
        out.line(a.x, a.y, b.x, b.y, pack(255, 60, 60));
      }
      pts.forEach((p) => {
        const q = P(p);
        out.fillRect({ x: q.x - 2, y: q.y - 2, w: 5, h: 5 }, pack(255, 220, 0));
        out.text(FONT_3X5, String(p.f), q.x + 4, q.y - 3, pack(255, 255, 255), 1);
      });
      if (req.baseline !== undefined)
        out.fillRect(
          { x: ox, y: oy + (req.baseline + 1) * s - 1, w: W * s, h: 1 },
          pack(255, 0, 0, 200),
          true,
        );
    },
  });
  return {
    raster,
    info: { view: 'trail', order, scale, centroids: pts.map((p) => ({ frame: p.f, x: p.x, y: p.y })) },
  };
}

function timing(doc: SpriteDocument, req: RenderRequest): RenderOutput {
  const order = playbackFrames(doc, req);
  const durations = order.map((f) => doc.state.frames[f]!.duration);
  const total = durations.reduce((a, b) => a + b, 0);
  const width = Math.max(320, Math.min(1200, order.length * 48));
  const out = Raster.filled(width + 16, 64, PREVIEW_BG);
  let x = 8;
  order.forEach((f, i) => {
    const w = Math.max(2, Math.round((durations[i]! / total) * width));
    const c = i % 2 ? pack(80, 140, 230) : pack(60, 110, 200);
    out.fillRect({ x, y: 18, w: w - 1, h: 24 }, c);
    const label = `#${f}`;
    if (measureText(FONT_3X5, label).width + 2 < w) out.text(FONT_3X5, label, x + 2, 22, PREVIEW_TEXT, 1);
    const ms = `${durations[i]}`;
    if (measureText(FONT_3X5, ms).width + 2 < w) out.text(FONT_3X5, ms, x + 2, 32, PREVIEW_TEXT, 1);
    x += w;
  });
  const fps = total ? (order.length * 1000) / total : 0;
  out.text(
    FONT_3X5,
    `TOTAL ${total}MS  ${order.length} FRAMES  AVG ${fps.toFixed(1)} FPS`,
    8,
    6,
    PREVIEW_TEXT,
    1,
  );
  out.text(FONT_3X5, 'BAR WIDTH = DURATION', 8, 50, PREVIEW_DIM, 1);
  return {
    raster: out,
    info: { view: 'timing', order, durations, totalMs: total, avgFps: Math.round(fps * 10) / 10 },
  };
}

function paletteView(doc: SpriteDocument): RenderOutput {
  const vals = paletteValues(doc.state.palette);
  const cell = 34;
  const cols = 16;
  const rows = Math.ceil(vals.length / cols);
  const ramps = doc.state.palette.ramps;
  const rampH = ramps.length ? ramps.length * 22 + 16 : 0;
  const out = Raster.filled(cols * cell + 16, rows * (cell + 12) + 16 + rampH, PREVIEW_BG);
  vals.forEach((c, i) => {
    const x = 8 + (i % cols) * cell;
    const y = 8 + Math.floor(i / cols) * (cell + 12);
    if (i === 0) out.checkerboard(5, CHECKER_A, CHECKER_B, { x, y, w: cell - 4, h: cell - 4 });
    else out.fillRect({ x, y, w: cell - 4, h: cell - 4 }, c);
    const ink = i === 0 || relativeLuminance(c) > 0.35 ? pack(0, 0, 0) : pack(255, 255, 255);
    out.text(FONT_3X5, String(i), x + 2, y + 2, ink, 1);
    out.text(FONT_3X5, i === 0 ? 'TRANSP' : toHex(c).slice(1).toUpperCase(), x, y + cell - 2, PREVIEW_DIM, 1);
  });
  let y = 8 + rows * (cell + 12) + 4;
  for (const r of ramps) {
    out.text(FONT_3X5, r.name.toUpperCase().slice(0, 10), 8, y + 6, PREVIEW_TEXT, 1);
    r.indices.forEach((idx, k) => {
      out.fillRect({ x: 60 + k * 22, y, w: 20, h: 18 }, vals[idx] ?? 0);
      const ink = relativeLuminance(vals[idx] ?? 0) > 0.35 ? pack(0, 0, 0) : pack(255, 255, 255);
      out.text(FONT_3X5, String(idx), 62 + k * 22, y + 2, ink, 1);
    });
    y += 22;
  }
  return {
    raster: out,
    info: {
      view: 'palette',
      name: doc.state.palette.name,
      colors: vals.length - 1,
      ramps: ramps.map((r) => `${r.name}: ${r.indices.join(',')}`),
    },
  };
}
