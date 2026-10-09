/**
 * Seeing tools: render (PNG views + numbers), read_pixels (exact ASCII), analyze (stats, colours, lint,
 * animation metrics, diff).
 */
import { z } from 'zod';
import { readPixels, type FrameSpec, type RenderRequest, type ViewMode } from '@pixelclaus/core';
import { docPayload } from '../../compute/snapshot.js';
import { framesForAnalyze, framesForRender } from '../../compute/tasks.js';
import { READ_ONLY, type Registrar } from '../context.js';
import { compactJson, Reply, rect, safe } from '../result.js';
import { frameSpec, int, layerRef, lintRule, projectRef, rectSchema, viewMode } from '../schemas.js';

export const registerViewTools: Registrar = (server, ctx) => {
  server.registerTool(
    'render',
    {
      title: 'Render a view (PNG)',
      description:
        'Returns a PNG plus numbers. Views: composite (default; checkerboard, pixel grid, 0-indexed rulers, 1x/2x insets, palette strip with indices) · indexed (palette index printed in every cell — best for exact edits) · value (lightness only: check contrast) · silhouette (readability) · onion {onion:{prev,next}} · diff {compareFrame} (added/removed/recoloured) · tile (3x3 repeat, seams) · filmstrip {tag|frames, baseline?} (all frames + ms) · trail (centroid motion path) · timing (duration bars) · contact (composite+silhouette+value) · palette. ' +
        'layers isolates layers; region zooms (rulers keep absolute coordinates). Images are ~512-768 px; trust read_pixels for exact positions.',
      inputSchema: {
        project: projectRef,
        view: viewMode.optional(),
        frame: int.min(0).optional(),
        frames: frameSpec.optional(),
        tag: z.string().optional(),
        layers: z.array(z.string()).optional(),
        includeHidden: z.boolean().optional(),
        scale: int.min(1).max(64).optional(),
        maxSize: int.min(64).max(1600).optional(),
        grid: z.boolean().optional(),
        rulers: z.boolean().optional(),
        inset: z.boolean().optional(),
        palette: z.boolean().optional().describe('Palette strip (default true)'),
        background: z.string().nullable().optional().describe('"#rrggbb" backdrop instead of checkerboard'),
        region: rectSchema.optional(),
        onion: z
          .object({ prev: int.min(0).max(4).optional(), next: int.min(0).max(4).optional() })
          .optional(),
        compareFrame: int.min(0).optional(),
        posterize: int.min(2).max(16).optional(),
        baseline: int.min(0).optional().describe('Row to draw as a ground line (filmstrip/trail)'),
        columns: int.min(1).max(32).optional(),
        tiles: int.min(2).max(5).optional(),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ project, ...args }) => {
      const req: RenderRequest = {
        ...args,
        view: args.view as ViewMode | undefined,
        frames: args.frames as FrameSpec | undefined,
      };
      // copy what the view needs, then render + encode on a compute worker
      const r = await ctx.projects.read(project, (doc) => docPayload(doc, { frames: framesForRender(req) }));
      const out = await ctx.compute.run({ kind: 'render', doc: r.value.payload, req }, r.value.transfer);
      const { frames: frameTable, ...rest } = out.info as { frames?: unknown[] } & Record<string, unknown>;
      const reply = new Reply().json(rest, `view (${out.width}x${out.height} px)`);
      if (Array.isArray(frameTable)) for (const f of frameTable) reply.line(compactJson(f));
      return reply.warnings(r.notices).image(out.png).build();
    }),
  );

  server.registerTool(
    'read_pixels',
    {
      title: 'Read pixels (ASCII)',
      description:
        'Exact pixel readback as an ASCII grid with column header, row numbers and legend (char → palette index / hex). Round-trips with draw op grid (paste rows back unchanged). layer omitted = flattened composite. Max 16384 cells per call — read big sprites in regions. format:"json" returns rows of palette indices (hex strings for off-palette colours) instead of the ASCII grid.',
      inputSchema: {
        project: projectRef,
        layer: layerRef.optional(),
        frame: int.min(0).optional(),
        region: rectSchema.optional(),
        format: z.enum(['ascii', 'json']).optional(),
        rle: int.min(2).optional().describe('Collapse runs ≥ N into c*n'),
      },
      annotations: READ_ONLY,
    },
    safe(async (a) => {
      const r = await ctx.projects.read(a.project, (doc) => readPixels(doc, a));
      const v = r.value;
      const reply = new Reply().line(
        `${v.source} · frame ${v.frame} · region ${rect(v.region)} · ${v.opaque} opaque px · ${v.colors} colour(s)`,
      );
      if (v.rows) {
        // json asked for: rows of palette indices only (the ASCII grid would double the reply)
        reply.json(v.rows, 'rows');
      } else {
        reply.line(
          `legend: ${Object.entries(v.legend)
            .map(([k, d]) => `'${k}' ${d}`)
            .join(' · ')}`,
        );
        reply.line(v.text);
      }
      return reply.warnings(r.notices).build();
    }),
  );

  server.registerTool(
    'analyze',
    {
      title: 'Analyze',
      description:
        'Numbers over pictures. kind: stats (layers, pixel counts, bounds, colour usage) · colors (palette usage, unused, near-duplicates, ramp lightness) · lint {rules?, frames?, tag?, layer?} (pixel-art mistakes with coordinates + hints) · animation {tag|frames, layers?} (per-frame bbox, centroid, bottom row, changed pixels, ms) · diff {frameA, frameB} (pixel change counts).',
      inputSchema: {
        project: projectRef,
        kind: z.enum(['stats', 'colors', 'lint', 'animation', 'diff']),
        rules: z.array(lintRule).optional(),
        frames: frameSpec.optional(),
        tag: z.string().optional(),
        layer: layerRef.optional(),
        layers: z.array(z.string()).optional(),
        frameA: int.min(0).optional(),
        frameB: int.min(0).optional(),
      },
      annotations: READ_ONLY,
    },
    safe(async ({ project, ...req }) => {
      const r = await ctx.projects.read(project, (doc) => docPayload(doc, { frames: framesForAnalyze(req) }));
      const out = await ctx.compute.run({ kind: 'analyze', doc: r.value.payload, req }, r.value.transfer);
      return new Reply().lines_(out.lines).warnings(r.notices).build();
    }),
  );
};
