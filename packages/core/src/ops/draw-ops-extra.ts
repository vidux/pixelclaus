/**
 * Draw ops that touch several cels or the clipboard: copy, replace_color.
 */
import { PixelBuffer } from '../buffer/pixel-buffer.js';
import { channelDistance } from '../color/rgba.js';
import { ensureCovers, openTarget, readCel } from '../draw/target.js';
import { celsOfLayer, getCel, isEffectivelyLocked, resolveImageLayer } from '../model/lookup.js';
import { compositeFrame } from '../render/composite.js';
import { unionRect, type Rect } from '../util/geometry.js';
import type { DrawOp, OpResult } from './draw-types.js';
import { areaFor, clipFor, frameFor, layerRefFor, type Ctx } from './draw-context.js';

export function copyOp(
  ctx: Ctx,
  op: Extract<DrawOp, { op: 'copy' }>,
): { result: OpResult; rect: Rect | null } {
  const name = op.name ?? 'default';
  const clip = clipFor(ctx, op);
  const area = areaFor(ctx, op.area, clip);
  const buf = new PixelBuffer(area.w, area.h);
  const frame = frameFor(ctx, op);
  let label: string;
  if (op.source === 'composite') {
    const raster = compositeFrame(ctx.doc, { frame });
    for (let y = 0; y < area.h; y++) {
      for (let x = 0; x < area.w; x++) {
        const c = raster.get(area.x + x, area.y + y);
        buf.data[y * area.w + x] = c === 0 ? 0 : ctx.resolver.fromRgba(c);
      }
    }
    label = `composite@${frame}`;
  } else {
    const layer = resolveImageLayer(ctx.doc, layerRefFor(ctx, op));
    const cel = getCel(ctx.doc.state, layer.id, frame);
    if (cel)
      for (let y = 0; y < area.h; y++)
        for (let x = 0; x < area.w; x++)
          buf.data[y * area.w + x] = readCel(ctx.tx, cel, area.x + x, area.y + y);
    label = `${layer.name}@${frame}`;
  }
  if (clip)
    for (let y = 0; y < area.h; y++)
      for (let x = 0; x < area.w; x++) if (!clip.has(area.x + x, area.y + y)) buf.data[y * area.w + x] = 0;
  const imageId = ctx.tx.adoptImage(buf);
  ctx.tx.state.clipboards[name] = { imageId, x: area.x, y: area.y };
  return {
    result: {
      op: 'copy',
      frame,
      written: 0,
      note: `copied ${label} ${area.w}x${area.h} from ${area.x},${area.y} into clipboard '${name}'`,
    },
    rect: null,
  };
}

export function replaceColor(
  ctx: Ctx,
  op: Extract<DrawOp, { op: 'replace_color' }>,
): { result: OpResult; rect: Rect | null } {
  const R = ctx.resolver;
  const from = R.resolve(op.from);
  const to = R.resolve(op.to);
  const tol = op.tolerance ?? 0;
  const scope = op.scope ?? 'cel';
  const clip = clipFor(ctx, op);
  const st = ctx.doc.state;
  const frame = frameFor(ctx, op);
  if (from === 0) {
    // replace transparent = fill every empty pixel of the targeted cels (cels grow to the full canvas)
    if (scope === 'cel') openTarget(ctx.tx, layerRefFor(ctx, op), frameFor(ctx, op));
  }
  const cels = (() => {
    if (scope === 'cel') {
      const l = resolveImageLayer(ctx.doc, layerRefFor(ctx, op));
      const c = getCel(st, l.id, frame);
      return c ? [c] : [];
    }
    if (scope === 'layer') return celsOfLayer(st, resolveImageLayer(ctx.doc, layerRefFor(ctx, op)).id);
    if (scope === 'frame') return st.cels.filter((c) => c.frame === frame);
    return [...st.cels];
  })();
  const fromRgba = R.rgba(from);
  const matches = (v: number) => (tol === 0 ? v === from : channelDistance(R.rgba(v), fromRgba) <= tol);
  const seen = new Set<string>();
  let written = 0;
  let skippedLocked = 0;
  let dirty: Rect | null = null;
  for (const cel of cels) {
    if (seen.has(cel.imageId)) continue;
    seen.add(cel.imageId);
    const layer = st.layers.find((l) => l.id === cel.layerId)!;
    if (layer.type !== 'image' && layer.type !== 'reference') continue;
    if (isEffectivelyLocked(st, layer)) {
      skippedLocked++;
      continue;
    }
    if (from === 0) ensureCovers({ tx: ctx.tx, layer, frame: cel.frame, cel }, null);
    const img = ctx.tx.writeImage(cel.imageId);
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = y * img.width + x;
        const v = img.data[i]!;
        if (from === 0 ? v !== 0 : v === 0 || !matches(v)) continue;
        if (clip && !clip.has(x + cel.x, y + cel.y)) continue;
        if (v === to) continue;
        img.data[i] = to;
        written++;
        dirty = unionRect(dirty, { x: x + cel.x, y: y + cel.y, w: 1, h: 1 });
      }
    }
  }
  if (skippedLocked) ctx.tx.warn(`replace_color skipped ${skippedLocked} cel(s) on locked layers`);
  return {
    result: { op: 'replace_color', written, note: `scope ${scope}, ${seen.size} image(s)` },
    rect: dirty,
  };
}
