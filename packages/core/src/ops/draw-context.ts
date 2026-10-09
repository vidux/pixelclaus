/**
 * Shared plumbing for draw ops: context, target opening, readers, guards.
 */
import { PixelBuffer } from '../buffer/pixel-buffer.js';
import type { Mask } from '../buffer/mask.js';
import { pointsBounds } from '../draw/shapes.js';
import { canvasRect, openTarget, type DrawTarget } from '../draw/target.js';
import { PixelWriter, type Ink } from '../draw/writer.js';
import { invalidArg } from '../errors.js';
import { ColorResolver } from '../model/colors.js';
import type { SpriteDocument, Transaction } from '../model/document.js';
import { LIGHT_DIRECTIONS, type LightDirection } from '../model/types.js';
import { getCel, resolveImageLayer } from '../model/lookup.js';
import { detectRamps } from '../palette/ramps.js';
import { paletteValues } from '../model/palette-state.js';
import { compositeFrame } from '../render/composite.js';
import { intersectRect, type Point, type Rect } from '../util/geometry.js';
import type { DrawOp, DrawRequest, OpResult } from './draw-types.js';
import { getSelectionMask } from './selection.js';
export interface Ctx {
  tx: Transaction;
  doc: SpriteDocument;
  resolver: ColorResolver;
  req: DrawRequest;
  defaultLayer: string | undefined;
}

/** Pick a default drawing layer when the request does not name one. */
export function layerRefFor(ctx: Ctx, op: DrawOp): string {
  const ref = op.layer ?? ctx.defaultLayer;
  if (!ref) {
    const names = ctx.doc.state.layers.filter((l) => l.type === 'image').map((l) => `${l.name} (${l.id})`);
    throw invalidArg(
      'No layer specified and the sprite has several image layers',
      `Set "layer" on the call or op. Image layers: ${names.join(', ')}`,
    );
  }
  return ref;
}

export function frameFor(ctx: Ctx, op: DrawOp): number {
  return op.frame ?? ctx.req.frame ?? 0;
}

export function clipFor(ctx: Ctx, op: DrawOp): Mask | null {
  const name = op.clip ?? ctx.req.clip;
  return name ? getSelectionMask(ctx.doc, name) : null;
}

export interface Opened {
  target: DrawTarget;
  writer: PixelWriter;
  clip: Mask | null;
}

export function open(ctx: Ctx, op: DrawOp, inkOverride?: Ink): Opened {
  const target = openTarget(ctx.tx, layerRefFor(ctx, op), frameFor(ctx, op))!;
  const clip = clipFor(ctx, op);
  const writer = new PixelWriter(target, {
    clip,
    symmetry: ctx.req.symmetry ?? null,
    ink: inkOverride ?? op.ink ?? ctx.req.ink ?? 'replace',
    resolver: ctx.resolver,
  });
  return { target, writer, clip };
}

export function done(op: DrawOp, o: Opened, note?: string): { result: OpResult; rect: Rect | null } {
  const result: OpResult = {
    op: op.op,
    layer: o.target.layer.name,
    frame: o.target.frame,
    written: o.writer.written,
  };
  if (o.writer.clipped) result.clipped = o.writer.clipped;
  if (!note && o.writer.written === 0 && !o.writer.clipped)
    note = 'no pixels changed (already that colour, or nothing to act on)';
  if (note) result.note = note;
  return { result, rect: o.writer.dirty };
}

export function plotAll(o: Opened, pts: readonly Point[], value: number): void {
  o.writer.prepare(pointsBounds(pts));
  for (const p of pts) o.writer.plot(p.x, p.y, value);
}

export function areaFor(ctx: Ctx, area: Rect | undefined, clip: Mask | null): Rect {
  const canvas = canvasRect(ctx.tx);
  const base = area ?? clip?.bounds() ?? canvas;
  return intersectRect(base, canvas) ?? { x: 0, y: 0, w: 0, h: 0 };
}

/**
 * Reader for effects that analyse a shape (outline, selout): the target layer itself (default), the
 * flattened composite, or another layer. When the target cel is empty the composite is used so an
 * "Outline" layer can trace the art below it.
 */
export function sourceReader(
  ctx: Ctx,
  t: DrawTarget,
  source: string | undefined,
): { read: (x: number, y: number) => number; label: string } {
  const own = snapshotReader(ctx, t);
  const W = ctx.tx.state.width;
  const H = ctx.tx.state.height;
  const fromComposite = () => {
    const r = compositeFrame(ctx.doc, { frame: t.frame });
    const cache = new Map<number, number>();
    const read = (x: number, y: number) => {
      const c = r.get(x, y);
      if (c === 0) return 0;
      let v = cache.get(c);
      if (v === undefined) {
        v = ctx.resolver.fromRgba(c);
        cache.set(c, v);
      }
      return v;
    };
    return { read, label: 'composite' };
  };
  if (source === 'composite') return fromComposite();
  if (source && source !== 'layer' && source !== 'self') {
    const layer = resolveImageLayer(ctx.doc, source);
    const cel = getCel(ctx.doc.state, layer.id, t.frame);
    if (!cel) return { read: () => 0, label: `layer ${layer.name}` };
    const img = ctx.doc.image(cel.imageId).clone();
    return {
      read: (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : img.get(x - cel.x, y - cel.y)),
      label: `layer ${layer.name}`,
    };
  }
  if (source === undefined) {
    let empty = true;
    outer: for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (own(x, y) !== 0) {
          empty = false;
          break outer;
        }
    if (empty) return fromComposite();
  }
  return { read: own, label: 'target layer' };
}

/** Snapshot reader of a target cel in canvas coordinates. */
export function snapshotReader(ctx: Ctx, t: DrawTarget): (x: number, y: number) => number {
  const img = ctx.doc.image(t.cel.imageId).clone();
  const cx = t.cel.x;
  const cy = t.cel.y;
  const w = ctx.tx.state.width;
  const h = ctx.tx.state.height;
  return (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : img.get(x - cx, y - cy));
}

export function rampsFor(ctx: Ctx) {
  const ramps = ctx.doc.state.palette.ramps;
  return ramps.length ? ramps : detectRamps(paletteValues(ctx.doc.state.palette));
}

export const MAX_COORD = 65536;

/** Reject absurd coordinates early (a typo like w:100000 must not freeze the server). */
export function guardNumbers(op: DrawOp): void {
  const check = (v: unknown, path: string) => {
    if (typeof v === 'number' && (!Number.isFinite(v) || Math.abs(v) > MAX_COORD)) {
      throw invalidArg(
        `${path} = ${v} is out of range`,
        `Coordinates and sizes must be within ±${MAX_COORD}`,
      );
    }
  };
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > 4) return;
    // every element: a single far-away point anywhere in a long path would rasterise a huge line
    if (Array.isArray(v)) for (let i = 0; i < v.length; i++) walk(v[i], `${path}[${i}]`, depth + 1);
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, depth + 1);
    else check(v, path);
  };
  for (const k of [
    'x',
    'y',
    'w',
    'h',
    'cx',
    'cy',
    'r',
    'from',
    'to',
    'points',
    'area',
    'dx',
    'dy',
    'thickness',
    'width',
    'depth',
    'offsetX',
    'offsetY',
    'spacing',
  ] as const) {
    if (k in op) walk((op as unknown as Record<string, unknown>)[k], k, 0);
  }
}

export function validLight(dir: string | undefined): LightDirection | undefined {
  if (dir === undefined) return undefined;
  if (!LIGHT_DIRECTIONS.includes(dir as LightDirection))
    throw invalidArg(`Unknown light direction '${dir}'`, `Use ${LIGHT_DIRECTIONS.join(', ')}`);
  return dir as LightDirection;
}

export function dominantEdgeValue(
  read: (x: number, y: number) => number,
  W: number,
  H: number,
): number | null {
  const edge = new Map<number, number>();
  const inner = new Map<number, number>();
  let ne = 0;
  let ni = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = read(x, y);
      if (v === 0) continue;
      const isEdge = !(read(x + 1, y) && read(x - 1, y) && read(x, y + 1) && read(x, y - 1));
      const m = isEdge ? edge : inner;
      m.set(v, (m.get(v) ?? 0) + 1);
      if (isEdge) ne++;
      else ni++;
    }
  }
  let best: number | null = null;
  let bestN = 0;
  for (const [v, c] of edge) {
    if (c > bestN) {
      best = v;
      bestN = c;
    }
  }
  if (best === null || ne < 8 || bestN / ne < 0.6) return null;
  if (ni > 0 && (inner.get(best) ?? 0) / ni >= 0.25) return null;
  return best;
}

export function flipBuffer(src: PixelBuffer, fx: boolean, fy: boolean): PixelBuffer {
  const out = new PixelBuffer(src.width, src.height);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      out.data[y * src.width + x] = src.get(fx ? src.width - 1 - x : x, fy ? src.height - 1 - y : y);
    }
  }
  return out;
}

export function writeBuffer(
  o: Opened,
  src: PixelBuffer,
  x0: number,
  y0: number,
  mode: 'overlay' | 'replace',
  _ctx: Ctx,
): void {
  o.writer.prepare({ x: x0, y: y0, w: src.width, h: src.height });
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const v = src.data[y * src.width + x]!;
      if (mode === 'overlay' && v === 0) continue;
      o.writer.plot(x0 + x, y0 + y, v);
    }
  }
}
