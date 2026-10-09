/**
 * Export request schema shared by the MCP export tool and the REST download endpoint.
 */
import { z } from 'zod';
import { EXPORT_FORMATS } from '../services/export-service.js';
import { frameSpec, int } from './schemas.js';

export const exportShape = {
  format: z.enum(EXPORT_FORMATS),
  frame: int.min(0).optional(),
  frames: frameSpec.optional(),
  tag: z.string().optional(),
  splitTags: z.boolean().optional(),
  layers: z.array(z.string()).optional(),
  splitLayers: z.boolean().optional(),
  scale: int.min(1).max(16).optional(),
  background: z.string().optional(),
  quality: int.min(1).max(100).optional(),
  lossless: z.boolean().optional(),
  loops: int.min(0).max(65535).optional(),
  trim: z.boolean().optional(),
  sheet: z
    .object({
      layout: z.enum(['horizontal', 'vertical', 'grid', 'rows', 'packed']).optional(),
      columns: int.min(1).max(1024).optional(),
      padding: int.min(0).max(64).optional(),
      border: int.min(0).max(64).optional(),
      extrude: int.min(0).max(8).optional(),
      trim: z.boolean().optional(),
      mergeDuplicates: z.boolean().optional(),
      powerOfTwo: z.boolean().optional(),
      splitLayers: z.boolean().optional(),
      includeHidden: z.boolean().optional(),
      json: z.enum(['aseprite-hash', 'aseprite-array', 'texturepacker', 'none']).optional(),
      filename: z.string().optional(),
    })
    .optional(),
  paletteFormat: z.enum(['hex', 'gpl', 'pal', 'act']).optional(),
  paletteVariants: z
    .array(z.object({ name: z.string(), palette: z.union([z.string(), z.array(z.string())]) }))
    .optional(),
  outputDir: z.string().optional(),
  filename: z.string().optional().describe('Base name without extension'),
  preview: z.boolean().optional(),
};

export const exportRequestSchema = z.object(exportShape).strict();
