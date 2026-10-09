/**
 * Shared zod schemas for tool inputs. Descriptions are written for the agent and repeat the coordinate
 * conventions where mistakes are likely.
 */
import { z } from 'zod';
import {
  BLEND_MODES,
  LIGHT_DIRECTIONS,
  PATTERNS,
  TAG_DIRECTIONS,
  ANCHORS,
  VIEW_MODES,
  LINT_RULES,
} from '@pixelclaus/core';

/**
 * Whole numbers (pixels, frames, counts, indices). Validated with a refinement and published as plain
 * `{"type":"integer"}` — `.int()` would add ±2^53 bounds to every field of the tool schema.
 */
export const int = z
  .number()
  .refine(Number.isInteger, {
    message: 'expected a whole number (pixel coordinates, sizes, frames and counts are integers)',
  })
  .meta({ type: 'integer' });

export const projectRef = z.string().min(1).describe('Project id or name');
export const layerRef = z.string().min(1).describe('Layer id (e.g. "L3") or unique name');
export const color = z
  .union([int, z.string()])
  .describe(
    'Palette index (0 = transparent), "#rrggbb[aa]", "transparent", palette colour name, or "ramp:<name>:<step>"',
  );
export const point = z
  .union([z.tuple([int, int]), z.object({ x: int, y: int })])
  .describe('[x, y] (0-indexed, origin top-left)');
export const rectSchema = z
  .object({ x: int, y: int, w: int.positive(), h: int.positive() })
  .describe('{x, y, w, h}: covers x..x+w-1, y..y+h-1');
export const frameSpec = z
  .union([
    int.min(0),
    z.array(int.min(0)),
    z.object({ from: int.min(0), to: int.min(0) }),
    z.object({ tag: z.string() }),
    z.literal('all'),
  ])
  .describe('Frame index, list, {from,to} (inclusive), {tag}, or "all". Frames are 0-indexed');
export const blendMode = z.enum(BLEND_MODES);
export const lightDirection = z.enum(LIGHT_DIRECTIONS as unknown as [string, ...string[]]);
export const tagDirection = z.enum(TAG_DIRECTIONS as unknown as [string, ...string[]]);
export const anchor = z.enum(ANCHORS as unknown as [string, ...string[]]);
export const viewMode = z.enum(VIEW_MODES);
export const lintRule = z.enum(LINT_RULES);
export const ink = z
  .enum(['replace', 'behind', 'inside', 'blend'])
  .describe(
    'replace (default) | behind: only empty pixels | inside: only non-empty pixels (alpha lock) | blend: alpha-composite (RGBA)',
  );

/** Compact per-op schemas: shared fields are documented once in the draw tool description. */
const c = z.union([int, z.string()]);
const pt = z.union([z.tuple([int, int]), z.object({ x: int, y: int })]);
const area = z.object({ x: int, y: int, w: int.positive(), h: int.positive() });
const lightDir = z.enum(LIGHT_DIRECTIONS as unknown as [string, ...string[]]);
const src = z
  .string()
  .optional()
  .describe('Shape to trace: "layer" (default, this cel), "composite" (flattened image) or a layer name/id');
const common = {
  layer: z.string().optional(),
  frame: int.min(0).optional(),
  ink: z.enum(['replace', 'behind', 'inside', 'blend']).optional(),
  clip: z.string().optional(),
};

const rectFields = {
  x: int,
  y: int,
  w: int.positive(),
  h: int.positive(),
};

const pixelPoint = z.union([
  z.tuple([int, int]),
  z.tuple([int, int, c]),
  z.object({ x: int, y: int, color: c.optional() }),
]);

export const drawOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('pixels'),
    points: z.array(pixelPoint).min(1).describe('[x,y] or [x,y,color]'),
    color: c.optional().describe('Default colour'),
    ...common,
  }),
  z.object({
    op: z.literal('grid'),
    x: int.optional().describe('Top-left of the grid on the canvas (default 0)'),
    y: int.optional(),
    rows: z
      .union([z.array(z.string()), z.string()])
      .describe(
        'ASCII rows, one char per pixel. "." transparent, "~" keep, 0-9a-z… palette index, c*n repeat, [n] index ≥58',
      ),
    legend: z
      .record(z.string(), c)
      .optional()
      .describe('char → colour, overrides the default index alphabet'),
    mode: z
      .enum(['replace', 'overlay'])
      .optional()
      .describe('replace (default): "." erases; overlay: "." leaves pixels unchanged'),
    ...common,
  }),
  z.object({
    op: z.literal('line'),
    from: pt,
    to: pt,
    color: c,
    width: int.min(1).max(32).optional(),
    brush: z.enum(['square', 'circle']).optional(),
    ...common,
  }),
  z.object({
    op: z.literal('path'),
    points: z.array(pt).min(1),
    color: c,
    closed: z.boolean().optional(),
    pixelPerfect: z.boolean().optional().describe('Remove L-shaped doubles (default true for width 1)'),
    width: int.min(1).max(32).optional(),
    brush: z.enum(['square', 'circle']).optional(),
    ...common,
  }),
  z.object({
    op: z.literal('rect'),
    ...rectFields,
    color: c.optional().describe('Outline colour'),
    fill: c.optional(),
    thickness: int.min(1).optional(),
    ...common,
  }),
  z
    .object({
      op: z.literal('ellipse'),
      ...rectFields,
      color: c.optional().describe('Outline colour'),
      fill: c.optional(),
      ...common,
    })
    .describe('Ellipse inscribed in the {x,y,w,h} box'),
  z.object({
    op: z.literal('circle'),
    cx: z.number(),
    cy: z.number(),
    r: z.number().min(0),
    color: c.optional(),
    fill: c.optional(),
    ...common,
  }),
  z.object({
    op: z.literal('polygon'),
    points: z.array(pt).min(2),
    color: c.optional(),
    fill: c.optional(),
    ...common,
  }),
  z.object({
    op: z.literal('fill'),
    x: int,
    y: int,
    color: c,
    contiguous: z.boolean().optional().describe('false = replace every matching pixel'),
    tolerance: z.number().min(0).max(255).optional(),
    connectivity: z.union([z.literal(4), z.literal(8)]).optional(),
    reference: z
      .enum(['layer', 'composite'])
      .optional()
      .describe('composite = find the region on the flattened image (fill under line art on another layer)'),
    ...common,
  }),
  z.object({
    op: z.literal('replace_color'),
    from: c,
    to: c,
    scope: z.enum(['cel', 'layer', 'frame', 'sprite']).optional(),
    tolerance: z.number().min(0).max(255).optional(),
    ...common,
  }),
  z.object({
    op: z.literal('gradient'),
    from: pt,
    to: pt,
    colors: z.array(c).min(1).describe('Stops, e.g. a ramp dark→light'),
    type: z.enum(['linear', 'radial']).optional(),
    dither: z.enum(['none', 'bayer2', 'bayer4', 'bayer8', 'checker']).optional().describe('Default bayer4'),
    area: area.optional().describe('Default: clip bounds or whole canvas'),
    ...common,
  }),
  z.object({
    op: z.literal('pattern'),
    pattern: z
      .union([z.enum(Object.keys(PATTERNS) as [string, ...string[]]), z.array(z.string())])
      .describe('Preset name or rows of 0/1'),
    colors: z.array(c).min(1).max(2).describe('[on, off?]'),
    area: area.optional(),
    offsetX: int.optional(),
    offsetY: int.optional(),
    ...common,
  }),
  z
    .object({
      op: z.literal('outline'),
      color: c,
      side: z.enum(['outside', 'inside']).optional(),
      connectivity: z
        .union([z.literal(4), z.literal(8)])
        .optional()
        .describe('4 (default) = no diagonal corners'),
      source: src,
      ...common,
    })
    .describe('outside (default) grows the shape by 1 px; inside recolours its edge pixels (size unchanged)'),
  z
    .object({
      op: z.literal('selout'),
      light: lightDir.optional().describe('Default: sprite settings.lightDirection'),
      lightSteps: int.optional(),
      sideSteps: int.optional(),
      source: src,
      ...common,
    })
    .describe('Recolour existing outline pixels from the colour they enclose (draw the outline first)'),
  z.object({
    op: z.literal('shade'),
    mode: z
      .enum(['shift', 'light'])
      .optional()
      .describe(
        'shift (default): move pixels N ramp steps; light: highlight light-facing edges, shadow the far side',
      ),
    amount: int.optional().describe('shift: steps (default −1 = one step darker; +1 lighter)'),
    light: lightDir.optional().describe('light: default sprite settings.lightDirection'),
    depth: int.min(1).max(8).optional().describe('light: shadow thickness'),
    highlight: int.optional(),
    shadow: int.optional(),
    area: area.optional(),
    ramp: z.string().optional().describe('Only use this ramp'),
    outline: z
      .union([c, z.literal('auto'), z.literal('none')])
      .optional()
      .describe('light: outline colour to leave alone (default auto-detect)'),
    ...common,
  }),
  z.object({ op: z.literal('erase'), area: area.optional(), points: z.array(pt).optional(), ...common }),
  z.object({ op: z.literal('clear'), ...common }).describe('Empty the whole cel (or the clip)'),
  z.object({
    op: z.literal('copy'),
    name: z.string().optional(),
    area: area.optional(),
    source: z.enum(['layer', 'composite']).optional(),
    ...common,
  }),
  z.object({
    op: z.literal('paste'),
    name: z.string().optional(),
    x: int.optional(),
    y: int.optional(),
    mode: z.enum(['overlay', 'replace']).optional(),
    ...common,
  }),
  z.object({
    op: z.literal('stamp'),
    from: z
      .object({ layer: z.string().optional(), frame: int.min(0).optional(), area: area.optional() })
      .describe('Source cel region (defaults: same layer/frame, whole canvas)'),
    x: int.optional(),
    y: int.optional(),
    dx: int.optional().describe('Relative shift when x/y omitted'),
    dy: int.optional(),
    mode: z.enum(['overlay', 'replace']).optional(),
    flipX: z.boolean().optional(),
    flipY: z.boolean().optional(),
    ...common,
  }),
  z.object({
    op: z.literal('text'),
    x: int,
    y: int,
    text: z.string(),
    color: c,
    font: z.enum(['3x5', '5x7']).optional(),
    spacing: int.optional(),
    ...common,
  }),
  z.object({
    op: z.literal('adjust'),
    hue: z.number().optional(),
    saturation: z.number().optional(),
    lightness: z.number().optional(),
    brightness: z.number().optional(),
    contrast: z.number().optional(),
    invert: z.boolean().optional(),
    desaturate: z.boolean().optional(),
    area: area.optional(),
    ...common,
  }),
  z
    .object({
      op: z.literal('quantize'),
      dither: z.enum(['none', 'bayer2', 'bayer4', 'bayer8', 'floyd-steinberg']).optional(),
      area: area.optional(),
      ...common,
    })
    .describe('RGBA: snap pixels to the palette'),
]);

export const symmetry = z
  .object({
    x: z.union([z.number(), z.literal(true)]).optional(),
    y: z.union([z.number(), z.literal(true)]).optional(),
  })
  .describe('Mirror drawing: x = vertical mirror axis (true = centre), y = horizontal axis');
