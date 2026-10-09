/**
 * Pixel tools: draw (batched ops), select, transform, palette.
 */
import { z } from 'zod';
import {
  addColors,
  addGeneratedRamp,
  adjustPalette,
  autoRamps,
  deleteSelection,
  draw,
  extractPalette,
  invalidArg,
  listSelections,
  loadPreset,
  modifySelection,
  paletteReport,
  PRESETS,
  remapPixels,
  removeColors,
  renameSelection,
  select,
  setColors,
  setPalette,
  setRamps,
  sortPalette,
  transform,
  type DrawOp,
  type FrameSpec,
  type OpResult,
  type RenderRequest,
  type SelectionShape,
  type SpriteDocument,
  type TransformOp,
  type ViewMode,
} from '@pixelclaus/core';
import { docPayload } from '../../compute/snapshot.js';
import { MUTATES, type Registrar } from '../context.js';
import { Reply, rect, safe } from '../result.js';
import { drawOp, frameSpec, ink, int, layerRef, point, projectRef, symmetry } from '../schemas.js';

function need<T>(v: T | undefined, name: string, action: string): T {
  if (v === undefined || v === null) throw invalidArg(`action "${action}" needs "${name}"`);
  return v;
}

/** Preview request for the area a draw call changed (zoomed to the dirty rect on big canvases). */
function previewRequest(
  doc: SpriteDocument,
  frame: number,
  view: ViewMode,
  dirty: { x: number; y: number; w: number; h: number } | null,
): RenderRequest {
  const W = doc.state.width;
  const H = doc.state.height;
  let region: { x: number; y: number; w: number; h: number } | undefined;
  if (dirty && Math.max(W, H) > 64) {
    const pad = 4;
    const x0 = Math.max(0, dirty.x - pad);
    const y0 = Math.max(0, dirty.y - pad);
    region = {
      x: x0,
      y: y0,
      w: Math.min(W, dirty.x + dirty.w + pad) - x0,
      h: Math.min(H, dirty.y + dirty.h + pad) - y0,
    };
  }
  return { view, frame, region, maxSize: 512 };
}

/** Frame to preview: the frame of the last op that changed pixels (ops may override frame). */
function previewFrame(results: OpResult[], fallback: number): number {
  for (let i = results.length - 1; i >= 0; i--) {
    const x = results[i]!;
    if (x.written > 0 && x.frame !== undefined) return x.frame;
  }
  return results.at(-1)?.frame ?? fallback;
}

const PER_OP_LIMIT = 40;
const NOTE_LIMIT = 15;

/** Per-op report lines; large batches are grouped so the reply stays small. */
function opLines(results: OpResult[]): string[] {
  const one = (x: OpResult, i: number) =>
    `- [${i}] ${x.op}${x.layer ? ` ${x.layer}@${x.frame}` : ''}: ${x.written} px${x.clipped ? ` (${x.clipped} clipped)` : ''}${x.note ? ` — ${x.note}` : ''}`;
  if (results.length <= 1 && !results.some((x) => x.note || x.clipped)) return [];
  if (results.length <= PER_OP_LIMIT) return results.map(one);
  const groups = new Map<string, { n: number; px: number; clipped: number }>();
  for (const x of results) {
    const k = `${x.op}${x.layer ? ` ${x.layer}@${x.frame}` : ''}`;
    const g = groups.get(k) ?? { n: 0, px: 0, clipped: 0 };
    g.n++;
    g.px += x.written;
    g.clipped += x.clipped ?? 0;
    groups.set(k, g);
  }
  const out = [...groups].map(
    ([k, g]) => `- ${k} ×${g.n}: ${g.px} px${g.clipped ? ` (${g.clipped} clipped)` : ''}`,
  );
  const notable = results.map((x, i) => [x, i] as const).filter(([x]) => x.note || x.clipped);
  for (const [x, i] of notable.slice(0, NOTE_LIMIT)) out.push(one(x, i));
  if (notable.length > NOTE_LIMIT) out.push(`- … ${notable.length - NOTE_LIMIT} more op(s) with notes`);
  const idle = results.filter((x) => x.written === 0).length;
  if (idle) out.push(`- ${idle} op(s) changed no pixels`);
  return out;
}

export const registerPixelTools: Registrar = (server, ctx) => {
  server.registerTool(
    'draw',
    {
      title: 'Draw (batched ops)',
      description:
        'Apply a list of drawing ops to a layer/frame as ONE undoable, atomic step (any failing op rolls back the whole call; errors name the op index). ' +
        'Ops: pixels, grid (ASCII, see guide ascii), line, path, rect, ellipse, circle, polygon, fill, replace_color, gradient, pattern, outline, selout, shade, erase, clear, copy, paste, stamp, text, adjust, quantize (see guide ops). ' +
        'Coordinates are canvas pixels, 0-indexed, top-left origin; rect/ellipse/area use {x,y,w,h}; points are [x,y]; line endpoints are inclusive. ' +
        'Colours: palette index (0 = transparent), "#rrggbb[aa]", "transparent", a palette colour name, or "ramp:<name>:<step>". ' +
        'Every op may override layer, frame, ink (replace|behind|inside|blend) and clip (selection name). ' +
        'layer may be omitted only when the sprite has one non-background image layer. Set preview:true (or a view name) to get a PNG of the result in the same call.',
      inputSchema: {
        project: projectRef,
        layer: layerRef.optional(),
        frame: int.min(0).optional().describe('Default 0'),
        ops: z.array(drawOp).min(1).max(2000),
        symmetry: symmetry.optional(),
        ink: ink.optional(),
        clip: z.string().optional().describe('Named selection restricting every op'),
        preview: z.union([z.boolean(), z.enum(['composite', 'indexed', 'value', 'silhouette'])]).optional(),
      },
      annotations: MUTATES,
    },
    safe(async (a) => {
      const res = await ctx.projects.mutate(a.project, (doc) => {
        const r = draw(doc, {
          layer: a.layer,
          frame: a.frame,
          ops: a.ops as DrawOp[],
          symmetry: a.symmetry,
          ink: a.ink,
          clip: a.clip,
        });
        // copy the frame to preview while still inside the mutation (consistent), render it after
        if (!a.preview) return { r };
        const frame = previewFrame(r.results, a.frame ?? 0);
        const req = previewRequest(doc, frame, a.preview === true ? 'composite' : a.preview, r.dirty);
        return { r, preview: { req, ...docPayload(doc, { frames: [frame] }) } };
      });
      const { r, preview } = res.value;
      const png = preview
        ? (
            await ctx.compute.run(
              { kind: 'render', doc: preview.payload, req: preview.req },
              preview.transfer,
            )
          ).png
        : undefined;
      const reply = new Reply().line(
        `ok · ${r.results.length} op(s) · ${r.written} px changed · dirty ${rect(r.dirty)} · rev ${res.revision}`,
      );
      for (const l of opLines(r.results)) reply.line(l);
      reply.warnings(res.warnings);
      if (png) reply.image(png);
      return reply.build();
    }),
  );

  server.registerTool(
    'select',
    {
      title: 'Selections',
      description:
        'Named selection masks (default name "active") used by draw/transform "clip"/"selection". Shapes: rect {x,y,w,h} · ellipse {x,y,w,h} · polygon {points} · wand {x,y, layer?, tolerance?, contiguous?, connectivity?} (without layer it samples the composite) · color {color, layer?} · alpha {layer?} (opaque pixels) · all · none. ' +
        'mode: replace|add|subtract|intersect. Modifiers: invert, grow {amount}, shrink {amount}, border {amount}, move {dx,dy}, combine {other, mode}. Also list, delete, rename {newName}.',
      inputSchema: {
        project: projectRef,
        action: z.enum([
          'rect',
          'ellipse',
          'polygon',
          'wand',
          'color',
          'alpha',
          'all',
          'none',
          'invert',
          'grow',
          'shrink',
          'border',
          'move',
          'combine',
          'list',
          'delete',
          'rename',
        ]),
        name: z.string().optional(),
        mode: z.enum(['replace', 'add', 'subtract', 'intersect']).optional(),
        x: int.optional(),
        y: int.optional(),
        w: int.positive().optional(),
        h: int.positive().optional(),
        points: z.array(point).optional(),
        layer: layerRef.optional(),
        frame: int.min(0).optional(),
        tolerance: z.number().min(0).max(255).optional(),
        contiguous: z.boolean().optional(),
        connectivity: z.union([z.literal(4), z.literal(8)]).optional(),
        color: z.union([int, z.string()]).optional(),
        amount: int.min(1).optional(),
        dx: int.optional(),
        dy: int.optional(),
        other: z.string().optional(),
        newName: z.string().optional(),
      },
      annotations: MUTATES,
    },
    safe(async (a) => {
      if (a.action === 'list') {
        const r = await ctx.projects.read(a.project, (doc) => listSelections(doc));
        return new Reply()
          .line(
            r.value.length
              ? r.value.map((s) => `- ${s.name}: ${s.pixels} px, bounds ${rect(s.bounds)}`).join('\n')
              : 'no selections',
          )
          .build();
      }
      const name = a.name ?? 'active';
      const res = await ctx.projects.mutate(a.project, (doc) => {
        switch (a.action) {
          case 'delete':
            deleteSelection(doc, name);
            return `deleted selection ${name}`;
          case 'rename':
            renameSelection(doc, name, need(a.newName, 'newName', a.action));
            return `renamed ${name} → ${a.newName}`;
          case 'invert':
          case 'grow':
          case 'shrink':
          case 'border':
          case 'move':
          case 'combine': {
            const m =
              a.action === 'invert'
                ? modifySelection(doc, name, { action: 'invert' })
                : a.action === 'move'
                  ? modifySelection(doc, name, { action: 'move', dx: a.dx ?? 0, dy: a.dy ?? 0 })
                  : a.action === 'combine'
                    ? modifySelection(doc, name, {
                        action: 'combine',
                        other: need(a.other, 'other', a.action),
                        mode: a.mode ?? 'add',
                      })
                    : modifySelection(doc, name, {
                        action: a.action,
                        amount: a.amount ?? 1,
                        connectivity: a.connectivity,
                      });
            return `selection ${m.name}: ${m.pixels} px, bounds ${rect(m.bounds)}`;
          }
          default: {
            let shape: SelectionShape;
            switch (a.action) {
              case 'rect':
              case 'ellipse':
                shape = {
                  shape: a.action,
                  x: need(a.x, 'x', a.action),
                  y: need(a.y, 'y', a.action),
                  w: need(a.w, 'w', a.action),
                  h: need(a.h, 'h', a.action),
                };
                break;
              case 'polygon':
                shape = { shape: 'polygon', points: need(a.points, 'points', a.action) };
                break;
              case 'wand':
                shape = {
                  shape: 'wand',
                  x: need(a.x, 'x', a.action),
                  y: need(a.y, 'y', a.action),
                  layer: a.layer,
                  frame: a.frame,
                  tolerance: a.tolerance,
                  contiguous: a.contiguous,
                  connectivity: a.connectivity,
                };
                break;
              case 'color':
                shape = {
                  shape: 'color',
                  color: need(a.color, 'color', a.action),
                  layer: a.layer,
                  frame: a.frame,
                  tolerance: a.tolerance,
                };
                break;
              case 'alpha':
                shape = { shape: 'alpha', layer: a.layer, frame: a.frame };
                break;
              case 'all':
                shape = { shape: 'all' };
                break;
              default:
                shape = { shape: 'none' };
            }
            const m = select(doc, { ...shape, name, mode: a.mode });
            return `selection ${m.name}: ${m.pixels} px, bounds ${rect(m.bounds)}`;
          }
        }
      });
      return new Reply().line(`${res.value} · rev ${res.revision}`).warnings(res.warnings).build();
    }),
  );

  server.registerTool(
    'transform',
    {
      title: 'Transform',
      description:
        'Flip / rotate / scale / offset pixels. scope: cel (layer + frames), layer (all frames), sprite (everything; rotating a non-square sprite by 90° swaps width/height), selection (contents of a named selection on layer+frames, the mask moves too). ' +
        'op: flip_h | flip_v | rotate {angle, method?: rotsprite (default for non-90° angles, clean edges) | nearest, pivot?} | scale {factor | sx,sy, method?: nearest|scale2x|scale3x} (content scaled about the centre, canvas unchanged) | offset {dx, dy, wrap?} (wrap defaults to true for layer/sprite scope — seamless-tile checks — and false for cel/selection scope, which simply moves pixels).',
      inputSchema: {
        project: projectRef,
        scope: z.enum(['cel', 'layer', 'sprite', 'selection']),
        layer: layerRef.optional(),
        frames: frameSpec.optional(),
        selection: z.string().optional(),
        op: z.enum(['flip_h', 'flip_v', 'rotate', 'scale', 'offset']),
        angle: z.number().optional(),
        method: z.enum(['nearest', 'rotsprite', 'scale2x', 'scale3x']).optional(),
        pivot: point.optional(),
        factor: z.number().positive().optional(),
        sx: z.number().positive().optional(),
        sy: z.number().positive().optional(),
        dx: int.optional(),
        dy: int.optional(),
        wrap: z.boolean().optional(),
      },
      annotations: MUTATES,
    },
    safe(async (a) => {
      let t: TransformOp;
      switch (a.op) {
        case 'rotate': {
          const pv = a.pivot
            ? Array.isArray(a.pivot)
              ? { x: a.pivot[0], y: a.pivot[1] }
              : (a.pivot as { x: number; y: number })
            : undefined;
          t = {
            op: 'rotate',
            angle: need(a.angle, 'angle', 'rotate'),
            method: a.method === 'nearest' ? 'nearest' : 'rotsprite',
            pivot: pv,
          };
          break;
        }
        case 'scale':
          t = {
            op: 'scale',
            factor: a.factor,
            sx: a.sx,
            sy: a.sy,
            method: a.method === 'scale2x' || a.method === 'scale3x' ? a.method : 'nearest',
          };
          break;
        case 'offset':
          t = { op: 'offset', dx: a.dx ?? 0, dy: a.dy ?? 0, wrap: a.wrap };
          break;
        default:
          t = { op: a.op };
      }
      const res = await ctx.projects.mutate(a.project, (doc) =>
        transform(doc, {
          scope: a.scope,
          layer: a.layer,
          frames: a.frames as FrameSpec | undefined,
          selection: a.selection,
          transform: t,
        }),
      );
      const v = res.value;
      return new Reply()
        .line(
          `${a.op} applied to ${v.images} image(s)${v.canvas ? ` · canvas now ${v.canvas.width}x${v.canvas.height}` : ''}${v.note ? ` · ${v.note}` : ''} · rev ${res.revision}`,
        )
        .warnings(res.warnings)
        .build();
    }),
  );

  server.registerTool(
    'palette',
    {
      title: 'Palette',
      description:
        'Palette & ramps (index 0 is reserved transparent). get (colours, names, usage, ramps, near-duplicates) · presets · load_preset {name, strategy: nearest (re-match pixels) | index (keep indices = palette swap)} · set {colors[], strategy?} · set_colors {entries:[{index,color,name?}]} (indexed: recolours all pixels using them) · add {colors[], names?} · remove {indices[], replacement?} · sort {by: lightness|hue|chroma|ramps} (image unchanged) · remap {mapping:{old:new}} · generate_ramp {base, steps?, name?, to? (end colour), shadowSteps?, hueShiftShadow?, hueShiftHighlight?, add? (default true)} · set_ramps {ramps:[{name, indices dark→light}]} · auto_ramps · adjust {hue°, saturation, lightness, brightness, contrast, invert, desaturate, indices?} · extract {max?} (build palette from used colours).',
      inputSchema: {
        project: projectRef,
        action: z.enum([
          'get',
          'presets',
          'load_preset',
          'set',
          'set_colors',
          'add',
          'remove',
          'sort',
          'remap',
          'generate_ramp',
          'set_ramps',
          'auto_ramps',
          'adjust',
          'extract',
        ]),
        name: z.string().optional(),
        strategy: z.enum(['nearest', 'index']).optional(),
        colors: z.array(z.string()).optional(),
        names: z.array(z.string()).optional(),
        entries: z.array(z.object({ index: int, color: z.string(), name: z.string().optional() })).optional(),
        indices: z.array(int).optional(),
        replacement: int.optional(),
        by: z.enum(['lightness', 'hue', 'chroma', 'ramps']).optional(),
        mapping: z.record(z.string(), int).optional(),
        base: z.string().optional(),
        to: z.string().optional(),
        steps: int.min(2).max(16).optional(),
        shadowSteps: int.min(0).optional(),
        hueShiftShadow: z.number().optional(),
        hueShiftHighlight: z.number().optional(),
        shadowHue: z
          .number()
          .min(0)
          .max(360)
          .optional()
          .describe('Hue shadows rotate toward (default 260 = blue-purple; ~20 for skin/gold)'),
        highlightHue: z
          .number()
          .min(0)
          .max(360)
          .optional()
          .describe('Hue highlights rotate toward (default 70 = warm yellow)'),
        add: z.boolean().optional(),
        ramps: z.array(z.object({ name: z.string(), indices: z.array(int) })).optional(),
        hue: z.number().optional(),
        saturation: z.number().optional(),
        lightness: z.number().optional(),
        brightness: z.number().optional(),
        contrast: z.number().optional(),
        invert: z.boolean().optional(),
        desaturate: z.boolean().optional(),
        max: int.min(1).max(255).optional(),
      },
      annotations: MUTATES,
    },
    safe(async (a) => {
      if (a.action === 'presets') {
        return new Reply()
          .lines_(PRESETS.map((p) => `- ${p.name} (${p.colors.length}): ${p.description}`))
          .build();
      }
      if (a.action === 'get') {
        const r = await ctx.projects.read(a.project, (doc) => paletteReport(doc));
        const p = r.value;
        const reply = new Reply().line(`palette "${p.name}": ${p.size} colours (+ index 0 transparent)`);
        reply.line(
          p.entries
            .map((e) => `${e.index}=${e.hex}${e.name ? `(${e.name})` : ''}${e.used ? `×${e.used}` : ''}`)
            .join(' '),
        );
        if (p.ramps.length)
          reply.line(`ramps: ${p.ramps.map((x) => `${x.name}[${x.indices.join(',')}]`).join(' ')}`);
        if (p.unused.length) reply.line(`unused: ${p.unused.join(',')}`);
        if (p.nearDuplicates.length)
          reply.line(`near-duplicates: ${p.nearDuplicates.map(([i, j]) => `${i}≈${j}`).join(' ')}`);
        return reply.build();
      }
      const res = await ctx.projects.mutate(a.project, (doc) => {
        switch (a.action) {
          case 'load_preset':
            return `loaded ${need(a.name, 'name', a.action)}; ${loadPreset(doc, a.name!, a.strategy ?? 'nearest')} pixel(s) remapped`;
          case 'set':
            return `palette set (${need(a.colors, 'colors', a.action).length} colours); ${setPalette(doc, a.colors!, { name: a.name, strategy: a.strategy ?? 'nearest' })} pixel(s) remapped`;
          case 'set_colors':
            setColors(doc, need(a.entries, 'entries', a.action));
            return `updated ${a.entries!.length} colour(s)`;
          case 'add':
            return `added at indices ${addColors(doc, need(a.colors, 'colors', a.action), a.names).join(',')}`;
          case 'remove':
            return `removed ${need(a.indices, 'indices', a.action).length} colour(s); ${removeColors(doc, a.indices!, a.replacement)} pixel(s) remapped (indices above shifted down)`;
          case 'sort':
            sortPalette(doc, a.by ?? 'lightness');
            return `sorted by ${a.by ?? 'lightness'} (pixels remapped)`;
          case 'remap':
            return `remapped ${remapPixels(doc, Object.fromEntries(Object.entries(need(a.mapping, 'mapping', a.action)).map(([k, v]) => [Number(k), v])))} pixel(s)`;
          case 'generate_ramp': {
            const r = addGeneratedRamp(doc, need(a.base, 'base', a.action), {
              steps: a.steps,
              shadowSteps: a.shadowSteps,
              hueShiftShadow: a.hueShiftShadow,
              hueShiftHighlight: a.hueShiftHighlight,
              shadowHue: a.shadowHue,
              highlightHue: a.highlightHue,
              name: a.name,
              add: a.add,
              to: a.to,
            });
            return `ramp ${r.colors.join(' ')}${r.indices.length ? ` → indices ${r.indices.join(',')}` : ' (not added)'}`;
          }
          case 'set_ramps':
            setRamps(doc, need(a.ramps, 'ramps', a.action));
            return `set ${a.ramps!.length} ramp(s)`;
          case 'auto_ramps':
            return `ramps: ${autoRamps(doc)
              .map((r) => `${r.name}[${r.indices.join(',')}]`)
              .join(' ')}`;
          case 'adjust':
            adjustPalette(
              doc,
              {
                hue: a.hue,
                saturation: a.saturation,
                lightness: a.lightness,
                brightness: a.brightness,
                contrast: a.contrast,
                invert: a.invert,
                desaturate: a.desaturate,
              },
              a.indices,
            );
            return `adjusted ${a.indices?.length ?? doc.state.palette.colors.length - 1} colour(s)`;
          case 'extract': {
            const changed = extractPalette(doc, a.max ?? 32);
            return `extracted palette (${doc.state.palette.colors.length - 1} colours); ${changed} pixel(s) remapped`;
          }
        }
        return '';
      });
      return new Reply().line(`${res.value} · rev ${res.revision}`).warnings(res.warnings).build();
    }),
  );
};
