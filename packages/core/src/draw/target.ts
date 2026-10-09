import { PixelBuffer } from '../buffer/pixel-buffer.js';
import { PixelClausError } from '../errors.js';
import type { Transaction } from '../model/document.js';
import {
  assertFrame,
  getCel,
  isEffectivelyLocked,
  isEffectivelyVisible,
  linkedFrames,
  resolveImageLayer,
} from '../model/lookup.js';
import type { CelState, LayerState } from '../model/types.js';
import { intersectRect, rectContains, unionRect, type Rect } from '../util/geometry.js';

/** A writable (layer, frame) cel inside a transaction. */
export interface DrawTarget {
  tx: Transaction;
  layer: LayerState;
  frame: number;
  cel: CelState;
}

export interface OpenTargetOptions {
  /** Create an empty cel when none exists (default true). */
  create?: boolean;
  /** Skip lock check (internal structural ops). */
  ignoreLock?: boolean;
  /** Suppress hidden/linked warnings. */
  quiet?: boolean;
}

export function canvasRect(tx: Transaction): Rect {
  return { x: 0, y: 0, w: tx.state.width, h: tx.state.height };
}

/** Create a canvas-sized empty cel for (layer, frame). */
export function createCel(tx: Transaction, layerId: string, frame: number): CelState {
  const imageId = tx.createImage(tx.state.width, tx.state.height);
  const cel: CelState = { layerId, frame, imageId, x: 0, y: 0, opacity: 255, zIndex: 0 };
  tx.state.cels.push(cel);
  return cel;
}

export function openTarget(
  tx: Transaction,
  layerRef: string,
  frame: number,
  opts: OpenTargetOptions = {},
): DrawTarget | null {
  const doc = tx.document;
  const layer = resolveImageLayer(doc, layerRef);
  assertFrame(tx.state, frame);
  if (!opts.ignoreLock && isEffectivelyLocked(tx.state, layer)) {
    throw new PixelClausError(
      'LOCKED',
      `Layer '${layer.name}' is locked`,
      `Unlock it first: layer {action:"update", layer:"${layer.id}", locked:false}`,
    );
  }
  let cel = getCel(tx.state, layer.id, frame);
  if (!cel) {
    if (opts.create === false) return null;
    cel = createCel(tx, layer.id, frame);
  }
  if (!opts.quiet) {
    if (!isEffectivelyVisible(tx.state, layer))
      tx.warn(`Layer '${layer.name}' is hidden; edits will not show in composite renders`);
    const linked = linkedFrames(tx.state, cel);
    if (linked.length) {
      tx.warn(
        `Cel ${layer.name}@${frame} is linked with frame(s) ${linked.join(',')}; the edit affects all of them (cel action "unlink" edits one frame only)`,
      );
    }
  }
  return { tx, layer, frame, cel };
}

/** Cel bounds in canvas space. */
export function celRect(tx: Transaction, cel: CelState): Rect {
  const img = tx.document.image(cel.imageId);
  return { x: cel.x, y: cel.y, w: img.width, h: img.height };
}

/**
 * Make sure the cel image covers `area` (canvas space, clipped to canvas). Grows the image when the cel
 * was offset or trimmed. Linked cels are shifted consistently.
 */
export function ensureCovers(t: DrawTarget, area: Rect | null): void {
  const canvas = canvasRect(t.tx);
  const want = area ? intersectRect(area, canvas) : canvas;
  if (!want) return;
  const cur = celRect(t.tx, t.cel);
  if (rectContains(cur, want)) return;
  const next = unionRect(cur, want)!;
  const old = t.tx.document.image(t.cel.imageId);
  const buf = new PixelBuffer(next.w, next.h);
  buf.blit(old, cur.x - next.x, cur.y - next.y);
  t.tx.replaceImage(t.cel.imageId, buf);
  const dx = cur.x - next.x;
  const dy = cur.y - next.y;
  for (const c of t.tx.state.cels) {
    if (c.imageId === t.cel.imageId) {
      c.x -= dx;
      c.y -= dy;
    }
  }
}

/** Writable image of a target (backed up for undo). */
export function targetImage(t: DrawTarget): PixelBuffer {
  return t.tx.writeImage(t.cel.imageId);
}

/** Read the value at canvas (x, y) from a cel (0 outside). */
export function readCel(tx: Transaction, cel: CelState, x: number, y: number): number {
  return tx.document.image(cel.imageId).get(x - cel.x, y - cel.y);
}
