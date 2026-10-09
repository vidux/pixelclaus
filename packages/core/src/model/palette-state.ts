import { parseHex, toHex8, type Packed } from '../color/rgba.js';
import { invalidArg, notFound } from '../errors.js';
import { PaletteMatcher } from '../palette/match.js';
import { findPreset, presetNames } from '../palette/presets.js';
import { detectRamps } from '../palette/ramps.js';
import type { PaletteState, RampState } from './types.js';
import { MAX_PALETTE } from './types.js';

export const TRANSPARENT_HEX = '#00000000';

/** Packed colours of a palette (index 0 = transparent). */
export function paletteValues(p: PaletteState): Packed[] {
  return p.colors.map((h, i) => (i === 0 ? 0 : (parseHex(h) ?? 0)));
}

export function paletteMatcher(p: PaletteState): PaletteMatcher {
  return new PaletteMatcher(paletteValues(p));
}

function toHexList(colors: ReadonlyArray<string | Packed>): string[] {
  return colors.map((c) => {
    if (typeof c === 'number') return toHex8(c);
    const v = parseHex(c);
    if (v === null) throw invalidArg(`Invalid colour '${c}'`, 'Use #rgb, #rrggbb or #rrggbbaa hex');
    return toHex8(v);
  });
}

/** Build a palette state from colours (without the transparent entry, which is prepended). */
/** ['Red', undefined, 'Leaf'] → { '1': 'Red', '3': 'Leaf' } (palette index = list index + 1). */
export function namesRecord(names: ReadonlyArray<string | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  names?.forEach((n, i) => {
    if (n?.trim()) out[String(i + 1)] = n.trim();
  });
  return out;
}

export function makePalette(
  name: string,
  colors: ReadonlyArray<string | Packed>,
  ramps?: RampState[],
  names: Record<string, string> = {},
): PaletteState {
  if (colors.length > MAX_PALETTE - 1) {
    throw invalidArg(
      `Palette has ${colors.length} colours; max is ${MAX_PALETTE - 1} (index 0 is reserved for transparent)`,
    );
  }
  const hex = [TRANSPARENT_HEX, ...toHexList(colors)];
  const state: PaletteState = { name, colors: hex, names, ramps: ramps ?? [] };
  if (!ramps) state.ramps = detectRamps(paletteValues(state));
  return state;
}

export function presetPalette(name: string): PaletteState {
  const preset = findPreset(name);
  if (!preset) throw notFound('palette preset', name, presetNames());
  const ramps = preset.ramps
    ? preset.ramps.map((r) => ({ name: r.name, indices: r.colors.map((i) => i + 1) }))
    : undefined;
  return makePalette(preset.name, preset.colors, ramps);
}

export const DEFAULT_PALETTE = 'endesga-32';
