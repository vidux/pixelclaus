/**
 * Palette commands. In indexed sprites pixels are palette indices, so:
 * - `setColors` recolours every pixel using those indices (palette swap),
 * - `remapPixels` rewrites indices,
 * - `setPalette` / `loadPreset` replace the palette with a strategy ('index' keeps indices, 'nearest' re-matches).
 */
import { adjustColor, type ColorAdjustment } from '../color/hsl.js';
import { packedToOklch } from '../color/oklab.js';
import { parseHex, toHex8, type Packed } from '../color/rgba.js';
import { invalidArg, PixelClausError } from '../errors.js';
import type { SpriteDocument, Transaction } from '../model/document.js';
import {
  makePalette,
  namesRecord,
  paletteValues,
  presetPalette,
  TRANSPARENT_HEX,
} from '../model/palette-state.js';
import { MAX_PALETTE, type PaletteState, type RampState } from '../model/types.js';
import { PaletteMatcher } from '../palette/match.js';
import { medianCut } from '../palette/quantize.js';
import { detectRamps, generateRamp, rampBetween, type RampOptions } from '../palette/ramps.js';

export type RemapStrategy = 'index' | 'nearest';

function hex8(c: string): string {
  const v = parseHex(c);
  if (v === null) throw invalidArg(`Invalid colour '${c}'`, 'Use #rgb, #rrggbb or #rrggbbaa');
  return toHex8(v);
}

/** Apply a value mapping to every image (indexed: indices; rgba: colours). */
function mapAllImages(tx: Transaction, fn: (v: number) => number): number {
  let changed = 0;
  const seen = new Set<string>();
  for (const id of tx.document.referencedImageIds()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const img = tx.document.image(id);
    let needs = false;
    for (let i = 0; i < img.data.length; i++) {
      const v = img.data[i]!;
      if (fn(v) !== v) {
        needs = true;
        break;
      }
    }
    if (!needs) continue;
    changed += tx.writeImage(id).mapValues(fn);
  }
  return changed;
}

function replacePalette(tx: Transaction, next: PaletteState, strategy: RemapStrategy): number {
  const doc = tx.document;
  const oldVals = paletteValues(doc.state.palette);
  const newVals = paletteValues(next);
  let changed = 0;
  if (doc.state.colorMode === 'indexed') {
    const matcher = new PaletteMatcher(newVals);
    const lut = oldVals.map((c, i) => {
      if (i === 0) return 0;
      if (strategy === 'index' && i < newVals.length) return i;
      return matcher.nearest(c);
    });
    if (strategy === 'index' && oldVals.length > newVals.length) {
      tx.warn(
        `New palette is shorter (${newVals.length - 1} colours); pixels using indices ≥ ${newVals.length} were re-matched to the nearest colour`,
      );
    }
    changed = mapAllImages(tx, (v) => lut[v] ?? 0);
  } else if (strategy === 'index') {
    // RGBA: swap old palette colours for the new colour at the same index
    const map = new Map<Packed, Packed>();
    oldVals.forEach((c, i) => {
      if (i > 0 && i < newVals.length && c !== newVals[i]) map.set(c, newVals[i]!);
    });
    if (map.size) changed = mapAllImages(tx, (v) => map.get(v) ?? v);
  }
  tx.state.palette = next;
  return changed;
}

export function setPalette(
  doc: SpriteDocument,
  colors: readonly string[],
  opts: { name?: string; strategy?: RemapStrategy; names?: ReadonlyArray<string | undefined> } = {},
): number {
  return doc.transact('Set palette', (tx) =>
    replacePalette(
      tx,
      makePalette(opts.name ?? 'custom', colors, undefined, namesRecord(opts.names)),
      opts.strategy ?? 'nearest',
    ),
  );
}

export function loadPreset(doc: SpriteDocument, name: string, strategy: RemapStrategy = 'nearest'): number {
  const p = presetPalette(name);
  return doc.transact(`Load palette ${p.name}`, (tx) => replacePalette(tx, p, strategy));
}

export interface ColorEntry {
  index: number;
  color: string;
  name?: string;
}

/** Change palette entries. Indexed: all pixels using them change. RGBA: pixels of the old colour are recoloured too. */
export function setColors(doc: SpriteDocument, entries: readonly ColorEntry[]): number {
  const n = doc.state.palette.colors.length;
  for (const e of entries) {
    if (!Number.isInteger(e.index) || e.index < 1 || e.index >= n)
      throw invalidArg(
        `Index ${e.index} out of range 1..${n - 1}`,
        'Index 0 is the reserved transparent entry; use action "add" for new colours',
      );
  }
  return doc.transact(`Set ${entries.length} palette colour(s)`, (tx) => {
    const old = paletteValues(tx.state.palette);
    for (const e of entries) {
      tx.state.palette.colors[e.index] = hex8(e.color);
      if (e.name !== undefined) {
        if (e.name) tx.state.palette.names[String(e.index)] = e.name;
        else delete tx.state.palette.names[String(e.index)];
      }
    }
    if (tx.state.colorMode === 'rgba') {
      const map = new Map<Packed, Packed>();
      for (const e of entries) map.set(old[e.index]!, parseHex(e.color)!);
      return mapAllImages(tx, (v) => map.get(v) ?? v);
    }
    return 0;
  });
}

export function addColors(
  doc: SpriteDocument,
  colors: readonly string[],
  names?: readonly (string | undefined)[],
): number[] {
  const n = doc.state.palette.colors.length;
  if (n + colors.length > MAX_PALETTE) {
    throw new PixelClausError(
      'LIMIT',
      `Palette would exceed ${MAX_PALETTE} entries (has ${n})`,
      'Remove unused colours first (analyze kind "colors" lists them)',
    );
  }
  return doc.transact(`Add ${colors.length} palette colour(s)`, (tx) => {
    const out: number[] = [];
    colors.forEach((c, i) => {
      tx.state.palette.colors.push(hex8(c));
      const idx = tx.state.palette.colors.length - 1;
      const nm = names?.[i];
      if (nm) tx.state.palette.names[String(idx)] = nm;
      out.push(idx);
    });
    return out;
  });
}

/** Rewrite every pixel index according to `mapping` (old → new). Indexed sprites only. */
export function remapPixels(doc: SpriteDocument, mapping: Readonly<Record<number, number>>): number {
  if (doc.state.colorMode !== 'indexed')
    throw invalidArg('remap applies to indexed sprites', 'Use draw op replace_color in RGBA sprites');
  const n = doc.state.palette.colors.length;
  for (const [a, b] of Object.entries(mapping)) {
    const ai = Number(a);
    if (ai < 0 || ai >= n || b < 0 || b >= n)
      throw invalidArg(`Mapping ${a}→${b} out of palette range 0..${n - 1}`);
  }
  return doc.transact('Remap palette indices', (tx) =>
    mapAllImages(tx, (v) => (v in mapping ? mapping[v]! : v)),
  );
}

/** Remove palette entries; pixels using them are mapped to `replacement` or the nearest remaining colour. */
export function removeColors(doc: SpriteDocument, indices: readonly number[], replacement?: number): number {
  const n = doc.state.palette.colors.length;
  const del = new Set(indices);
  for (const i of del)
    if (!Number.isInteger(i) || i < 1 || i >= n) throw invalidArg(`Index ${i} out of range 1..${n - 1}`);
  if (replacement !== undefined && (del.has(replacement) || replacement < 0 || replacement >= n))
    throw invalidArg('replacement must be a remaining palette index');
  return doc.transact(`Remove ${del.size} palette colour(s)`, (tx) => {
    const pal = tx.state.palette;
    const old = paletteValues(pal);
    const keep = old.map((_, i) => i).filter((i) => !del.has(i));
    const newIndex = new Map<number, number>();
    keep.forEach((oi, ni) => newIndex.set(oi, ni));
    const keptVals = keep.map((i) => old[i]!);
    const matcher = new PaletteMatcher(keptVals);
    const lut = old.map((c, i) => {
      if (newIndex.has(i)) return newIndex.get(i)!;
      if (replacement !== undefined) return newIndex.get(replacement)!;
      return matcher.nearest(c);
    });
    let changed = 0;
    if (tx.state.colorMode === 'indexed') changed = mapAllImages(tx, (v) => lut[v] ?? 0);
    const names: Record<string, string> = {};
    for (const [k, v] of Object.entries(pal.names))
      if (newIndex.has(Number(k))) names[String(newIndex.get(Number(k)))] = v;
    pal.colors = keep.map((i) => pal.colors[i]!);
    pal.names = names;
    pal.ramps = remapRamps(pal.ramps, newIndex);
    if (tx.state.settings.outlineColor !== null)
      tx.state.settings.outlineColor = newIndex.get(tx.state.settings.outlineColor) ?? null;
    return changed;
  });
}

function remapRamps(ramps: readonly RampState[], map: Map<number, number>): RampState[] {
  return ramps
    .map((r) => ({ name: r.name, indices: r.indices.filter((i) => map.has(i)).map((i) => map.get(i)!) }))
    .filter((r) => r.indices.length >= 2);
}

export type SortKey = 'lightness' | 'hue' | 'chroma' | 'ramps';

/** Sort palette entries (index 0 stays transparent); pixels are remapped so the image is unchanged. */
export function sortPalette(doc: SpriteDocument, by: SortKey = 'lightness'): void {
  doc.transact(`Sort palette by ${by}`, (tx) => {
    const pal = tx.state.palette;
    const vals = paletteValues(pal);
    const idx = vals.map((_, i) => i).slice(1);
    let order: number[];
    if (by === 'ramps') {
      const ramps = pal.ramps.length ? pal.ramps : detectRamps(vals);
      const seen = new Set<number>();
      order = [];
      for (const r of ramps) {
        for (const i of r.indices) {
          if (seen.has(i)) continue;
          seen.add(i);
          order.push(i);
        }
      }
      for (const i of idx) if (!seen.has(i)) order.push(i);
    } else {
      const key = (i: number) => {
        const l = packedToOklch(vals[i]!);
        return by === 'lightness' ? l.L : by === 'hue' ? (l.C < 0.03 ? -1 : l.h) + l.L / 10 : l.C;
      };
      order = [...idx].sort((a, b) => key(a) - key(b));
    }
    const full = [0, ...order];
    const newIndex = new Map<number, number>();
    full.forEach((oi, ni) => newIndex.set(oi, ni));
    if (tx.state.colorMode === 'indexed') mapAllImages(tx, (v) => newIndex.get(v) ?? v);
    const names: Record<string, string> = {};
    for (const [k, v] of Object.entries(pal.names)) names[String(newIndex.get(Number(k)))] = v;
    pal.colors = full.map((i) => pal.colors[i]!);
    pal.names = names;
    pal.ramps = remapRamps(pal.ramps, newIndex);
    if (tx.state.settings.outlineColor !== null)
      tx.state.settings.outlineColor = newIndex.get(tx.state.settings.outlineColor) ?? null;
  });
}

export function setRamps(doc: SpriteDocument, ramps: readonly RampState[]): void {
  const n = doc.state.palette.colors.length;
  for (const r of ramps) {
    if (!r.name) throw invalidArg('Every ramp needs a name');
    for (const i of r.indices)
      if (i < 1 || i >= n) throw invalidArg(`Ramp '${r.name}' uses index ${i} outside 1..${n - 1}`);
  }
  doc.transact('Set ramps', (tx) => {
    tx.state.palette.ramps = ramps.map((r) => ({ name: r.name, indices: [...r.indices] }));
  });
}

export function autoRamps(doc: SpriteDocument): RampState[] {
  return doc.transact('Auto-detect ramps', (tx) => {
    tx.state.palette.ramps = detectRamps(paletteValues(tx.state.palette));
    return tx.state.palette.ramps;
  });
}

/** Generate a hue-shifted ramp around `base` and (optionally) append it to the palette as a named ramp. */
export function addGeneratedRamp(
  doc: SpriteDocument,
  base: string,
  opts: RampOptions & { name?: string; add?: boolean; to?: string } = {},
): { colors: string[]; indices: number[] } {
  const b = parseHex(base);
  if (b === null) throw invalidArg(`Invalid base colour '${base}'`);
  let colors: Packed[];
  if (opts.to) {
    const t = parseHex(opts.to);
    if (t === null) throw invalidArg(`Invalid colour '${opts.to}'`);
    colors = rampBetween(b, t, opts.steps ?? 5);
  } else colors = generateRamp(b, opts);
  const hexes = colors.map((c) => toHex8(c).slice(0, 7));
  if (opts.add === false) return { colors: hexes, indices: [] };
  const n = doc.state.palette.colors.length;
  if (n + colors.length > MAX_PALETTE)
    throw new PixelClausError(
      'LIMIT',
      `Not enough palette room for ${colors.length} colours (has ${n}/${MAX_PALETTE})`,
    );
  return doc.transact(`Add ramp ${opts.name ?? ''}`.trim(), (tx) => {
    const pal = tx.state.palette;
    const indices: number[] = [];
    for (const c of colors) {
      pal.colors.push(toHex8(c));
      indices.push(pal.colors.length - 1);
    }
    const name = opts.name ?? `ramp-${pal.ramps.length + 1}`;
    pal.ramps = pal.ramps.filter((r) => r.name !== name);
    pal.ramps.push({ name, indices });
    return { colors: hexes, indices };
  });
}

/** Adjust palette colours (HSL/brightness/contrast). Indexed: recolours pixels; RGBA: pixels follow too. */
export function adjustPalette(
  doc: SpriteDocument,
  adj: ColorAdjustment,
  indices?: readonly number[],
): number {
  const n = doc.state.palette.colors.length;
  const targets = indices ?? Array.from({ length: n - 1 }, (_, i) => i + 1);
  return setColors(
    doc,
    targets.map((i) => {
      if (i < 1 || i >= n) throw invalidArg(`Index ${i} out of range`);
      const v = parseHex(doc.state.palette.colors[i]!)!;
      return { index: i, color: toHex8(adjustColor(v, adj)) };
    }),
  );
}

/** Build a palette from the colours used in an RGBA sprite (median cut when above `max`). */
export function extractPalette(
  doc: SpriteDocument,
  max = 32,
  opts: { strategy?: RemapStrategy } = {},
): number {
  const hist = new Map<Packed, number>();
  const resolverRgba = (v: number) =>
    doc.state.colorMode === 'indexed' ? (paletteValues(doc.state.palette)[v] ?? 0) : v;
  for (const id of doc.referencedImageIds()) {
    const img = doc.image(id);
    for (let i = 0; i < img.data.length; i++) {
      const c = resolverRgba(img.data[i]!);
      if (c === 0) continue;
      const k = (c | 255) >>> 0;
      hist.set(k, (hist.get(k) ?? 0) + 1);
    }
  }
  const colors = medianCut(hist, Math.min(max, MAX_PALETTE - 1));
  return doc.transact('Extract palette', (tx) =>
    replacePalette(tx, makePalette('extracted', colors), opts.strategy ?? 'nearest'),
  );
}

export function paletteSummary(p: PaletteState): Array<{ index: number; hex: string; name?: string }> {
  return p.colors.map((hex, index) => ({
    index,
    hex: index === 0 ? TRANSPARENT_HEX : hex.endsWith('ff') ? hex.slice(0, 7) : hex,
    ...(p.names[String(index)] ? { name: p.names[String(index)] } : {}),
  }));
}
