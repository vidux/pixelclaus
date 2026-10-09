/**
 * Canvas commands: resize (with anchor), crop, trim, scale the whole sprite.
 */
import { Mask } from '../buffer/mask.js';
import { PixelBuffer } from '../buffer/pixel-buffer.js';
import { invalidArg } from '../errors.js';
import { validateSize } from '../model/create.js';
import type { SpriteDocument, Transaction } from '../model/document.js';
import type { CelState } from '../model/types.js';
import { resizeNearest, scale2x, scale3x } from '../transform/buffer.js';
import { anchorOffset, unionRect, type Anchor, type Rect } from '../util/geometry.js';

/** Re-home all content so the old canvas origin lands at (dx, dy) in a new w×h canvas. */
function rebase(tx: Transaction, w: number, h: number, dx: number, dy: number): void {
  const st = tx.state;
  const doc = tx.document;
  const groups = new Map<string, CelState>();
  for (const c of st.cels) if (!groups.has(c.imageId)) groups.set(c.imageId, c);
  for (const [id, first] of groups) {
    const buf = new PixelBuffer(w, h);
    buf.blit(doc.image(id), first.x + dx, first.y + dy);
    tx.replaceImage(id, buf);
    for (const c of st.cels) {
      if (c.imageId !== id) continue;
      c.x -= first.x;
      c.y -= first.y;
    }
  }
  for (const [name, cb] of Object.entries(st.clipboards))
    st.clipboards[name] = { ...cb, x: cb.x + dx, y: cb.y + dy };
  for (const [name, mid] of Object.entries(st.selections))
    st.selections[name] = tx.createMask(doc.mask(mid).resized(w, h, dx, dy));
  for (const s of st.slices)
    for (const k of s.keys) k.bounds = { ...k.bounds, x: k.bounds.x + dx, y: k.bounds.y + dy };
  st.width = w;
  st.height = h;
}

export function resizeCanvas(
  doc: SpriteDocument,
  width: number,
  height: number,
  anchor: Anchor = 'center',
): Rect {
  validateSize(width, height);
  const off = anchorOffset(doc.state.width, doc.state.height, width, height, anchor);
  return doc.transact(`Resize canvas to ${width}x${height}`, (tx) => {
    rebase(tx, width, height, off.x, off.y);
    return { x: off.x, y: off.y, w: width, h: height };
  });
}

export function cropCanvas(doc: SpriteDocument, r: Rect): Rect {
  validateSize(r.w, r.h);
  return doc.transact(`Crop canvas to ${r.w}x${r.h}`, (tx) => {
    rebase(tx, r.w, r.h, -r.x, -r.y);
    return r;
  });
}

/** Bounds of all non-empty pixels across every cel (or null if the sprite is empty). */
export function contentBounds(doc: SpriteDocument): Rect | null {
  let b: Rect | null = null;
  for (const c of doc.state.cels) {
    const ib = doc.image(c.imageId).bounds();
    if (ib) b = unionRect(b, { x: ib.x + c.x, y: ib.y + c.y, w: ib.w, h: ib.h });
  }
  if (!b) return null;
  const x0 = Math.max(0, b.x);
  const y0 = Math.max(0, b.y);
  const x1 = Math.min(doc.state.width, b.x + b.w);
  const y1 = Math.min(doc.state.height, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

export function trimCanvas(doc: SpriteDocument, padding = 0): Rect {
  const b = contentBounds(doc);
  if (!b) throw invalidArg('Nothing to trim: the sprite is empty');
  const r = { x: b.x - padding, y: b.y - padding, w: b.w + 2 * padding, h: b.h + 2 * padding };
  return cropCanvas(doc, r);
}

export type ScaleMethod = 'nearest' | 'scale2x' | 'scale3x';

/** Scale the whole sprite (canvas + content). Integer factors keep pixels crisp. */
export function scaleSprite(
  doc: SpriteDocument,
  opts: { factor?: number; width?: number; height?: number; method?: ScaleMethod },
): { width: number; height: number } {
  const st = doc.state;
  const method = opts.method ?? 'nearest';
  let w: number;
  let h: number;
  if (opts.factor !== undefined) {
    w = Math.round(st.width * opts.factor);
    h = Math.round(st.height * opts.factor);
  } else if (opts.width !== undefined || opts.height !== undefined) {
    w = opts.width ?? Math.round((st.width * opts.height!) / st.height);
    h = opts.height ?? Math.round((st.height * opts.width!) / st.width);
  } else throw invalidArg('scale needs factor or width/height');
  if (method !== 'nearest') {
    const k = method === 'scale2x' ? 2 : 3;
    if (w !== st.width * k || h !== st.height * k) throw invalidArg(`${method} requires factor ${k}`);
  }
  validateSize(w, h);
  const sx = w / st.width;
  const sy = h / st.height;
  if (!Number.isInteger(sx) || !Number.isInteger(sy))
    doc.addWarning('Non-integer scale factors distort pixel art; prefer 2x, 3x, 4x…');
  return doc.transact(`Scale sprite to ${w}x${h}`, (tx) => {
    const groups = new Map<string, CelState>();
    for (const c of st.cels) if (!groups.has(c.imageId)) groups.set(c.imageId, c);
    for (const [id, first] of groups) {
      const canvas = new PixelBuffer(st.width, st.height);
      canvas.blit(doc.image(id), first.x, first.y);
      const out =
        method === 'scale2x'
          ? scale2x(canvas)
          : method === 'scale3x'
            ? scale3x(canvas)
            : resizeNearest(canvas, w, h);
      tx.replaceImage(id, out);
    }
    for (const c of st.cels) {
      c.x = 0;
      c.y = 0;
    }
    for (const [name, mid] of Object.entries(st.selections)) {
      const m = doc.mask(mid);
      st.selections[name] = tx.createMask(
        Mask.fromPredicate(w, h, (x, y) => m.has(Math.floor(x / sx), Math.floor(y / sy))),
      );
    }
    for (const s of st.slices) {
      for (const k of s.keys) {
        k.bounds = {
          x: Math.round(k.bounds.x * sx),
          y: Math.round(k.bounds.y * sy),
          w: Math.round(k.bounds.w * sx),
          h: Math.round(k.bounds.h * sy),
        };
        if (k.center)
          k.center = {
            x: Math.round(k.center.x * sx),
            y: Math.round(k.center.y * sy),
            w: Math.round(k.center.w * sx),
            h: Math.round(k.center.h * sy),
          };
        if (k.pivot) k.pivot = { x: Math.round(k.pivot.x * sx), y: Math.round(k.pivot.y * sy) };
      }
    }
    st.clipboards = {};
    st.width = w;
    st.height = h;
    st.grid = { ...st.grid, w: Math.round(st.grid.w * sx), h: Math.round(st.grid.h * sy) };
    return { width: w, height: h };
  });
}
