/**
 * Sprite-sheet builder: renders frames (optionally per layer), trims/dedupes/extrudes them, packs them
 * with one of several layouts and emits an engine-friendly JSON atlas (Aseprite hash/array,
 * TexturePacker hash).
 */
import {
  compositeFrame,
  getCel,
  invalidArg,
  Raster,
  resolveFrames,
  resolveLayer,
  resolveTag,
  sliceKeyAt,
  type FrameSpec,
  type Rect,
  type SpriteDocument,
} from '@pixelclaus/core';

/** Largest sheet side most engines/GPUs accept. */
export const MAX_SHEET_SIDE = 16384;

export type SheetLayout = 'horizontal' | 'vertical' | 'grid' | 'rows' | 'packed';
export type SheetJsonFormat = 'aseprite-hash' | 'aseprite-array' | 'texturepacker' | 'none';

export interface SpriteSheetOptions {
  layout?: SheetLayout;
  /** Columns for the grid layout (default ceil(sqrt(n))). */
  columns?: number;
  frames?: FrameSpec;
  /** Only frames of this tag. */
  tag?: string;
  /** Isolate layers (ids or names). */
  layers?: readonly string[];
  /** Emit every visible image layer as its own set of cells. */
  splitLayers?: boolean;
  /** Integer upscale 1-16 (nearest). */
  scale?: number;
  /** Pixels between cells. */
  padding?: number;
  /** Pixels around the whole sheet. */
  border?: number;
  /** Repeat edge pixels outward by N px (prevents texture bleeding with filtering). */
  extrude?: number;
  trim?: boolean;
  mergeDuplicates?: boolean;
  powerOfTwo?: boolean;
  includeHidden?: boolean;
  json?: SheetJsonFormat;
  /** Frame name template: {title} {tag} {tagframe} {frame} {layer}; {frame:000} pads. */
  filename?: string;
  /** Image file name referenced by the JSON meta. */
  imageName?: string;
}

export interface SheetCell {
  name: string;
  frame: number;
  layer?: string;
  tag?: string;
  tagFrame?: number;
  duration: number;
  /** Placement in the sheet (excluding extrusion). */
  rect: Rect;
  /** Trimmed area within the (scaled) source frame. */
  sourceRect: Rect;
  sourceSize: { w: number; h: number };
  trimmed: boolean;
  /** Index of the cell this one duplicates (when merged). */
  duplicateOf?: number;
  row?: number;
}

export interface SpriteSheetResult {
  raster: Raster;
  cells: SheetCell[];
  json: Record<string, unknown> | null;
  warnings: string[];
}

function fnv(data: Uint8ClampedArray): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16) + ':' + data.length;
}

export function formatName(template: string, vars: Record<string, string | number | undefined>): string {
  return template
    .replace(/\{(\w+)(?::(0+))?\}/g, (_m, key: string, pad?: string) => {
      const v = vars[key];
      if (v === undefined || v === '') return '';
      const s = String(v);
      return pad && typeof v === 'number' ? s.padStart(pad.length, '0') : s;
    })
    .replace(/[-_ ]{2,}/g, (m) => m[0]!)
    .replace(/^[-_ ]+|[-_ ]+$/g, '');
}

const nextPow2 = (n: number) => 1 << Math.ceil(Math.log2(Math.max(1, n)));

interface Item {
  cell: Omit<SheetCell, 'rect'> & { rect?: Rect };
  img: Raster;
  hash: string;
}

export function buildSpriteSheet(doc: SpriteDocument, opts: SpriteSheetOptions = {}): SpriteSheetResult {
  const st = doc.state;
  const warnings: string[] = [];
  const scale = Math.round(opts.scale ?? 1);
  if (scale < 1 || scale > 16) throw invalidArg('scale must be an integer 1..16');
  const layout = opts.layout ?? (st.tags.length > 1 ? 'rows' : 'horizontal');
  const pad = Math.max(0, opts.padding ?? 0);
  const border = Math.max(0, opts.border ?? 0);
  const extrude = Math.max(0, opts.extrude ?? 0);
  const trim = opts.trim ?? false;
  const merge = opts.mergeDuplicates ?? true;
  const title = st.name;
  const template = opts.filename ?? (st.tags.length ? '{title}-{tag}-{tagframe:00}' : '{title}-{frame:00}');

  // which frames (grouped in rows for the 'rows' layout)
  const rows: Array<{ tag?: string; frames: number[] }> = [];
  if (opts.tag) {
    const t = resolveTag(st, opts.tag);
    rows.push({ tag: t.name, frames: range(t.from, t.to) });
  } else if (layout === 'rows' && st.tags.length && opts.frames === undefined) {
    for (const t of st.tags) rows.push({ tag: t.name, frames: range(t.from, t.to) });
  } else {
    rows.push({ frames: resolveFrames(st, opts.frames, 'all') });
  }

  const isolate = opts.layers?.map((l) => resolveLayer(doc, l).id);
  const layerSets: Array<{ name?: string; ids?: string[] }> = opts.splitLayers
    ? st.layers
        .filter(
          (l) =>
            l.type === 'image' && (l.visible || opts.includeHidden) && (!isolate || isolate.includes(l.id)),
        )
        .map((l) => ({ name: l.name, ids: [l.id] }))
    : [{ ids: isolate }];

  const items: Item[] = [];
  const tagOf = (f: number) => st.tags.find((t) => f >= t.from && f <= t.to);
  rows.forEach((row, ri) => {
    for (const ls of layerSets) {
      row.frames.forEach((f) => {
        if (opts.splitLayers && ls.ids && !getCel(st, ls.ids[0]!, f)) return;
        let img = compositeFrame(doc, {
          frame: f,
          isolate: ls.ids,
          includeHidden: opts.includeHidden,
          includeReference: false,
        });
        if (scale > 1) img = img.scaled(scale);
        const full = { x: 0, y: 0, w: img.width, h: img.height };
        let sourceRect = full;
        if (trim) {
          const b = img.bounds();
          sourceRect = b ?? { x: 0, y: 0, w: 1, h: 1 };
          img = img.crop(sourceRect);
        }
        const tag = row.tag ? st.tags.find((t) => t.name === row.tag) : tagOf(f);
        // frames outside any tag fall back to a frame-number name so they never collide/lose their index
        const name = formatName(tag || opts.filename ? template : '{title}-{frame:00}', {
          title,
          tag: tag?.name,
          tagframe: tag ? f - tag.from : undefined,
          frame: f,
          layer: ls.name,
        });
        items.push({
          cell: {
            name,
            frame: f,
            ...(ls.name ? { layer: ls.name } : {}),
            ...(tag ? { tag: tag.name, tagFrame: f - tag.from } : {}),
            duration: st.frames[f]!.duration,
            sourceRect,
            sourceSize: { w: full.w, h: full.h },
            trimmed:
              trim &&
              (sourceRect.w !== full.w ||
                sourceRect.h !== full.h ||
                sourceRect.x !== 0 ||
                sourceRect.y !== 0),
            row: ri,
          },
          img,
          hash: '',
        });
      });
    }
  });
  if (!items.length) throw invalidArg('No frames to put in the sheet');

  // names must be unique for hash JSON
  const seen = new Map<string, number>();
  for (const it of items) {
    const n = seen.get(it.cell.name) ?? 0;
    seen.set(it.cell.name, n + 1);
    if (n) it.cell.name = `${it.cell.name}-${n}`;
  }

  // dedupe
  const unique: Item[] = [];
  const byHash = new Map<string, number>();
  items.forEach((it) => {
    // identical pixels AND identical size/trim offset (a 2x3 and a 3x2 solid block have the same bytes)
    it.hash = merge
      ? `${fnv(it.img.data)}|${it.img.width}x${it.img.height}|${it.cell.sourceRect.x},${it.cell.sourceRect.y}`
      : `u${items.indexOf(it)}`;
    const prev = byHash.get(it.hash);
    if (merge && prev !== undefined) it.cell.duplicateOf = prev;
    else {
      byHash.set(it.hash, unique.length);
      unique.push(it);
    }
  });

  // layout of unique items (cells include extrusion)
  const cw = (it: Item) => it.img.width + 2 * extrude;
  const ch = (it: Item) => it.img.height + 2 * extrude;
  const pos: Array<{ x: number; y: number }> = [];
  let W = 0;
  let H: number;
  if (layout === 'horizontal' || layout === 'vertical') {
    let off = border;
    for (const it of unique) {
      pos.push(layout === 'horizontal' ? { x: off, y: border } : { x: border, y: off });
      off += (layout === 'horizontal' ? cw(it) : ch(it)) + pad;
    }
    W = layout === 'horizontal' ? off - pad + border : Math.max(...unique.map(cw)) + 2 * border;
    H = layout === 'horizontal' ? Math.max(...unique.map(ch)) + 2 * border : off - pad + border;
  } else if (layout === 'grid') {
    const cols = Math.max(1, opts.columns ?? Math.ceil(Math.sqrt(unique.length)));
    const gw = Math.max(...unique.map(cw));
    const gh = Math.max(...unique.map(ch));
    unique.forEach((_, i) =>
      pos.push({ x: border + (i % cols) * (gw + pad), y: border + Math.floor(i / cols) * (gh + pad) }),
    );
    const rowsN = Math.ceil(unique.length / cols);
    W = border * 2 + Math.min(cols, unique.length) * (gw + pad) - pad;
    H = border * 2 + rowsN * (gh + pad) - pad;
  } else if (layout === 'rows') {
    let y = border;
    const rowIds = [...new Set(unique.map((u) => u.cell.row ?? 0))];
    for (const r of rowIds) {
      let x = border;
      const inRow = unique.filter((u) => (u.cell.row ?? 0) === r);
      const rh = Math.max(...inRow.map(ch));
      for (const it of inRow) {
        pos[unique.indexOf(it)] = { x, y };
        x += cw(it) + pad;
      }
      W = Math.max(W, x - pad + border);
      y += rh + pad;
    }
    H = y - pad + border;
  } else {
    // shelf packing, tallest first
    const area = unique.reduce((s, it) => s + (cw(it) + pad) * (ch(it) + pad), 0);
    const maxW = Math.max(
      Math.max(...unique.map(cw)) + 2 * border,
      Math.ceil(Math.sqrt(area * 1.15)) + 2 * border,
    );
    const order = unique
      .map((it, i) => ({ it, i }))
      .sort((a, b) => ch(b.it) - ch(a.it) || cw(b.it) - cw(a.it));
    let x = border;
    let y = border;
    let shelf = 0;
    for (const { it, i } of order) {
      if (x + cw(it) + border > maxW && x > border) {
        x = border;
        y += shelf + pad;
        shelf = 0;
      }
      pos[i] = { x, y };
      x += cw(it) + pad;
      shelf = Math.max(shelf, ch(it));
      W = Math.max(W, x - pad + border);
    }
    H = y + shelf + border;
  }
  if (opts.powerOfTwo) {
    W = nextPow2(W);
    H = nextPow2(H);
  }
  if (W > MAX_SHEET_SIDE || H > MAX_SHEET_SIDE) {
    throw invalidArg(
      `Sprite sheet would be ${W}x${H} px (max ${MAX_SHEET_SIDE} per side)`,
      'Use layout "grid" or "packed", fewer frames (tag/frames), smaller padding/border, or split by tag',
    );
  }
  const raster = new Raster(W, H);
  unique.forEach((it, i) => {
    const p = pos[i]!;
    raster.draw(it.img, p.x + extrude, p.y + extrude);
    if (extrude)
      extrudeEdges(
        raster,
        { x: p.x + extrude, y: p.y + extrude, w: it.img.width, h: it.img.height },
        extrude,
      );
  });
  const cells: SheetCell[] = items.map((it) => {
    const ui = it.cell.duplicateOf ?? byHash.get(it.hash)!;
    const p = pos[ui]!;
    const u = unique[ui]!;
    return {
      ...it.cell,
      rect: { x: p.x + extrude, y: p.y + extrude, w: u.img.width, h: u.img.height },
    } as SheetCell;
  });
  if (W > 8192 || H > 8192) warnings.push(`Sheet is ${W}x${H}; many GPUs limit textures to 4096 or 8192 px`);
  const json =
    opts.json === 'none'
      ? null
      : sheetJson(doc, cells, {
          width: W,
          height: H,
          scale,
          format: opts.json ?? 'aseprite-hash',
          image: opts.imageName ?? `${st.id}.png`,
        });
  return { raster, cells, json, warnings };
}

function extrudeEdges(r: Raster, rect: Rect, n: number): void {
  for (let k = 1; k <= n; k++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      r.set(x, rect.y - k, r.get(x, rect.y));
      r.set(x, rect.y + rect.h - 1 + k, r.get(x, rect.y + rect.h - 1));
    }
    for (let y = rect.y - n; y < rect.y + rect.h + n; y++) {
      r.set(rect.x - k, y, r.get(rect.x, y));
      r.set(rect.x + rect.w - 1 + k, y, r.get(rect.x + rect.w - 1, y));
    }
  }
}

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

function rectJson(r: Rect) {
  return { x: r.x, y: r.y, w: r.w, h: r.h };
}

export function sheetJson(
  doc: SpriteDocument,
  cells: readonly SheetCell[],
  meta: {
    width: number;
    height: number;
    scale: number;
    format: Exclude<SheetJsonFormat, 'none'>;
    image: string;
  },
): Record<string, unknown> {
  const st = doc.state;
  const s = meta.scale;
  const frameEntry = (c: SheetCell) => ({
    frame: rectJson(c.rect),
    rotated: false,
    trimmed: c.trimmed,
    spriteSourceSize: rectJson(c.sourceRect),
    sourceSize: c.sourceSize,
    ...(meta.format === 'texturepacker' ? { pivot: { x: 0.5, y: 0.5 } } : { duration: c.duration }),
  });
  const frames =
    meta.format === 'aseprite-array'
      ? cells.map((c) => ({ filename: c.name, ...frameEntry(c) }))
      : Object.fromEntries(cells.map((c) => [c.name, frameEntry(c)]));
  const scaleRect = (r: Rect) => ({ x: r.x * s, y: r.y * s, w: r.w * s, h: r.h * s });
  const base = {
    app: meta.format === 'texturepacker' ? 'https://www.codeandweb.com/texturepacker' : 'PixelClaus',
    version: '1.3',
    image: meta.image,
    format: 'RGBA8888',
    size: { w: meta.width, h: meta.height },
    scale: String(s),
  };
  if (meta.format === 'texturepacker') return { frames, meta: base };
  return {
    frames,
    meta: {
      ...base,
      frameTags: st.tags.map((t) => ({
        name: t.name,
        from: t.from,
        to: t.to,
        direction: t.direction,
        color: `${t.color}ff`,
        ...(t.repeat ? { repeat: String(t.repeat) } : {}),
      })),
      layers: st.layers.map((l) => ({
        name: l.name,
        ...(l.type === 'group' ? {} : { opacity: l.opacity, blendMode: l.blendMode }),
        ...(l.parentId ? { group: st.layers.find((p) => p.id === l.parentId)?.name } : {}),
      })),
      slices: st.slices.map((sl) => ({
        name: sl.name,
        color: `${sl.color}ff`,
        keys: sl.keys.map((k) => ({
          frame: k.frame,
          bounds: scaleRect(k.bounds),
          ...(k.center ? { center: scaleRect(k.center) } : {}),
          ...(k.pivot ? { pivot: { x: k.pivot.x * s, y: k.pivot.y * s } } : {}),
        })),
      })),
      pixelclaus: {
        palette: st.palette.name,
        colorMode: st.colorMode,
        ramps: st.palette.ramps,
        pivots: Object.fromEntries(
          st.slices
            .filter((sl) => sl.keys.some((k) => k.pivot))
            .map((sl) => [sl.name, sliceKeyAt(sl, 0)?.pivot]),
        ),
      },
    },
  };
}

// ───────────── import: slice a sheet image into frames ─────────────

export interface SliceSheetOptions {
  frameWidth: number;
  frameHeight: number;
  /** Max frames (default: all). */
  count?: number;
  /** Offset of the first frame. */
  marginX?: number;
  marginY?: number;
  /** Gap between frames. */
  spacingX?: number;
  spacingY?: number;
  /** Skip completely transparent cells (default true). */
  skipEmpty?: boolean;
}

/** Cut a sheet raster into equally sized frames (row-major). */
export function sliceSheet(sheet: Raster, o: SliceSheetOptions): Raster[] {
  if (o.frameWidth < 1 || o.frameHeight < 1) throw invalidArg('frameWidth/frameHeight must be ≥ 1');
  const mx = o.marginX ?? 0;
  const my = o.marginY ?? 0;
  const sx = o.spacingX ?? 0;
  const sy = o.spacingY ?? 0;
  const cols = Math.floor((sheet.width - mx + sx) / (o.frameWidth + sx));
  const rows = Math.floor((sheet.height - my + sy) / (o.frameHeight + sy));
  const out: Raster[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const f = sheet.crop({
        x: mx + c * (o.frameWidth + sx),
        y: my + r * (o.frameHeight + sy),
        w: o.frameWidth,
        h: o.frameHeight,
      });
      if ((o.skipEmpty ?? true) && f.isEmpty()) continue;
      out.push(f);
      if (o.count && out.length >= o.count) return out;
    }
  }
  return out;
}
