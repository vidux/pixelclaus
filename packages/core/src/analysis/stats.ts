/**
 * Structural and colour statistics for a sprite.
 */
import { deltaEPacked, packedToOklch } from '../color/oklab.js';
import { toHex } from '../color/rgba.js';
import type { SpriteDocument } from '../model/document.js';
import { layerPath } from '../model/lookup.js';
import { paletteValues } from '../model/palette-state.js';
import { PaletteMatcher } from '../palette/match.js';
import { compositeFrame } from '../render/composite.js';
import type { Rect } from '../util/geometry.js';

export interface LayerStats {
  id: string;
  name: string;
  path: string;
  cels: number;
  linkedCels: number;
  pixels: number;
  bounds: Rect | null;
}

export interface SpriteStats {
  size: string;
  colorMode: string;
  frames: number;
  layers: LayerStats[];
  /** Union content bounds over all frames. */
  bounds: Rect | null;
  colorsUsed: number;
  /** palette index (or hex) → pixel count over the composite of all frames */
  usage: Array<{ color: string; index: number; count: number }>;
}

export function spriteStats(doc: SpriteDocument): SpriteStats {
  const st = doc.state;
  const imageRefs = new Map<string, number>();
  for (const c of st.cels) imageRefs.set(c.imageId, (imageRefs.get(c.imageId) ?? 0) + 1);
  const layers: LayerStats[] = st.layers.map((l) => {
    const cels = st.cels.filter((c) => c.layerId === l.id);
    let pixels = 0;
    let bounds: Rect | null = null;
    for (const c of cels) {
      const img = doc.image(c.imageId);
      const b = img.bounds();
      for (let i = 0; i < img.data.length; i++) if (img.data[i] !== 0) pixels++;
      if (b) {
        const r = { x: b.x + c.x, y: b.y + c.y, w: b.w, h: b.h };
        bounds = bounds ? union(bounds, r) : r;
      }
    }
    return {
      id: l.id,
      name: l.name,
      path: layerPath(st, l),
      cels: cels.length,
      linkedCels: cels.filter((c) => (imageRefs.get(c.imageId) ?? 0) > 1).length,
      pixels,
      bounds,
    };
  });
  const matcher = new PaletteMatcher(paletteValues(st.palette));
  const counts = new Map<number, number>();
  let bounds: Rect | null = null;
  for (let f = 0; f < st.frames.length; f++) {
    const r = compositeFrame(doc, { frame: f, includeReference: false });
    const b = r.bounds();
    if (b) bounds = bounds ? union(bounds, b) : b;
    for (let i = 0; i < r.data.length; i += 4) {
      if (r.data[i + 3] === 0) continue;
      const c = ((r.data[i]! << 24) | (r.data[i + 1]! << 16) | (r.data[i + 2]! << 8) | r.data[i + 3]!) >>> 0;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  const usage = [...counts.entries()]
    .map(([c, count]) => ({ color: toHex(c), index: matcher.exact(c), count }))
    .sort((a, b) => b.count - a.count);
  return {
    size: `${st.width}x${st.height}`,
    colorMode: st.colorMode,
    frames: st.frames.length,
    layers,
    bounds,
    colorsUsed: usage.length,
    usage,
  };
}

function union(a: Rect, b: Rect): Rect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
}

export interface PaletteReport {
  name: string;
  size: number;
  entries: Array<{
    index: number;
    hex: string;
    name?: string;
    L: number;
    C: number;
    h: number;
    used: number;
  }>;
  unused: number[];
  nearDuplicates: Array<[number, number, number]>;
  ramps: Array<{ name: string; indices: number[]; lightness: number[] }>;
}

export function paletteReport(doc: SpriteDocument): PaletteReport {
  const st = doc.state;
  const pal = paletteValues(st.palette);
  const used = new Map<number, number>();
  const stats = spriteStats(doc);
  for (const u of stats.usage) if (u.index > 0) used.set(u.index, u.count);
  const entries = pal.map((c, index) => {
    const l = packedToOklch(c);
    return {
      index,
      hex: index === 0 ? 'transparent' : toHex(c),
      ...(st.palette.names[String(index)] ? { name: st.palette.names[String(index)] } : {}),
      L: round(l.L),
      C: round(l.C),
      h: Math.round(l.h),
      used: used.get(index) ?? 0,
    };
  });
  const nearDuplicates: Array<[number, number, number]> = [];
  for (let i = 1; i < pal.length; i++)
    for (let j = i + 1; j < pal.length; j++) {
      const d = deltaEPacked(pal[i]!, pal[j]!);
      if (d < 0.03) nearDuplicates.push([i, j, round(d)]);
    }
  return {
    name: st.palette.name,
    size: pal.length - 1,
    entries: entries.slice(1),
    unused: entries.filter((e) => e.index > 0 && e.used === 0).map((e) => e.index),
    nearDuplicates,
    ramps: st.palette.ramps.map((r) => ({
      name: r.name,
      indices: r.indices,
      lightness: r.indices.map((i) => round(packedToOklch(pal[i] ?? 0).L)),
    })),
  };
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
