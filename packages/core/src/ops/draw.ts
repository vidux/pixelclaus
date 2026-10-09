/**
 * The `draw` command: executes a batch of drawing ops as ONE undoable transaction.
 */
import { PixelBuffer } from '../buffer/pixel-buffer.js';
import type { Mask } from '../buffer/mask.js';
import { adjustColor } from '../color/hsl.js';
import { channelDistance } from '../color/rgba.js';
import { defaultCharIndex, parseGrid, RESERVED_CHARS, stripVariationSelectors } from '../ascii/grid.js';
import { PATTERNS, patternHit, type PatternName } from '../draw/dither.js';
import { lightShadeChanges, outlinePixels, RampShifter, seloutChanges } from '../draw/effects.js';
import { floodRegion } from '../draw/fill.js';
import { gradientT, pickStop } from '../draw/gradient.js';
import {
  circleRect,
  ellipseFillPoints,
  ellipseOutlinePoints,
  linePoints,
  pixelPerfect,
  pointsBounds,
  polygonFillPoints,
  polylinePoints,
  rectFillPoints,
  rectOutlinePoints,
  strokeWithBrush,
} from '../draw/shapes.js';
import { canvasRect, readCel } from '../draw/target.js';
import { invalidArg, isPixelClausError, PixelClausError } from '../errors.js';
import { ColorResolver, type ColorInput } from '../model/colors.js';
import type { SpriteDocument } from '../model/document.js';
import { assertFrame, getCel, resolveImageLayer } from '../model/lookup.js';
import { mapToPalette } from '../palette/quantize.js';
import { compositeFrame } from '../render/composite.js';
import { FONTS, forEachTextPixel } from '../render/font.js';
import { intersectRect, unionRect, type Point, type Rect } from '../util/geometry.js';
import type { DrawOp, DrawRequest, DrawResult, OpResult } from './draw-types.js';
import { toPoint } from './points.js';
import {
  areaFor,
  dominantEdgeValue,
  done,
  flipBuffer,
  guardNumbers,
  open,
  plotAll,
  rampsFor,
  snapshotReader,
  sourceReader,
  validLight,
  writeBuffer,
  type Ctx,
} from './draw-context.js';
import { copyOp, replaceColor } from './draw-ops-extra.js';

export function defaultDrawLayer(doc: SpriteDocument): string | undefined {
  const images = doc.state.layers.filter((l) => l.type === 'image' && !l.isBackground);
  if (images.length === 1) return images[0]!.id;
  return undefined;
}

function summarize(ops: readonly DrawOp[]): string {
  const names = ops.map((o) => o.op);
  const uniq = [...new Set(names)];
  return `Draw ${names.length} op(s): ${uniq.slice(0, 6).join(', ')}${uniq.length > 6 ? '…' : ''}`;
}

export function draw(doc: SpriteDocument, req: DrawRequest): DrawResult {
  if (!req.ops || req.ops.length === 0) throw invalidArg('No ops given', 'Pass ops: [{op:"rect", ...}, ...]');
  return doc.transact(summarize(req.ops), (tx) => {
    const ctx: Ctx = {
      tx,
      doc,
      resolver: new ColorResolver(doc, tx),
      req,
      defaultLayer: req.layer ?? defaultDrawLayer(doc),
    };
    const results: OpResult[] = [];
    let dirty: Rect | null = null;
    let written = 0;
    req.ops.forEach((op, i) => {
      try {
        const { result, rect } = runOp(ctx, op);
        results.push(result);
        written += result.written;
        dirty = unionRect(dirty, rect);
      } catch (e) {
        if (isPixelClausError(e))
          throw new PixelClausError(e.code, `ops[${i}] (${op.op}): ${e.message}`, e.hint);
        throw e;
      }
    });
    return { results, written, dirty };
  });
}

/**
 * Area a stroke can still affect: the canvas plus one canvas size on every side (symmetry can mirror an
 * off-canvas point back onto the canvas when the axis is off-centre).
 */
function reachable(ctx: Ctx): Rect {
  const W = ctx.tx.state.width;
  const H = ctx.tx.state.height;
  return { x: -W, y: -H, w: 3 * W, h: 3 * H };
}

function runOp(ctx: Ctx, op: DrawOp): { result: OpResult; rect: Rect | null } {
  const R = ctx.resolver;
  guardNumbers(op);
  const canvas = canvasRect(ctx.tx);
  switch (op.op) {
    case 'pixels': {
      const o = open(ctx, op);
      const defaultColor = op.color;
      const pts = op.points.map((p) => {
        if (Array.isArray(p)) {
          const arr = p as readonly unknown[];
          const color = (arr.length >= 3 ? arr[2] : defaultColor) as ColorInput | undefined;
          return { x: Math.round(arr[0] as number), y: Math.round(arr[1] as number), color };
        }
        const obj = p as { x: number; y: number; color?: ColorInput };
        return { x: Math.round(obj.x), y: Math.round(obj.y), color: obj.color ?? defaultColor };
      });
      o.writer.prepare(pointsBounds(pts));
      const cache = new Map<ColorInput, number>();
      for (const p of pts) {
        if (p.color === undefined)
          throw invalidArg(
            `Point (${p.x},${p.y}) has no colour`,
            'Give each point a colour [x,y,color] or set "color" on the op',
          );
        let v = cache.get(p.color);
        if (v === undefined) {
          v = R.resolve(p.color);
          cache.set(p.color, v);
        }
        o.writer.plot(p.x, p.y, v);
      }
      return done(op, o);
    }
    case 'grid': {
      const grid = parseGrid(op.rows, { literalPipes: !!op.legend && '|' in op.legend });
      const o = open(ctx, op);
      const x0 = Math.round(op.x ?? 0);
      const y0 = Math.round(op.y ?? 0);
      const legend: Record<string, ColorInput> = {};
      for (const [rawKey, value] of Object.entries(op.legend ?? {})) {
        const k = stripVariationSelectors(rawKey);
        if (Array.from(k).length !== 1 || /\s/.test(k) || RESERVED_CHARS.has(k)) {
          throw invalidArg(
            `Invalid legend key '${rawKey}'`,
            'Legend keys are single characters (one code point; flags and joined emoji are several) other than whitespace, *, [, ] and ~',
          );
        }
        legend[k] = value;
      }
      const cache = new Map<string, number>();
      const valueOf = (ch: string): number => {
        let v = cache.get(ch);
        if (v !== undefined) return v;
        if (ch in legend) v = R.resolve(legend[ch]!);
        else {
          const di = defaultCharIndex(ch);
          if (di === undefined) {
            throw invalidArg(
              `Grid character '${ch}' is not in the legend`,
              `Add it to "legend" (e.g. {"${ch}": "#ff0000"}) or use default chars: . (transparent), 0-9, a-z, A-Z (no l/o/I/O) = palette indices`,
            );
          }
          v = R.resolve(di);
        }
        cache.set(ch, v);
        return v;
      };
      o.writer.prepare({ x: x0, y: y0, w: grid.width, h: grid.height });
      let outside = 0;
      const W = ctx.tx.state.width;
      const H = ctx.tx.state.height;
      grid.rows.forEach((row, gy) =>
        row.forEach((cell, gx) => {
          if (cell.kind === 'keep') return;
          const v = cell.kind === 'index' ? R.resolve(cell.index) : valueOf(cell.ch);
          if (op.mode === 'overlay' && v === 0) return;
          const x = x0 + gx;
          const y = y0 + gy;
          if (x < 0 || y < 0 || x >= W || y >= H) {
            outside++;
            return;
          }
          o.writer.plot(x, y, v);
        }),
      );
      if (outside)
        ctx.tx.warn(`grid: ${outside} pixel(s) fell outside the ${W}x${H} canvas and were dropped`);
      return done(op, o, `${grid.width}x${grid.height} grid at ${x0},${y0}`);
    }
    case 'line': {
      const o = open(ctx, op);
      const a = toPoint(op.from);
      const b = toPoint(op.to);
      const pts = strokeWithBrush(
        linePoints(a.x, a.y, b.x, b.y),
        op.width ?? 1,
        op.brush ?? 'circle',
        reachable(ctx),
      );
      plotAll(o, pts, R.resolve(op.color));
      return done(op, o);
    }
    case 'path': {
      const o = open(ctx, op);
      let pts = polylinePoints(op.points.map(toPoint), op.closed ?? false);
      const width = op.width ?? 1;
      if (width <= 1 && op.pixelPerfect !== false) pts = pixelPerfect(pts);
      pts = strokeWithBrush(pts, width, op.brush ?? 'circle', reachable(ctx));
      plotAll(o, pts, R.resolve(op.color));
      return done(op, o);
    }
    case 'rect':
    case 'ellipse':
    case 'circle': {
      if (op.color === undefined && op.fill === undefined)
        throw invalidArg(`${op.op} needs "color" (outline) and/or "fill"`);
      const o = open(ctx, op);
      const r: Rect =
        op.op === 'circle'
          ? circleRect(op.cx, op.cy, op.r)
          : { x: Math.round(op.x), y: Math.round(op.y), w: Math.round(op.w), h: Math.round(op.h) };
      if (r.w <= 0 || r.h <= 0) throw invalidArg(`${op.op} has empty size ${r.w}x${r.h}`);
      o.writer.prepare(r);
      const isRect = op.op === 'rect';
      if (op.fill !== undefined) {
        const v = R.resolve(op.fill);
        for (const p of isRect ? rectFillPoints(r, canvas) : ellipseFillPoints(r, canvas))
          o.writer.plot(p.x, p.y, v);
      }
      if (op.color !== undefined) {
        const v = R.resolve(op.color);
        const pts = isRect
          ? rectOutlinePoints(r, (op as { thickness?: number }).thickness ?? 1, canvas)
          : ellipseOutlinePoints(r, reachable(ctx));
        for (const p of pts) o.writer.plot(p.x, p.y, v);
      }
      return done(op, o);
    }
    case 'polygon': {
      if (op.color === undefined && op.fill === undefined)
        throw invalidArg('polygon needs "color" (outline) and/or "fill"');
      if (op.points.length < 2) throw invalidArg('polygon needs at least 2 points');
      const o = open(ctx, op);
      const verts = op.points.map(toPoint);
      if (op.fill !== undefined) plotAll(o, polygonFillPoints(verts, canvas), R.resolve(op.fill));
      if (op.color !== undefined) plotAll(o, polylinePoints(verts, true), R.resolve(op.color));
      return done(op, o);
    }
    case 'fill': {
      const o = open(ctx, op);
      const W = ctx.tx.state.width;
      const H = ctx.tx.state.height;
      if (op.x < 0 || op.y < 0 || op.x >= W || op.y >= H) {
        ctx.tx.warn(`fill seed (${op.x},${op.y}) is outside the ${W}x${H} canvas; nothing was filled`);
        return done(op, o, 'seed outside canvas');
      }
      const tol = op.tolerance ?? 0;
      let mask: Mask;
      if (op.reference === 'composite') {
        const raster = compositeFrame(ctx.doc, { frame: o.target.frame });
        mask = floodRegion(
          W,
          H,
          op.x,
          op.y,
          (x, y) => raster.get(x, y),
          (s, v, t) => channelDistance(s, v) <= t,
          op,
        );
      } else {
        const read = snapshotReader(ctx, o.target);
        const indexed = ctx.doc.state.colorMode === 'indexed';
        const cmp = (s: number, v: number, t: number) =>
          t === 0
            ? s === v
            : indexed
              ? channelDistance(R.rgba(s), R.rgba(v)) <= t
              : channelDistance(s, v) <= t;
        mask = floodRegion(W, H, op.x, op.y, read, cmp, {
          contiguous: op.contiguous,
          connectivity: op.connectivity,
          tolerance: tol,
        });
      }
      const v = R.resolve(op.color);
      o.writer.prepare(mask.bounds());
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) if (mask.data[y * W + x]) o.writer.plot(x, y, v);
      return done(op, o, `region ${mask.count()} px`);
    }
    case 'replace_color':
      return replaceColor(ctx, op);
    case 'gradient': {
      if (!op.colors.length) throw invalidArg('gradient needs at least one colour in "colors"');
      const o = open(ctx, op);
      const area = areaFor(ctx, op.area, o.clip);
      const stops = op.colors.map((c) => R.resolve(c));
      const a = toPoint(op.from);
      const b = toPoint(op.to);
      o.writer.prepare(area);
      for (let y = area.y; y < area.y + area.h; y++) {
        for (let x = area.x; x < area.x + area.w; x++) {
          o.writer.plot(
            x,
            y,
            pickStop(stops, gradientT(op.type ?? 'linear', a, b, x, y), op.dither ?? 'bayer4', x, y),
          );
        }
      }
      return done(op, o);
    }
    case 'pattern': {
      const rows = typeof op.pattern === 'string' ? PATTERNS[op.pattern as PatternName] : op.pattern;
      if (!rows)
        throw invalidArg(
          `Unknown pattern '${String(op.pattern)}'`,
          `Patterns: ${Object.keys(PATTERNS).join(', ')} or custom rows of 0/1`,
        );
      if (!op.colors.length) throw invalidArg('pattern needs colors: [onColor, offColor?]');
      const o = open(ctx, op);
      const area = areaFor(ctx, op.area, o.clip);
      const on = R.resolve(op.colors[0]!);
      const off = op.colors.length > 1 ? R.resolve(op.colors[1]!) : null;
      o.writer.prepare(area);
      const ox = op.offsetX ?? 0;
      const oy = op.offsetY ?? 0;
      for (let y = area.y; y < area.y + area.h; y++) {
        for (let x = area.x; x < area.x + area.w; x++) {
          if (patternHit(rows, x + ox, y + oy)) o.writer.plot(x, y, on);
          else if (off !== null) o.writer.plot(x, y, off);
        }
      }
      return done(op, o);
    }
    case 'outline': {
      const o = open(ctx, op);
      const { read, label } = sourceReader(ctx, o.target, op.source);
      const pts = outlinePixels(
        read,
        ctx.tx.state.width,
        ctx.tx.state.height,
        op.side ?? 'outside',
        op.connectivity ?? 4,
      );
      plotAll(o, pts, R.resolve(op.color));
      if (!pts.length)
        ctx.tx.warn(
          `outline found no shape in ${label}; draw the shape first or set source:"composite" / source:"<layer>"`,
        );
      return done(op, o, label === 'target layer' ? undefined : `traced ${label}`);
    }
    case 'selout': {
      const o = open(ctx, op);
      const { read } = sourceReader(ctx, o.target, op.source);
      const shifter = new RampShifter(R, rampsFor(ctx), ctx.doc.state.colorMode === 'indexed');
      const changes = seloutChanges(
        read,
        ctx.tx.state.width,
        ctx.tx.state.height,
        validLight(op.light) ?? ctx.doc.state.settings.lightDirection,
        shifter,
        {
          lightSteps: op.lightSteps,
          sideSteps: op.sideSteps,
        },
      );
      o.writer.prepare(pointsBounds(changes));
      for (const c of changes) o.writer.plot(c.x, c.y, c.value);
      return done(op, o);
    }
    case 'shade': {
      const o = open(ctx, op);
      const read = snapshotReader(ctx, o.target);
      const shifter = new RampShifter(R, rampsFor(ctx), ctx.doc.state.colorMode === 'indexed');
      const W = ctx.tx.state.width;
      const H = ctx.tx.state.height;
      const area = areaFor(ctx, op.area, o.clip);
      const inArea = (x: number, y: number) =>
        x >= area.x && y >= area.y && x < area.x + area.w && y < area.y + area.h;
      validLight(op.light);
      if ((op.mode ?? 'shift') === 'shift') {
        const amount = op.amount ?? -1;
        o.writer.prepare(area);
        for (let y = area.y; y < area.y + area.h; y++) {
          for (let x = area.x; x < area.x + area.w; x++) {
            const v = read(x, y);
            if (v !== 0) o.writer.plot(x, y, shifter.shift(v, amount, op.ramp));
          }
        }
        const defaulted =
          op.mode === undefined
            ? ' (mode defaulted to "shift"; use mode:"light" for directional shading)'
            : '';
        const whole = !op.area && !o.clip ? ' over the whole cel — pass area or clip to limit it' : '';
        return done(
          op,
          o,
          `shifted ${amount > 0 ? '+' : ''}${amount} step(s) along ramps${whole}${defaulted}`,
        );
      }
      const edgeValues = new Set<number>();
      const outline = ctx.doc.state.settings.outlineColor;
      if (op.outline !== undefined && op.outline !== 'auto' && op.outline !== 'none')
        edgeValues.add(R.resolve(op.outline));
      else if (outline !== null && op.outline !== 'none')
        edgeValues.add(ctx.doc.state.colorMode === 'indexed' ? outline : (R.palette[outline] ?? 0));
      else if (op.outline !== 'none') {
        const dom = dominantEdgeValue(read, W, H);
        if (dom !== null) edgeValues.add(dom);
      }
      const changes = lightShadeChanges(
        read,
        W,
        H,
        validLight(op.light) ?? ctx.doc.state.settings.lightDirection,
        shifter,
        {
          highlight: op.highlight,
          shadow: op.shadow,
          depth: op.depth ?? (Math.max(W, H) >= 32 ? 2 : 1),
          edgeValues,
          ramp: op.ramp,
        },
      ).filter((c) => inArea(c.x, c.y));
      o.writer.prepare(pointsBounds(changes));
      for (const c of changes) o.writer.plot(c.x, c.y, c.value);
      return done(op, o);
    }
    case 'erase': {
      // erasing always replaces (ink "inside" is equivalent); behind/blend would make it a no-op
      const o = open(ctx, op, op.ink === 'inside' ? 'inside' : 'replace');
      let pts: Point[];
      if (op.points) pts = op.points.map(toPoint);
      else if (op.area) pts = rectFillPoints(op.area, canvas);
      else if (o.clip) pts = rectFillPoints(o.clip.bounds() ?? { x: 0, y: 0, w: 0, h: 0 });
      else
        throw invalidArg('erase needs "area", "points" or "clip"', 'Use {op:"clear"} to empty the whole cel');
      plotAll(o, pts, 0);
      return done(op, o);
    }
    case 'clear': {
      const o = open(ctx, op, 'replace');
      const area = areaFor(ctx, undefined, o.clip);
      o.writer.prepare(area);
      for (let y = area.y; y < area.y + area.h; y++)
        for (let x = area.x; x < area.x + area.w; x++) o.writer.plot(x, y, 0);
      return done(op, o);
    }
    case 'copy':
      return copyOp(ctx, op);
    case 'paste': {
      const name = op.name ?? 'default';
      const clipb = ctx.doc.state.clipboards[name];
      if (!clipb)
        throw invalidArg(
          `Clipboard '${name}' is empty`,
          `Copy first with {op:"copy", name:"${name}"}. Clipboards: ${Object.keys(ctx.doc.state.clipboards).join(', ') || 'none'}`,
        );
      const src = ctx.doc.image(clipb.imageId).clone();
      const o = open(ctx, op);
      const x0 = Math.round(op.x ?? clipb.x);
      const y0 = Math.round(op.y ?? clipb.y);
      writeBuffer(o, src, x0, y0, op.mode ?? 'overlay', ctx);
      return done(op, o, `pasted ${src.width}x${src.height} at ${x0},${y0}`);
    }
    case 'stamp': {
      const o = open(ctx, op);
      const srcLayer = op.from.layer ? resolveImageLayer(ctx.doc, op.from.layer) : o.target.layer;
      const srcFrame = op.from.frame ?? o.target.frame;
      assertFrame(ctx.doc.state, srcFrame);
      const cel = getCel(ctx.doc.state, srcLayer.id, srcFrame);
      const area = intersectRect(op.from.area ?? canvasRect(ctx.tx), canvasRect(ctx.tx)) ?? {
        x: 0,
        y: 0,
        w: 0,
        h: 0,
      };
      let src = new PixelBuffer(area.w, area.h);
      if (cel)
        for (let y = 0; y < area.h; y++)
          for (let x = 0; x < area.w; x++)
            src.data[y * area.w + x] = readCel(ctx.tx, cel, area.x + x, area.y + y);
      if (op.flipX || op.flipY) src = flipBuffer(src, !!op.flipX, !!op.flipY);
      const x0 = Math.round(op.x ?? area.x + (op.dx ?? 0));
      const y0 = Math.round(op.y ?? area.y + (op.dy ?? 0));
      writeBuffer(o, src, x0, y0, op.mode ?? 'overlay', ctx);
      const empty = !src.data.some((v) => v !== 0);
      return done(
        op,
        o,
        `stamped ${srcLayer.name}@${srcFrame} ${area.w}x${area.h} → ${x0},${y0}${empty ? ' — the source area is empty (check from.layer/from.frame/from.area)' : ''}`,
      );
    }
    case 'text': {
      const font = FONTS[op.font ?? '5x7'];
      if (!font) throw invalidArg(`Unknown font '${op.font}'`, 'Fonts: 3x5, 5x7');
      const o = open(ctx, op);
      const v = R.resolve(op.color);
      const pts: Point[] = [];
      forEachTextPixel(
        font,
        op.text,
        Math.round(op.x),
        Math.round(op.y),
        (x, y) => pts.push({ x, y }),
        op.spacing ?? 1,
      );
      plotAll(o, pts, v);
      return done(op, o);
    }
    case 'adjust': {
      const o = open(ctx, op);
      const read = snapshotReader(ctx, o.target);
      const area = areaFor(ctx, op.area, o.clip);
      if (ctx.doc.state.colorMode === 'indexed') {
        ctx.tx.warn(
          'adjust in indexed mode snaps results to the nearest palette colours; to recolour the palette itself use palette {action:"adjust"}',
        );
      }
      o.writer.prepare(area);
      const cache = new Map<number, number>();
      for (let y = area.y; y < area.y + area.h; y++) {
        for (let x = area.x; x < area.x + area.w; x++) {
          const v = read(x, y);
          if (v === 0) continue;
          let nv = cache.get(v);
          if (nv === undefined) {
            nv = R.fromRgba(adjustColor(R.rgba(v), op));
            cache.set(v, nv);
          }
          o.writer.plot(x, y, nv);
        }
      }
      return done(op, o);
    }
    case 'quantize': {
      const o = open(ctx, op);
      if (ctx.doc.state.colorMode === 'indexed')
        return done(op, o, 'indexed sprites are always on-palette; nothing to do');
      const area = areaFor(ctx, op.area, o.clip);
      const read = snapshotReader(ctx, o.target);
      const px = new Uint32Array(area.w * area.h);
      for (let y = 0; y < area.h; y++)
        for (let x = 0; x < area.w; x++) px[y * area.w + x] = read(area.x + x, area.y + y);
      const idx = mapToPalette(px, area.w, area.h, R.palette, op.dither ?? 'none');
      o.writer.prepare(area);
      for (let y = 0; y < area.h; y++) {
        for (let x = 0; x < area.w; x++) {
          const i = y * area.w + x;
          if (px[i] === 0) continue;
          o.writer.plot(area.x + x, area.y + y, R.palette[idx[i]!] ?? 0);
        }
      }
      return done(op, o);
    }
    default: {
      const name = (op as { op: string }).op;
      throw invalidArg(`Unknown op '${name}'`);
    }
  }
}

/**
 * Detect an outline: the value covering ≥ 60% of silhouette-edge pixels that is rare inside the shape
 * (< 25% of interior pixels). Returns null for unoutlined sprites.
 */
