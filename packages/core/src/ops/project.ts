/**
 * Project-level commands: rename, settings, notes, colour-mode conversion.
 */
import { invalidArg } from '../errors.js';
import type { SpriteDocument } from '../model/document.js';
import { paletteValues } from '../model/palette-state.js';
import { LIGHT_DIRECTIONS, type ColorMode, type SpriteSettings } from '../model/types.js';
import { mapToPalette, type DitherMethod } from '../palette/quantize.js';
import type { Rect } from '../util/geometry.js';

export interface ProjectPatch {
  name?: string;
  notes?: string;
  settings?: Partial<SpriteSettings>;
  pixelRatio?: { x: number; y: number };
  grid?: Rect;
}

export function updateProject(doc: SpriteDocument, patch: ProjectPatch): void {
  if (patch.settings?.lightDirection && !LIGHT_DIRECTIONS.includes(patch.settings.lightDirection)) {
    throw invalidArg(
      `Unknown light direction '${patch.settings.lightDirection}'`,
      `Use ${LIGHT_DIRECTIONS.join(', ')}`,
    );
  }
  const oc = patch.settings?.outlineColor;
  if (oc !== undefined && oc !== null && (oc < 1 || oc >= doc.state.palette.colors.length)) {
    throw invalidArg(
      `outlineColor must be a palette index 1..${doc.state.palette.colors.length - 1} or null`,
    );
  }
  if (patch.grid && (patch.grid.w < 1 || patch.grid.h < 1)) throw invalidArg('grid w/h must be ≥ 1');
  doc.transact('Update project', (tx) => {
    const st = tx.state;
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw invalidArg('Name cannot be empty');
      st.name = patch.name.trim();
    }
    if (patch.notes !== undefined) st.notes = patch.notes;
    if (patch.settings) st.settings = { ...st.settings, ...patch.settings };
    if (patch.pixelRatio)
      st.pixelRatio = {
        x: Math.max(1, Math.round(patch.pixelRatio.x)),
        y: Math.max(1, Math.round(patch.pixelRatio.y)),
      };
    if (patch.grid) st.grid = { ...patch.grid };
  });
}

/**
 * Convert between indexed and RGBA storage.
 * indexed → rgba is lossless; rgba → indexed maps each pixel to the nearest palette colour (optionally dithered).
 */
export function convertColorMode(
  doc: SpriteDocument,
  mode: ColorMode,
  dither: DitherMethod = 'none',
): number {
  if (doc.state.colorMode === mode) return 0;
  return doc.transact(`Convert to ${mode}`, (tx) => {
    const pal = paletteValues(tx.state.palette);
    let changed = 0;
    for (const id of doc.referencedImageIds()) {
      const img = tx.writeImage(id);
      if (mode === 'rgba') {
        changed += img.mapValues((v) => (v === 0 ? 0 : (pal[v] ?? 0)));
      } else {
        const idx = mapToPalette(img.data, img.width, img.height, pal, dither);
        for (let i = 0; i < img.data.length; i++) {
          if (img.data[i] !== idx[i]) changed++;
          img.data[i] = idx[i]!;
        }
      }
    }
    tx.state.colorMode = mode;
    return changed;
  });
}
