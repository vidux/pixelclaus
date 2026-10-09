/**
 * Frame-to-frame comparison as numbers + an ASCII change map — the lossless channel for animation work.
 */
import type { Raster } from '../buffer/raster.js';
import type { SpriteDocument } from '../model/document.js';
import { assertFrame, resolveLayer } from '../model/lookup.js';
import { compositeFrame } from '../render/composite.js';
import { intersectRect, type Rect } from '../util/geometry.js';

export interface DiffReport {
  frameA: number;
  frameB: number;
  added: number;
  removed: number;
  recoloured: number;
  changed: number;
  /** Bounding rect of all changes. */
  bbox: Rect | null;
  /** Best whole-image translation from A to B within ±range px and the pixels it leaves unexplained. */
  bestShift: { dx: number; dy: number; residual: number };
  /** Pixels that differ without any shift (for comparison with bestShift.residual). */
  unshiftedResidual: number;
  /** ASCII map of the change bbox: '.' empty, 'o' unchanged, '+' added, '-' removed, '~' recoloured. */
  map: string | null;
  mapOrigin: { x: number; y: number } | null;
}

function mismatch(a: Raster, b: Raster, dx: number, dy: number): number {
  let n = 0;
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      const cb = b.get(x, y);
      const ca = a.get(x - dx, y - dy);
      if (ca !== cb) n++;
    }
  }
  return n;
}

export function diffFrames(
  doc: SpriteDocument,
  frameA: number,
  frameB: number,
  opts: { layers?: readonly string[]; range?: number } = {},
): DiffReport {
  assertFrame(doc.state, frameA);
  assertFrame(doc.state, frameB);
  const isolate = opts.layers?.map((l) => resolveLayer(doc, l).id);
  const A = compositeFrame(doc, { frame: frameA, isolate, includeReference: false });
  const B = compositeFrame(doc, { frame: frameB, isolate, includeReference: false });
  let added = 0;
  let removed = 0;
  let recoloured = 0;
  let x0 = A.width;
  let y0 = A.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < A.height; y++) {
    for (let x = 0; x < A.width; x++) {
      const a = A.get(x, y);
      const b = B.get(x, y);
      if (a === b) continue;
      if (a === 0) added++;
      else if (b === 0) removed++;
      else recoloured++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const bbox = x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  const range = Math.max(0, Math.min(8, opts.range ?? 4));
  const unshifted = added + removed + recoloured;
  let best = { dx: 0, dy: 0, residual: unshifted };
  if (unshifted > 0) {
    for (let dy = -range; dy <= range; dy++) {
      for (let dx = -range; dx <= range; dx++) {
        if (!dx && !dy) continue;
        const m = mismatch(A, B, dx, dy);
        if (m < best.residual) best = { dx, dy, residual: m };
      }
    }
  }
  let map: string | null = null;
  let mapOrigin: { x: number; y: number } | null = null;
  if (bbox) {
    // pad by 1 for context, cap at 64x64 to keep the reply small
    const pad = intersectRect(
      { x: bbox.x - 1, y: bbox.y - 1, w: Math.min(64, bbox.w + 2), h: Math.min(64, bbox.h + 2) },
      { x: 0, y: 0, w: A.width, h: A.height },
    )!;
    const rows: string[] = [];
    for (let y = pad.y; y < pad.y + pad.h; y++) {
      let row = '';
      for (let x = pad.x; x < pad.x + pad.w; x++) {
        const a = A.get(x, y);
        const b = B.get(x, y);
        row += a === b ? (a === 0 ? '.' : 'o') : a === 0 ? '+' : b === 0 ? '-' : '~';
      }
      rows.push(`${String(y).padStart(String(A.height - 1).length, '0')}| ${row}`);
    }
    map = rows.join('\n');
    mapOrigin = { x: pad.x, y: pad.y };
  }
  return {
    frameA,
    frameB,
    added,
    removed,
    recoloured,
    changed: unshifted,
    bbox,
    bestShift: best,
    unshiftedResidual: unshifted,
    map,
    mapOrigin,
  };
}
