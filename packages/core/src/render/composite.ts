/**
 * Frame compositor: flattens layers (with groups, opacity and blend modes) into an RGBA raster.
 */
import { Raster } from '../buffer/raster.js';
import { blendInto } from '../color/blend.js';
import type { SpriteDocument } from '../model/document.js';
import { getCel, layerChildren } from '../model/lookup.js';
import { paletteValues } from '../model/palette-state.js';
import type { CelState, LayerState } from '../model/types.js';

export interface CompositeOptions {
  frame: number;
  /** Render only these layers (ids), flattened in z-order, ignoring visibility and group effects. */
  isolate?: readonly string[];
  /** Include hidden layers (default false). */
  includeHidden?: boolean;
  /** Include reference layers (default true for previews; exports pass false). */
  includeReference?: boolean;
  /** Override individual layer visibility (id → visible). */
  visibility?: Readonly<Record<string, boolean>>;
}

/** Lookup table value → packed RGBA for a document (indexed: palette, rgba: identity). */
export function valueToRgbaFn(doc: SpriteDocument): (v: number) => number {
  if (doc.state.colorMode === 'rgba') return (v) => v >>> 0;
  const lut = new Uint32Array(256);
  paletteValues(doc.state.palette).forEach((c, i) => (lut[i] = i === 0 ? 0 : c));
  return (v) => (v < 256 ? lut[v]! : 0);
}

/** Composite a single cel onto `dst` with the given opacity (0..1) and blend mode. */
export function drawCel(
  doc: SpriteDocument,
  dst: Raster,
  cel: CelState,
  layer: LayerState,
  toRgba: (v: number) => number,
  opacityOverride?: number,
): void {
  const img = doc.images.get(cel.imageId);
  if (!img) return;
  const opacity = opacityOverride ?? (layer.opacity / 255) * (cel.opacity / 255);
  if (opacity <= 0) return;
  const mode = layer.blendMode;
  const W = dst.width;
  const H = dst.height;
  const d = dst.data;
  for (let y = 0; y < img.height; y++) {
    const ty = cel.y + y;
    if (ty < 0 || ty >= H) continue;
    for (let x = 0; x < img.width; x++) {
      const tx = cel.x + x;
      if (tx < 0 || tx >= W) continue;
      const v = img.data[y * img.width + x]!;
      if (v === 0) continue;
      const c = toRgba(v);
      const a = c & 255;
      if (a === 0) continue;
      const di = (ty * W + tx) * 4;
      if (mode === 'normal' && a === 255 && opacity >= 1) {
        d[di] = c >>> 24;
        d[di + 1] = (c >>> 16) & 255;
        d[di + 2] = (c >>> 8) & 255;
        d[di + 3] = 255;
      } else {
        blendInto(d, di, c >>> 24, (c >>> 16) & 255, (c >>> 8) & 255, a, opacity, mode);
      }
    }
  }
}

function layerShown(layer: LayerState, opts: CompositeOptions): boolean {
  const override = opts.visibility?.[layer.id];
  const visible = override ?? layer.visible;
  if (!visible && !opts.includeHidden) return false;
  if (layer.type === 'reference' && opts.includeReference === false) return false;
  return true;
}

function renderGroup(
  doc: SpriteDocument,
  parentId: string | null,
  opts: CompositeOptions,
  toRgba: (v: number) => number,
): Raster {
  const out = new Raster(doc.state.width, doc.state.height);
  for (const layer of layerChildren(doc.state, parentId)) {
    if (!layerShown(layer, opts)) continue;
    if (layer.type === 'group') {
      const sub = renderGroup(doc, layer.id, opts, toRgba);
      const op = layer.opacity / 255;
      const d = out.data;
      const s = sub.data;
      for (let i = 0; i < s.length; i += 4) {
        if (s[i + 3] === 0) continue;
        blendInto(d, i, s[i]!, s[i + 1]!, s[i + 2]!, s[i + 3]!, op, layer.blendMode);
      }
      continue;
    }
    const cel = getCel(doc.state, layer.id, opts.frame);
    if (cel) drawCel(doc, out, cel, layer, toRgba);
  }
  return out;
}

/** Render one frame to RGBA. */
export function compositeFrame(doc: SpriteDocument, opts: CompositeOptions): Raster {
  const toRgba = valueToRgbaFn(doc);
  if (opts.isolate && opts.isolate.length) {
    const out = new Raster(doc.state.width, doc.state.height);
    const ids = new Set(opts.isolate);
    // z-order: depth-first order of all layers
    const order: LayerState[] = [];
    const rec = (pid: string | null) => {
      for (const l of layerChildren(doc.state, pid)) {
        if (l.type === 'group') rec(l.id);
        else order.push(l);
      }
    };
    rec(null);
    // isolating a group isolates its descendants
    const expand = new Set<string>(ids);
    for (const l of doc.state.layers) {
      let p = l.parentId;
      while (p) {
        if (ids.has(p)) expand.add(l.id);
        p = doc.state.layers.find((x) => x.id === p)?.parentId ?? null;
      }
    }
    for (const l of order) {
      if (!expand.has(l.id)) continue;
      const cel = getCel(doc.state, l.id, opts.frame);
      if (cel) drawCel(doc, out, cel, l, toRgba, (l.opacity / 255) * (cel.opacity / 255));
    }
    return out;
  }
  return renderGroup(doc, null, opts, toRgba);
}

/** Render the cel image of a single layer at a frame in canvas space (raw values → RGBA, no opacity). */
export function renderLayerRaw(doc: SpriteDocument, layerId: string, frame: number): Raster {
  const out = new Raster(doc.state.width, doc.state.height);
  const cel = getCel(doc.state, layerId, frame);
  const layer = doc.state.layers.find((l) => l.id === layerId);
  if (cel && layer) drawCel(doc, out, cel, { ...layer, blendMode: 'normal' }, valueToRgbaFn(doc), 1);
  return out;
}
