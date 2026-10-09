/**
 * Cel commands: link/unlink, clear, offsets, opacity, copy between layers/frames, offset tweening.
 */
import { invalidArg } from '../errors.js';
import type { SpriteDocument } from '../model/document.js';
import { assertFrame, getCel, resolveImageLayer } from '../model/lookup.js';
import { createCel } from '../draw/target.js';

function cleanFrames(doc: SpriteDocument, frames: readonly number[]): number[] {
  frames.forEach((f) => assertFrame(doc.state, f));
  return [...new Set(frames)].sort((a, b) => a - b);
}

/** Make all given frames of a layer share the image of the first frame's cel. */
export function linkCels(doc: SpriteDocument, layerRef: string, frames: readonly number[]): number {
  const layer = resolveImageLayer(doc, layerRef);
  const fs = cleanFrames(doc, frames);
  if (fs.length < 2) throw invalidArg('link needs at least 2 frames');
  return doc.transact(`Link ${layer.name} cels ${fs.join(',')}`, (tx) => {
    const st = tx.state;
    const first = getCel(st, layer.id, fs[0]!) ?? createCel(tx, layer.id, fs[0]!);
    for (const f of fs.slice(1)) {
      const c = getCel(st, layer.id, f);
      if (c) Object.assign(c, { imageId: first.imageId, x: first.x, y: first.y, opacity: first.opacity });
      else st.cels.push({ ...first, frame: f });
    }
    return fs.length;
  });
}

/** Give each given cel its own copy of its image. */
export function unlinkCels(doc: SpriteDocument, layerRef: string, frames: readonly number[]): number {
  const layer = resolveImageLayer(doc, layerRef);
  const fs = cleanFrames(doc, frames);
  return doc.transact(`Unlink ${layer.name} cels`, (tx) => {
    let n = 0;
    for (const f of fs) {
      const c = getCel(tx.state, layer.id, f);
      if (!c) continue;
      const shared = tx.state.cels.filter((x) => x.imageId === c.imageId).length > 1;
      if (!shared) continue;
      c.imageId = tx.adoptImage(doc.image(c.imageId).clone());
      n++;
    }
    return n;
  });
}

/** Delete cels (frames become empty for this layer). */
export function clearCels(doc: SpriteDocument, layerRef: string, frames: readonly number[]): number {
  const layer = resolveImageLayer(doc, layerRef);
  const fs = new Set(cleanFrames(doc, frames));
  return doc.transact(`Clear ${layer.name} cels`, (tx) => {
    const before = tx.state.cels.length;
    tx.state.cels = tx.state.cels.filter((c) => !(c.layerId === layer.id && fs.has(c.frame)));
    return before - tx.state.cels.length;
  });
}

export interface OffsetSpec {
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
}

/** Set (x/y) or shift (dx/dy) cel positions. Linked cels move together only if all are listed. */
export function moveCels(
  doc: SpriteDocument,
  layerRef: string,
  frames: readonly number[],
  spec: OffsetSpec,
): number {
  const layer = resolveImageLayer(doc, layerRef);
  const fs = cleanFrames(doc, frames);
  if (spec.x === undefined && spec.y === undefined && spec.dx === undefined && spec.dy === undefined) {
    throw invalidArg('Give x/y (absolute) or dx/dy (relative)');
  }
  return doc.transact(`Move ${layer.name} cels`, (tx) => {
    let n = 0;
    for (const f of fs) {
      const c = getCel(tx.state, layer.id, f);
      if (!c) continue;
      c.x = spec.x !== undefined ? Math.round(spec.x) : c.x + Math.round(spec.dx ?? 0);
      c.y = spec.y !== undefined ? Math.round(spec.y) : c.y + Math.round(spec.dy ?? 0);
      n++;
    }
    return n;
  });
}

export function setCelOpacity(
  doc: SpriteDocument,
  layerRef: string,
  frames: readonly number[],
  opacity: number,
): number {
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 255) throw invalidArg('opacity must be 0..255');
  const layer = resolveImageLayer(doc, layerRef);
  const fs = cleanFrames(doc, frames);
  return doc.transact(`Cel opacity ${layer.name}`, (tx) => {
    let n = 0;
    for (const f of fs) {
      const c = getCel(tx.state, layer.id, f);
      if (c) {
        c.opacity = Math.round(opacity);
        n++;
      }
    }
    return n;
  });
}

/** Copy (or link) a cel to another layer/frame, replacing what is there. */
export function copyCel(
  doc: SpriteDocument,
  from: { layer: string; frame: number },
  to: { layer: string; frame: number },
  link = false,
): void {
  const sl = resolveImageLayer(doc, from.layer);
  const dl = resolveImageLayer(doc, to.layer);
  assertFrame(doc.state, from.frame);
  assertFrame(doc.state, to.frame);
  const src = getCel(doc.state, sl.id, from.frame);
  if (!src) throw invalidArg(`Layer '${sl.name}' has no cel at frame ${from.frame}`);
  doc.transact(`Copy cel ${sl.name}@${from.frame} → ${dl.name}@${to.frame}`, (tx) => {
    tx.state.cels = tx.state.cels.filter((c) => !(c.layerId === dl.id && c.frame === to.frame));
    const imageId = link ? src.imageId : tx.adoptImage(doc.image(src.imageId).clone());
    tx.state.cels.push({ ...src, layerId: dl.id, frame: to.frame, imageId });
  });
}

export type Ease = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';

export function ease(kind: Ease, t: number): number {
  switch (kind) {
    case 'ease-in':
      return t * t;
    case 'ease-out':
      return 1 - (1 - t) * (1 - t);
    case 'ease-in-out':
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    default:
      return t;
  }
}

/**
 * Interpolate cel offsets between the cels at `from` and `to` (both must exist). Frames in between
 * without a cel get one linked to the `from` cel's image.
 */
export function tweenOffsets(
  doc: SpriteDocument,
  layerRef: string,
  from: number,
  to: number,
  kind: Ease = 'linear',
): number {
  const layer = resolveImageLayer(doc, layerRef);
  assertFrame(doc.state, from);
  assertFrame(doc.state, to);
  if (to - from < 2) throw invalidArg('tween needs at least one frame between from and to');
  const a = getCel(doc.state, layer.id, from);
  const b = getCel(doc.state, layer.id, to);
  if (!a || !b) throw invalidArg(`Both frame ${from} and ${to} need a cel on '${layer.name}'`);
  return doc.transact(`Tween ${layer.name} ${from}..${to}`, (tx) => {
    let n = 0;
    for (let f = from + 1; f < to; f++) {
      const t = ease(kind, (f - from) / (to - from));
      const x = Math.round(a.x + (b.x - a.x) * t);
      const y = Math.round(a.y + (b.y - a.y) * t);
      const c = getCel(tx.state, layer.id, f);
      if (c) Object.assign(c, { x, y });
      else tx.state.cels.push({ ...a, frame: f, x, y });
      n++;
    }
    return n;
  });
}
