/**
 * Transform commands applied to cels, whole layers, the whole sprite or the contents of a selection.
 */
import { Mask } from '../buffer/mask.js';
import { PixelBuffer } from '../buffer/pixel-buffer.js';
import { invalidArg } from '../errors.js';
import type { SpriteDocument, Transaction } from '../model/document.js';
import {
  assertFrame,
  getCel,
  isEffectivelyLocked,
  resolveFrames,
  resolveImageLayer,
  type FrameSpec,
} from '../model/lookup.js';
import type { CelState } from '../model/types.js';
import {
  flipH,
  flipV,
  offset,
  placeInto,
  resizeNearest,
  rotateNearest,
  rotateQuarter,
  rotsprite,
  scale2x,
  scale3x,
} from '../transform/buffer.js';
import type { Point, Rect } from '../util/geometry.js';
import { getSelectionMask } from './selection.js';

export type TransformOp =
  | { op: 'flip_h' }
  | { op: 'flip_v' }
  | { op: 'rotate'; angle: number; method?: 'nearest' | 'rotsprite'; pivot?: Point }
  | { op: 'scale'; factor?: number; sx?: number; sy?: number; method?: 'nearest' | 'scale2x' | 'scale3x' }
  /** wrap defaults to true for scope layer/sprite (tiling) and false for cel/selection (moving). */
  | { op: 'offset'; dx: number; dy: number; wrap?: boolean };

export type TransformScope = 'cel' | 'layer' | 'sprite' | 'selection';

export interface TransformRequest {
  scope: TransformScope;
  layer?: string;
  frames?: FrameSpec;
  /** Selection name for scope 'selection' (default 'active'). */
  selection?: string;
  transform: TransformOp;
}

export interface TransformResult {
  images: number;
  canvas?: { width: number; height: number };
  note?: string;
}

/** Apply a transform to a canvas-sized buffer, returning a canvas-sized buffer. */
function applyToCanvasBuffer(
  buf: PixelBuffer,
  t: TransformOp,
  keepSize = true,
  wrapDefault = true,
): PixelBuffer {
  const W = buf.width;
  const H = buf.height;
  switch (t.op) {
    case 'flip_h':
      return flipH(buf);
    case 'flip_v':
      return flipV(buf);
    case 'rotate': {
      const a = ((t.angle % 360) + 360) % 360;
      if (a % 90 === 0 && !t.pivot) {
        const r = rotateQuarter(buf, a / 90);
        if (!keepSize || (r.width === W && r.height === H)) return r;
        return placeInto(r, W, H, Math.floor((W - r.width) / 2), Math.floor((H - r.height) / 2));
      }
      return t.method === 'nearest'
        ? rotateNearest(buf, a, t.pivot?.x, t.pivot?.y)
        : rotsprite(buf, a, t.pivot?.x, t.pivot?.y);
    }
    case 'scale': {
      const sx = t.sx ?? t.factor ?? 1;
      const sy = t.sy ?? t.factor ?? 1;
      if (sx <= 0 || sy <= 0) throw invalidArg('scale factors must be > 0');
      let scaled: PixelBuffer;
      if (t.method === 'scale2x' || t.method === 'scale3x') {
        const k = t.method === 'scale2x' ? 2 : 3;
        if (sx !== k || sy !== k) throw invalidArg(`${t.method} requires factor ${k}`);
        scaled = k === 2 ? scale2x(buf) : scale3x(buf);
      } else scaled = resizeNearest(buf, Math.max(1, Math.round(W * sx)), Math.max(1, Math.round(H * sy)));
      if (!keepSize) return scaled;
      return placeInto(scaled, W, H, Math.round((W - scaled.width) / 2), Math.round((H - scaled.height) / 2));
    }
    case 'offset':
      return offset(buf, Math.round(t.dx), Math.round(t.dy), t.wrap ?? wrapDefault);
  }
}

function celCanvasBuffer(doc: SpriteDocument, cel: CelState): PixelBuffer {
  const out = new PixelBuffer(doc.state.width, doc.state.height);
  out.blit(doc.image(cel.imageId), cel.x, cel.y);
  return out;
}

/** Transform each unique image among `cels` in canvas space; resets offsets (linked cels keep relative offsets). */
function transformCels(tx: Transaction, cels: CelState[], t: TransformOp, wrapDefault = true): number {
  const groups = new Map<string, CelState[]>();
  for (const c of cels) {
    const g = groups.get(c.imageId) ?? [];
    g.push(c);
    groups.set(c.imageId, g);
  }
  for (const [imageId, group] of groups) {
    const first = group[0]!;
    const out = applyToCanvasBuffer(celCanvasBuffer(tx.document, first), t, true, wrapDefault);
    tx.replaceImage(imageId, out);
    for (const c of tx.state.cels) {
      if (c.imageId !== imageId) continue;
      const rx = c.x - first.x;
      const ry = c.y - first.y;
      c.x = rx;
      c.y = ry;
    }
  }
  return groups.size;
}

export function transform(doc: SpriteDocument, req: TransformRequest): TransformResult {
  const t = req.transform;
  return doc.transact(`Transform ${t.op} (${req.scope})`, (tx) => {
    const st = tx.state;
    if (req.scope === 'sprite') {
      const quarter = t.op === 'rotate' && !t.pivot && (((t.angle % 360) + 360) % 360) % 180 === 90;
      if (quarter && st.width !== st.height) {
        // rotate the canvas itself
        const q = (((t.angle % 360) + 360) % 360) / 90;
        const groups = new Map<string, CelState>();
        for (const c of st.cels) if (!groups.has(c.imageId)) groups.set(c.imageId, c);
        for (const [id, c] of groups) tx.replaceImage(id, rotateQuarter(celCanvasBuffer(doc, c), q));
        for (const c of st.cels) {
          c.x = 0;
          c.y = 0;
        }
        const W = st.width;
        st.width = st.height;
        st.height = W;
        for (const [name, mid] of Object.entries(st.selections)) {
          const m = doc.mask(mid);
          const b = new PixelBuffer(m.width, m.height, Uint32Array.from(m.data));
          const r = rotateQuarter(b, q);
          st.selections[name] = tx.createMask(new Mask(r.width, r.height, Uint8Array.from(r.data)));
        }
        st.slices = [];
        tx.warn('Rotating a non-square sprite swapped width/height; slices were removed');
        return { images: groups.size, canvas: { width: st.width, height: st.height } };
      }
      const locked = st.cels.filter((c) =>
        isEffectivelyLocked(
          st,
          st.layers.find((l) => l.id === c.layerId)!,
        ),
      );
      if (locked.length) tx.warn(`Transform applied to locked layers too (sprite scope)`);
      return { images: transformCels(tx, [...st.cels], t) };
    }
    if (!req.layer) throw invalidArg(`scope '${req.scope}' needs "layer"`);
    const layer = resolveImageLayer(doc, req.layer);
    if (isEffectivelyLocked(st, layer))
      throw invalidArg(`Layer '${layer.name}' is locked`, 'Unlock it with layer action "update"');
    if (req.scope === 'layer') {
      return {
        images: transformCels(
          tx,
          st.cels.filter((c) => c.layerId === layer.id),
          t,
        ),
      };
    }
    const frames = resolveFrames(st, req.frames, 'first');
    if (req.scope === 'cel') {
      const cels = frames.map((f) => getCel(st, layer.id, f)).filter((c): c is CelState => !!c);
      // moving one cel should not wrap pixels around the canvas unless asked
      return {
        images: transformCels(tx, cels, t, false),
        note: cels.length < frames.length ? `${frames.length - cels.length} frame(s) had no cel` : undefined,
      };
    }
    // selection scope
    const selName = req.selection ?? 'active';
    const mask = getSelectionMask(doc, selName);
    const bounds = mask.bounds();
    if (!bounds) throw invalidArg(`Selection '${selName}' is empty`);
    let newMask: Mask | null = null;
    let n = 0;
    const processed = new Set<string>();
    for (const f of frames) {
      assertFrame(st, f);
      const cel = getCel(st, layer.id, f);
      if (!cel || processed.has(cel.imageId)) continue;
      processed.add(cel.imageId);
      const canvas = celCanvasBuffer(doc, cel);
      const { region, maskRegion } = extract(canvas, mask, bounds);
      // clear selected pixels
      for (let y = 0; y < bounds.h; y++)
        for (let x = 0; x < bounds.w; x++)
          if (maskRegion.get(x, y)) canvas.set(bounds.x + x, bounds.y + y, 0);
      const { buf: tr, at } = transformRegion(region, bounds, t);
      const { buf: trMask } = transformRegion(maskRegion, bounds, t);
      for (let y = 0; y < tr.height; y++) {
        for (let x = 0; x < tr.width; x++) {
          if (!trMask.get(x, y)) continue;
          canvas.set(at.x + x, at.y + y, tr.get(x, y));
        }
      }
      tx.replaceImage(cel.imageId, canvas);
      for (const c of st.cels) {
        if (c.imageId !== cel.imageId) continue;
        c.x = 0;
        c.y = 0;
      }
      if (!newMask) {
        newMask = new Mask(st.width, st.height);
        for (let y = 0; y < trMask.height; y++)
          for (let x = 0; x < trMask.width; x++) if (trMask.get(x, y)) newMask.set(at.x + x, at.y + y, true);
      }
      n++;
    }
    if (newMask) st.selections[selName] = tx.createMask(newMask);
    return { images: n };
  });
}

function extract(canvas: PixelBuffer, mask: Mask, b: Rect): { region: PixelBuffer; maskRegion: PixelBuffer } {
  const region = new PixelBuffer(b.w, b.h);
  const maskRegion = new PixelBuffer(b.w, b.h);
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      if (!mask.has(b.x + x, b.y + y)) continue;
      region.set(x, y, canvas.get(b.x + x, b.y + y));
      maskRegion.set(x, y, 1);
    }
  }
  return { region, maskRegion };
}

/** Transform a selection region; returns the new buffer and its canvas position. */
function transformRegion(buf: PixelBuffer, b: Rect, t: TransformOp): { buf: PixelBuffer; at: Point } {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  if (t.op === 'offset') {
    if (t.wrap) return { buf: offset(buf, Math.round(t.dx), Math.round(t.dy), true), at: { x: b.x, y: b.y } };
    return { buf, at: { x: b.x + Math.round(t.dx), y: b.y + Math.round(t.dy) } };
  }
  if (t.op === 'rotate') {
    const a = ((t.angle % 360) + 360) % 360;
    if (a % 90 === 0) {
      const r = rotateQuarter(buf, a / 90);
      return { buf: r, at: { x: Math.round(cx - r.width / 2), y: Math.round(cy - r.height / 2) } };
    }
    // rotate inside a square box large enough for the rotated content
    const side = Math.ceil(Math.hypot(b.w, b.h));
    const boxed = placeInto(buf, side, side, Math.floor((side - b.w) / 2), Math.floor((side - b.h) / 2));
    const r = t.method === 'nearest' ? rotateNearest(boxed, a) : rotsprite(boxed, a);
    return { buf: r, at: { x: Math.round(cx - side / 2), y: Math.round(cy - side / 2) } };
  }
  const r = applyToCanvasBuffer(buf, t, false);
  return { buf: r, at: { x: Math.round(cx - r.width / 2), y: Math.round(cy - r.height / 2) } };
}
