/**
 * File tools: export and import.
 */
import { z } from 'zod';
import { type FrameSpec } from '@pixelclaus/core';
import { MUTATES, type Registrar } from '../context.js';
import { type ExportRequest } from '../../services/export-service.js';
import { IMPORT_KINDS, type ImportRequest } from '../../services/import-service.js';
import { Reply, safe } from '../result.js';
import { int, projectRef } from '../schemas.js';
import { exportShape } from '../export-schema.js';

export const registerIoTools: Registrar = (server, ctx) => {
  server.registerTool(
    'export',
    {
      title: 'Export',
      description:
        'Write files (default: the project exports folder; outputDir to choose). formats: png | jpg (matte = background, default white) | webp (lossless) | gif (≤256 colours, 1-bit alpha, 10 ms steps) | apng | webp_animated | frames (PNG sequence) | spritesheet (+JSON atlas) | aseprite | pxc (native backup) | palette (paletteFormat hex|gpl|pal|act). ' +
        'Options: frame (stills), frames/tag/splitTags (animations), layers / splitLayers, scale 1-16 (integer), background, trim, loops, quality, sheet {layout: horizontal|vertical|grid|rows|packed, columns, padding, border, extrude, trim, mergeDuplicates, powerOfTwo, splitLayers, json: aseprite-hash|aseprite-array|texturepacker|none, filename}, paletteVariants [{name, palette: preset | colours}] (indexed: one export per skin). preview:true returns the first PNG.',
      inputSchema: { project: projectRef, ...exportShape },
      annotations: { ...MUTATES, openWorldHint: false },
    },
    safe(async (a) => {
      const { project, preview, ...req } = a;
      const res = await ctx.exporter.export(project, {
        ...req,
        frames: req.frames as FrameSpec | undefined,
      } as ExportRequest);
      const reply = new Reply().line(`exported ${res.files.length} file(s):`);
      for (const f of res.files)
        reply.line(
          `- ${f.path} (${f.bytes} bytes${f.width ? `, ${f.width}x${f.height}` : ''}${f.frames ? `, ${f.frames} frame(s)` : ''})`,
        );
      reply.warnings(res.warnings);
      if (preview && res.preview) reply.image(res.preview);
      return reply.build();
    }),
  );

  server.registerTool(
    'import',
    {
      title: 'Import',
      description:
        'Read a file (path, or base64 data + filename). kind auto-detects: image (png/jpg/webp/gif → new project, or a new layer when project is given; animated files become frames), spritesheet (needs frameWidth, frameHeight; optional count, marginX/Y, spacingX/Y, duration) , aseprite (.aseprite/.ase → new project), pxc, palette (.gpl/.pal/.act/.hex → replaces the project palette, or paletteMode append | replace-keep-indices). New indexed projects get an exact palette when the image has ≤ 255 colours, else a median-cut palette of maxColors (default 32).',
      inputSchema: {
        kind: z.enum(IMPORT_KINDS).optional(),
        path: z.string().optional(),
        data: z.string().optional().describe('Base64 (data: URL allowed)'),
        filename: z.string().optional(),
        project: projectRef.optional(),
        name: z.string().optional(),
        colorMode: z.enum(['indexed', 'rgba']).optional(),
        maxColors: int.min(2).max(255).optional(),
        layer: z.string().optional(),
        frame: int.min(0).optional(),
        x: int.optional(),
        y: int.optional(),
        asFrames: z.boolean().optional(),
        frameWidth: int.min(1).optional(),
        frameHeight: int.min(1).optional(),
        count: int.min(1).optional(),
        marginX: int.min(0).optional(),
        marginY: int.min(0).optional(),
        spacingX: int.min(0).optional(),
        spacingY: int.min(0).optional(),
        duration: int.min(1).optional(),
        paletteMode: z.enum(['replace', 'replace-keep-indices', 'append']).optional(),
      },
      annotations: MUTATES,
    },
    safe(async (a) => {
      const res = await ctx.importer.import(a as ImportRequest);
      return new Reply()
        .line(`${res.created ? 'created' : 'updated'} project ${res.project}: ${res.summary}`)
        .warnings(res.warnings)
        .build();
    }),
  );
};
