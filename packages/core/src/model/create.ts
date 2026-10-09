import { PixelBuffer } from '../buffer/pixel-buffer.js';
import type { Mask } from '../buffer/mask.js';
import { parseHex } from '../color/rgba.js';
import { invalidArg, PixelClausError } from '../errors.js';
import { SpriteDocument } from './document.js';
import { DEFAULT_PALETTE, makePalette, namesRecord, paletteMatcher, presetPalette } from './palette-state.js';
import {
  MAX_CANVAS,
  MAX_DOC_PIXELS,
  MAX_FRAMES,
  type ColorMode,
  type LayerState,
  type PaletteState,
  type SpriteSettings,
  type SpriteState,
} from './types.js';

export interface CreateDocumentOptions {
  id?: string;
  name: string;
  width: number;
  height: number;
  colorMode?: ColorMode;
  /** Preset name or explicit colour list (hex, without the transparent entry). */
  palette?: string | string[];
  /** Name for an explicit colour list (default "custom"). */
  paletteName?: string;
  /** Colour names for an explicit colour list (same order as `palette`). */
  paletteNames?: ReadonlyArray<string | undefined>;
  /** Adds an opaque "Background" layer filled with this colour. */
  background?: string | number | null;
  /** Names of image layers to create (bottom → top). Default ["Layer 1"]. */
  layers?: string[];
  frames?: number;
  /** Default frame duration (ms). Default 100. */
  frameDuration?: number;
  settings?: Partial<SpriteSettings>;
  notes?: string;
}

export const DEFAULT_SETTINGS: SpriteSettings = {
  paletteLock: true,
  missingColor: 'snap',
  lightDirection: 'top-left',
  previewBackground: null,
  colorBudget: null,
  outlineColor: null,
};

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'sprite'
  );
}

export function validateSize(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw invalidArg(`Canvas size must be positive integers, got ${width}x${height}`);
  }
  if (width > MAX_CANVAS || height > MAX_CANVAS) {
    throw invalidArg(
      `Canvas ${width}x${height} exceeds the ${MAX_CANVAS}px limit`,
      'Pixel art rarely needs more than 512x512',
    );
  }
}

export function newLayer(id: string, name: string, partial: Partial<LayerState> = {}): LayerState {
  return {
    id,
    name,
    type: 'image',
    parentId: null,
    visible: true,
    locked: false,
    opacity: 255,
    blendMode: 'normal',
    isBackground: false,
    continuous: false,
    ...partial,
  };
}

/** Create a new, empty document. */
export function createDocument(opts: CreateDocumentOptions): SpriteDocument {
  validateSize(opts.width, opts.height);
  const frames = opts.frames ?? 1;
  if (!Number.isInteger(frames) || frames < 1 || frames > MAX_FRAMES)
    throw invalidArg(`frames must be 1..${MAX_FRAMES}`);
  const duration = opts.frameDuration ?? 100;
  let palette: PaletteState;
  if (Array.isArray(opts.palette))
    palette = makePalette(
      opts.paletteName ?? 'custom',
      opts.palette,
      undefined,
      namesRecord(opts.paletteNames),
    );
  else palette = presetPalette(opts.palette ?? DEFAULT_PALETTE);

  const now = new Date().toISOString();
  const state: SpriteState = {
    version: 1,
    id: opts.id ?? slugify(opts.name),
    name: opts.name,
    width: opts.width,
    height: opts.height,
    colorMode: opts.colorMode ?? 'indexed',
    pixelRatio: { x: 1, y: 1 },
    grid: { x: 0, y: 0, w: 16, h: 16 },
    palette,
    layers: [],
    frames: Array.from({ length: frames }, () => ({ duration })),
    cels: [],
    tags: [],
    slices: [],
    selections: {},
    clipboards: {},
    settings: { ...DEFAULT_SETTINGS, ...opts.settings },
    notes: opts.notes ?? '',
    created: now,
    modified: now,
  };
  const doc = new SpriteDocument({
    state,
    images: new Map<string, PixelBuffer>(),
    masks: new Map<string, Mask>(),
    counters: { layer: 0, image: 0, mask: 0 },
  });

  // Build initial content directly (not an undoable step).
  if (opts.background !== undefined && opts.background !== null) {
    if (opts.width * opts.height * frames > MAX_DOC_PIXELS) {
      throw new PixelClausError(
        'LIMIT',
        `A ${opts.width}x${opts.height} background on ${frames} frames needs ${Math.round((opts.width * opts.height * frames) / 1e6)} Mpx (max ${MAX_DOC_PIXELS / 2 ** 20} Mpx per project)`,
        'Use fewer frames, a smaller canvas, or no background layer (set previewBackground instead)',
      );
    }
    const id = doc.nextId('layer');
    state.layers.push(newLayer(id, 'Background', { isBackground: true }));
    const value = initialFillValue(doc, opts.background);
    for (let f = 0; f < frames; f++) {
      const imgId = doc.nextId('image');
      doc.images.set(imgId, new PixelBuffer(opts.width, opts.height).fill(value));
      state.cels.push({ layerId: id, frame: f, imageId: imgId, x: 0, y: 0, opacity: 255, zIndex: 0 });
    }
  }
  for (const name of opts.layers ?? ['Layer 1']) {
    state.layers.push(newLayer(doc.nextId('layer'), name));
  }
  doc.markAllDirty();
  doc.markMetaDirty();
  return doc;
}

function initialFillValue(doc: SpriteDocument, bg: string | number): number {
  const pal = doc.state.palette;
  if (typeof bg === 'number') {
    if (bg < 1 || bg >= pal.colors.length) throw invalidArg(`background index ${bg} out of palette range`);
    return doc.state.colorMode === 'indexed' ? bg : (parseHex(pal.colors[bg]!) ?? 0);
  }
  const c = parseHex(bg);
  if (c === null) throw invalidArg(`Invalid background colour '${bg}'`);
  if (doc.state.colorMode === 'indexed') {
    const m = paletteMatcher(pal);
    const ex = m.exact(c);
    return ex > 0 ? ex : m.nearest(c);
  }
  return c;
}
