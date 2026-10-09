/**
 * Named, persistent selections (immutable masks). Draw ops and transforms can be clipped to them.
 */
import { Mask } from '../buffer/mask.js';
import { channelDistance } from '../color/rgba.js';
import { floodRegion } from '../draw/fill.js';
import { ellipseFillPoints, polygonFillPoints } from '../draw/shapes.js';
import { invalidArg, notFound } from '../errors.js';
import { ColorResolver, type ColorInput } from '../model/colors.js';
import type { SpriteDocument } from '../model/document.js';
import { assertFrame, getCel, resolveImageLayer } from '../model/lookup.js';
import { compositeFrame } from '../render/composite.js';
import type { Point, Rect } from '../util/geometry.js';
import type { PointInput } from './draw-types.js';
import { toPoint } from './points.js';

export type SelectionMode = 'replace' | 'add' | 'subtract' | 'intersect';

export type SelectionShape =
  | ({ shape: 'rect' } & Rect)
  | ({ shape: 'ellipse' } & Rect)
  | { shape: 'polygon'; points: readonly PointInput[] }
  | {
      shape: 'wand';
      x: number;
      y: number;
      layer?: string;
      frame?: number;
      tolerance?: number;
      contiguous?: boolean;
      connectivity?: 4 | 8;
      reference?: 'layer' | 'composite';
    }
  | { shape: 'color'; color: ColorInput; layer?: string; frame?: number; tolerance?: number }
  | { shape: 'alpha'; layer?: string; frame?: number }
  | { shape: 'all' }
  | { shape: 'none' };

export interface SelectionInfo {
  name: string;
  pixels: number;
  bounds: Rect | null;
}

export function getSelectionMask(doc: SpriteDocument, name: string): Mask {
  const id = doc.state.selections[name];
  if (!id) throw notFound('selection', name, Object.keys(doc.state.selections));
  return doc.mask(id);
}

export function listSelections(doc: SpriteDocument): SelectionInfo[] {
  return Object.entries(doc.state.selections).map(([name, id]) => {
    const m = doc.mask(id);
    return { name, pixels: m.count(), bounds: m.bounds() };
  });
}

function sampleReader(
  doc: SpriteDocument,
  layerRef: string | undefined,
  frame: number,
  reference: 'layer' | 'composite',
): (x: number, y: number) => number {
  assertFrame(doc.state, frame);
  if (reference === 'composite' || !layerRef) {
    const r = compositeFrame(doc, { frame });
    return (x, y) => r.get(x, y);
  }
  const layer = resolveImageLayer(doc, layerRef);
  const cel = getCel(doc.state, layer.id, frame);
  if (!cel) return () => 0;
  const img = doc.image(cel.imageId);
  const resolver = new ColorResolver(doc);
  return (x, y) => resolver.rgba(img.get(x - cel.x, y - cel.y));
}

/** Build the mask for a shape (canvas sized). */
export function shapeMask(doc: SpriteDocument, s: SelectionShape): Mask {
  const W = doc.state.width;
  const H = doc.state.height;
  switch (s.shape) {
    case 'rect':
      return Mask.fromRect(W, H, s);
    case 'ellipse':
      return Mask.fromPoints(W, H, ellipseFillPoints(s));
    case 'polygon': {
      if (s.points.length < 3) throw invalidArg('polygon selection needs at least 3 points');
      return Mask.fromPoints(W, H, polygonFillPoints(s.points.map(toPoint)));
    }
    case 'wand': {
      const read = sampleReader(doc, s.layer, s.frame ?? 0, s.reference ?? (s.layer ? 'layer' : 'composite'));
      return floodRegion(W, H, s.x, s.y, read, (a, b, t) => channelDistance(a, b) <= t, {
        contiguous: s.contiguous ?? true,
        connectivity: s.connectivity ?? 4,
        tolerance: s.tolerance ?? 0,
      });
    }
    case 'color': {
      const resolver = new ColorResolver(doc);
      const target = resolver.rgba(resolver.resolve(s.color));
      const read = sampleReader(doc, s.layer, s.frame ?? 0, s.layer ? 'layer' : 'composite');
      const tol = s.tolerance ?? 0;
      return Mask.fromPredicate(W, H, (x, y) => {
        const v = read(x, y);
        return target === 0 ? v === 0 : v !== 0 && channelDistance(v, target) <= tol;
      });
    }
    case 'alpha': {
      const read = sampleReader(doc, s.layer, s.frame ?? 0, s.layer ? 'layer' : 'composite');
      return Mask.fromPredicate(W, H, (x, y) => read(x, y) !== 0);
    }
    case 'all':
      return Mask.full(W, H);
    case 'none':
      return new Mask(W, H);
  }
}

export function select(
  doc: SpriteDocument,
  args: SelectionShape & { name?: string; mode?: SelectionMode },
): SelectionInfo {
  const name = args.name ?? 'active';
  const mode = args.mode ?? 'replace';
  return doc.transact(`Select ${args.shape} → ${name}`, (tx) => {
    const shape = shapeMask(doc, args);
    const existingId = tx.state.selections[name];
    const base = existingId ? doc.mask(existingId) : new Mask(doc.state.width, doc.state.height);
    const result = mode === 'replace' ? shape : base.combine(shape, mode);
    tx.state.selections[name] = tx.createMask(result);
    return { name, pixels: result.count(), bounds: result.bounds() };
  });
}

export type SelectionModify =
  | { action: 'invert' }
  | { action: 'grow'; amount: number; connectivity?: 4 | 8 }
  | { action: 'shrink'; amount: number; connectivity?: 4 | 8 }
  | { action: 'border'; amount?: number; connectivity?: 4 | 8 }
  | { action: 'move'; dx: number; dy: number }
  | { action: 'combine'; other: string; mode: SelectionMode };

export function modifySelection(doc: SpriteDocument, name: string, m: SelectionModify): SelectionInfo {
  const cur = getSelectionMask(doc, name);
  return doc.transact(`Selection ${m.action} ${name}`, (tx) => {
    let next: Mask;
    switch (m.action) {
      case 'invert':
        next = cur.invert();
        break;
      case 'grow':
        next = cur.grow(Math.abs(m.amount), m.connectivity ?? 8);
        break;
      case 'shrink':
        next = cur.grow(-Math.abs(m.amount), m.connectivity ?? 8);
        break;
      case 'border':
        next = cur.border(m.amount ?? 1, m.connectivity ?? 8);
        break;
      case 'move':
        next = cur.translate(Math.round(m.dx), Math.round(m.dy));
        break;
      case 'combine':
        next = cur.combine(getSelectionMask(doc, m.other), m.mode);
        break;
    }
    tx.state.selections[name] = tx.createMask(next);
    return { name, pixels: next.count(), bounds: next.bounds() };
  });
}

export function deleteSelection(doc: SpriteDocument, name: string): void {
  getSelectionMask(doc, name);
  doc.transact(`Delete selection ${name}`, (tx) => {
    delete tx.state.selections[name];
  });
}

export function renameSelection(doc: SpriteDocument, name: string, to: string): void {
  getSelectionMask(doc, name);
  doc.transact(`Rename selection ${name}`, (tx) => {
    const id = tx.state.selections[name]!;
    delete tx.state.selections[name];
    tx.state.selections[to] = id;
  });
}

export type { Point };
