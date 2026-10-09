/**
 * read_pixels: serialise a region of a layer cel or of the composite as an ASCII grid + legend
 * (round-trips with the `grid` draw op).
 */
import { toHex, type Packed } from '../color/rgba.js';
import { invalidArg } from '../errors.js';
import type { SpriteDocument } from '../model/document.js';
import { assertFrame, getCel, resolveImageLayer } from '../model/lookup.js';
import { paletteValues } from '../model/palette-state.js';
import { PaletteMatcher } from '../palette/match.js';
import { compositeFrame } from '../render/composite.js';
import { intersectRect, type Rect } from '../util/geometry.js';
import { DEFAULT_ALPHABET, EXTRA_SYMBOLS, formatGrid, TRANSPARENT_CHAR } from './grid.js';

export interface ReadPixelsRequest {
  /** Layer id/name; omit for the flattened composite. */
  layer?: string;
  frame?: number;
  region?: Rect;
  format?: 'ascii' | 'json';
  /** Collapse runs ≥ N into c*n (0/undefined = off). */
  rle?: number;
  rowNumbers?: boolean;
  header?: boolean;
}

export interface ReadPixelsResult {
  source: string;
  frame: number;
  region: Rect;
  /** char → description */
  legend: Record<string, string>;
  /** For legend round-trip: char → colour input (palette index or hex) */
  legendInput: Record<string, number | string>;
  text: string;
  /** JSON format: rows of palette indices (or hex for off-palette colours). */
  rows?: Array<Array<number | string>>;
  opaque: number;
  colors: number;
}

const MAX_CELLS = 128 * 128;

export function readPixels(doc: SpriteDocument, req: ReadPixelsRequest = {}): ReadPixelsResult {
  const frame = req.frame ?? 0;
  assertFrame(doc.state, frame);
  const canvas = { x: 0, y: 0, w: doc.state.width, h: doc.state.height };
  const region = req.region ? intersectRect(req.region, canvas) : canvas;
  if (!region) throw invalidArg('Region lies outside the canvas');
  if (region.w * region.h > MAX_CELLS) {
    throw invalidArg(
      `Region ${region.w}x${region.h} is too large for text readback (max ${MAX_CELLS} cells)`,
      'Read a smaller region (e.g. 64x64 tiles) or use render',
    );
  }
  const pal = paletteValues(doc.state.palette);
  const matcher = new PaletteMatcher(pal);
  const indexed = doc.state.colorMode === 'indexed';
  // Each cell resolves to { index } (palette) or { color } (off-palette RGBA)
  type Cell = { index: number } | { color: Packed };
  const cells: Cell[][] = [];
  let source: string;
  if (req.layer) {
    const layer = resolveImageLayer(doc, req.layer);
    source = `layer ${layer.name} (${layer.id})`;
    const cel = getCel(doc.state, layer.id, frame);
    const img = cel ? doc.image(cel.imageId) : null;
    for (let y = 0; y < region.h; y++) {
      const row: Cell[] = [];
      for (let x = 0; x < region.w; x++) {
        const v = img && cel ? img.get(region.x + x - cel.x, region.y + y - cel.y) : 0;
        if (v === 0) row.push({ index: 0 });
        else if (indexed) row.push({ index: v });
        else {
          const i = matcher.exact(v);
          row.push(i >= 0 ? { index: i } : { color: v });
        }
      }
      cells.push(row);
    }
  } else {
    source = 'composite';
    const r = compositeFrame(doc, { frame });
    for (let y = 0; y < region.h; y++) {
      const row: Cell[] = [];
      for (let x = 0; x < region.w; x++) {
        const c = r.get(region.x + x, region.y + y);
        if (c === 0) row.push({ index: 0 });
        else {
          const i = matcher.exact(c);
          row.push(i >= 0 ? { index: i } : { color: c });
        }
      }
      cells.push(row);
    }
  }

  // assign characters
  const charOf = new Map<string, string>();
  const legend: Record<string, string> = {};
  const legendInput: Record<string, number | string> = {};
  const extra = [...EXTRA_SYMBOLS];
  let opaque = 0;
  const key = (c: Cell) => ('index' in c ? `i${c.index}` : `c${c.color}`);
  const names = doc.state.palette.names;
  const assign = (c: Cell): string => {
    const k = key(c);
    const existing = charOf.get(k);
    if (existing) return existing;
    let ch: string;
    if ('index' in c && c.index === 0) ch = TRANSPARENT_CHAR;
    else if ('index' in c)
      ch = c.index < DEFAULT_ALPHABET.length ? DEFAULT_ALPHABET[c.index]! : `[${c.index}]`;
    else {
      const sym = extra.shift();
      if (sym === undefined)
        throw invalidArg(
          `Too many off-palette colours for ASCII readback (more than ${EXTRA_SYMBOLS.length})`,
          'Use format "json", read a smaller region, or quantize the layer to the palette',
        );
      ch = sym;
    }
    charOf.set(k, ch);
    if ('index' in c) {
      legend[ch] =
        c.index === 0
          ? 'transparent'
          : `= index ${c.index} ${toHex(pal[c.index] ?? 0)}${names[String(c.index)] ? ` "${names[String(c.index)]}"` : ''}`;
      // [n] tokens are self-describing and are not valid legend keys
      if (!ch.startsWith('[')) legendInput[ch] = c.index;
    } else {
      legend[ch] = `= ${toHex(c.color)} (not in palette)`;
      legendInput[ch] = toHex(c.color);
    }
    return ch;
  };
  const chars = cells.map((row) =>
    row.map((c) => {
      if (!('index' in c) || c.index !== 0) opaque++;
      return assign(c);
    }),
  );
  const result: ReadPixelsResult = {
    source,
    frame,
    region,
    legend,
    legendInput,
    text: formatGrid(chars, {
      originX: region.x,
      originY: region.y,
      rowNumbers: req.rowNumbers ?? true,
      header: req.header ?? true,
      rle: req.rle,
    }),
    opaque,
    colors: Object.keys(legend).filter((k) => k !== TRANSPARENT_CHAR).length,
  };
  if (req.format === 'json')
    result.rows = cells.map((row) => row.map((c) => ('index' in c ? c.index : toHex(c.color))));
  return result;
}
