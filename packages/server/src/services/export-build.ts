/**
 * Export builder: PNG/JPG/WebP stills, GIF/APNG/animated WebP, PNG sequences, sprite sheets + JSON,
 * .aseprite, .pxc, palette files and palette-swap variants. Pure (document in, bytes out) so it runs on a
 * compute worker; `ExportService` handles projects, paths and files.
 */
import {
  assertFrame,
  compositeFrame,
  invalidArg,
  loadPreset,
  medianCut,
  paletteValues,
  parseHex,
  Raster,
  resolveFrames,
  resolveLayer,
  resolveTag,
  setPalette,
  SpriteDocument,
  tagPlaybackOrder,
  type FrameSpec,
} from '@pixelclaus/core';
import {
  buildSpriteSheet,
  encodeApng,
  encodeGif,
  encodePxc,
  flattenOnMatte,
  rasterToPng,
  writeAseprite,
  writePalette,
  type PaletteFormat,
  type SpriteSheetOptions,
} from '@pixelclaus/formats';
import { encodeAnimatedWebp, encodeJpeg, encodeWebp } from './raster-codecs.js';
import { safeFileStem } from './paths.js';

export const EXPORT_FORMATS = [
  'png',
  'jpg',
  'webp',
  'gif',
  'apng',
  'webp_animated',
  'frames',
  'spritesheet',
  'aseprite',
  'pxc',
  'palette',
] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportRequest {
  format: ExportFormat;
  /** Still formats: frame to export (default 0). */
  frame?: number;
  /** Animated/sequence/sheet formats: frames (default all). */
  frames?: FrameSpec;
  /** Animated formats: export a tag (playback order incl. ping-pong). */
  tag?: string;
  /** Animated formats: one file per tag. */
  splitTags?: boolean;
  /** Isolate layers (ids or names). */
  layers?: string[];
  /** Still/sequence formats: one file per visible image layer. */
  splitLayers?: boolean;
  /** Integer upscale 1-16 (nearest neighbour). */
  scale?: number;
  /** Fill colour behind the art ('#rrggbb'); required for JPG (defaults to preview background or white). */
  background?: string;
  quality?: number;
  lossless?: boolean;
  loops?: number;
  /** Still formats: crop to content. */
  trim?: boolean;
  sheet?: Omit<SpriteSheetOptions, 'scale' | 'layers' | 'frames' | 'tag' | 'imageName'>;
  paletteFormat?: PaletteFormat;
  /** Indexed sprites: render once per palette (preset name or colour list, same index order). */
  paletteVariants?: Array<{ name: string; palette: string | string[] }>;
  /** Output directory (default: the project's exports folder). */
  outputDir?: string;
  /** Base file name without extension. */
  filename?: string;
}

export interface BuiltFile {
  name: string;
  data: Uint8Array;
  mime: string;
  width?: number;
  height?: number;
  frames?: number;
}

export interface ExportResult {
  files: Array<Omit<BuiltFile, 'data'> & { path: string; bytes: number }>;
  warnings: string[];
  /** PNG preview of the first image-like output. */
  preview?: Uint8Array;
}

export const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  apng: 'image/apng',
  json: 'application/json',
  aseprite: 'application/octet-stream',
  pxc: 'application/octet-stream',
  zip: 'application/zip',
  txt: 'text/plain',
};

function checkScale(s: number | undefined): number {
  const v = s ?? 1;
  if (!Number.isInteger(v) || v < 1 || v > 16)
    throw invalidArg(
      'scale must be an integer 1..16',
      'Pixel art should only be scaled by whole numbers (nearest neighbour)',
    );
  return v;
}

/** Render a frame for export (no reference layers, optional matte, scale and trim). */
function still(doc: SpriteDocument, frame: number, req: ExportRequest, isolate?: string[]): Raster {
  assertFrame(doc.state, frame);
  let r = compositeFrame(doc, { frame, isolate, includeReference: false });
  if (req.trim) {
    const b = r.bounds();
    if (b) r = r.crop(b);
  }
  if (req.background) r = flattenOnMatte(r, color(req.background));
  const s = checkScale(req.scale);
  if (Math.max(r.width, r.height) * s > 16384) {
    throw invalidArg(
      `Export would be ${r.width * s}x${r.height * s} px (max 16384 per side)`,
      'Lower scale, or export a region/trimmed frame',
    );
  }
  return s > 1 ? r.scaled(s) : r;
}

function color(hex: string): number {
  const v = parseHex(hex);
  if (v === null) throw invalidArg(`Invalid colour '${hex}'`);
  return v;
}

function animationSets(
  doc: SpriteDocument,
  req: ExportRequest,
): Array<{ suffix: string; order: number[]; loops: number }> {
  const st = doc.state;
  if (req.splitTags) {
    if (!st.tags.length) throw invalidArg('splitTags needs tags', 'Create tags with the tag tool first');
    return st.tags.map((t) => ({
      suffix: `-${t.name}`,
      order: tagPlaybackOrder(t),
      loops: req.loops ?? t.repeat,
    }));
  }
  if (req.tag) {
    const t = resolveTag(st, req.tag);
    return [{ suffix: `-${t.name}`, order: tagPlaybackOrder(t), loops: req.loops ?? t.repeat }];
  }
  return [{ suffix: '', order: resolveFrames(st, req.frames, 'all'), loops: req.loops ?? 0 }];
}

/** Build export files in memory (pure: no I/O; runs on a compute worker). */
export async function buildExport(
  doc: SpriteDocument,
  id: string,
  req: ExportRequest,
): Promise<{ files: BuiltFile[]; warnings: string[] }> {
  const warnings: string[] = [];
  const st = doc.state;
  const base = safeFileStem(req.filename ?? id);
  const scaleTag = (req.scale ?? 1) > 1 ? `@${req.scale}x` : '';
  const isolate = req.layers?.map((l) => resolveLayer(doc, l).id);
  const files: BuiltFile[] = [];

  if (req.paletteVariants?.length) {
    if (st.colorMode !== 'indexed') throw invalidArg('paletteVariants require an indexed sprite');
    for (const v of req.paletteVariants) {
      const clone = new SpriteDocument(doc.snapshot());
      if (typeof v.palette === 'string') loadPreset(clone, v.palette, 'index');
      else setPalette(clone, v.palette, { name: v.name, strategy: 'index' });
      const out = await buildExport(clone, id, {
        ...req,
        paletteVariants: undefined,
        filename: `${base}-${safeFileStem(v.name)}`,
      });
      files.push(...out.files);
      warnings.push(...out.warnings);
    }
    return { files, warnings };
  }

  const layerSets: Array<{ suffix: string; ids?: string[] }> = req.splitLayers
    ? st.layers
        .filter((l) => l.type === 'image' && l.visible)
        .map((l) => ({ suffix: `-${safeFileStem(l.name)}`, ids: [l.id] }))
    : [{ suffix: '', ids: isolate }];

  switch (req.format) {
    case 'png':
    case 'jpg':
    case 'webp': {
      const frame = req.frame ?? 0;
      for (const ls of layerSets) {
        const r = still(doc, frame, req, ls.ids);
        const name = `${base}${ls.suffix}${st.frames.length > 1 ? `-f${frame}` : ''}${scaleTag}.${req.format}`;
        let data: Uint8Array;
        if (req.format === 'png') data = rasterToPng(r);
        else if (req.format === 'jpg') {
          const matte = req.background ?? st.settings.previewBackground ?? '#ffffff';
          if (!req.background)
            warnings.push(`JPG has no transparency; composited on ${matte} (set background to choose)`);
          data = await encodeJpeg(r, { quality: req.quality, matte });
        } else data = await encodeWebp(r, { lossless: req.lossless ?? true, quality: req.quality });
        files.push({ name, data, mime: MIME[req.format]!, width: r.width, height: r.height });
      }
      break;
    }
    case 'frames': {
      const frames = req.tag
        ? tagPlaybackOrder(resolveTag(st, req.tag))
        : resolveFrames(st, req.frames, 'all');
      for (const ls of layerSets) {
        frames.forEach((f, i) => {
          const r = still(doc, f, req, ls.ids);
          files.push({
            name: `${base}${ls.suffix}-${String(i).padStart(3, '0')}${scaleTag}.png`,
            data: rasterToPng(r),
            mime: MIME.png!,
            width: r.width,
            height: r.height,
          });
        });
      }
      break;
    }
    case 'gif':
    case 'apng':
    case 'webp_animated': {
      if (req.trim) warnings.push('trim is ignored for animations (frames must share one size)');
      for (const set of animationSets(doc, req)) {
        const frames = set.order.map((f) => ({
          raster: still(doc, f, { ...req, trim: false }, isolate),
          duration: st.frames[f]!.duration,
        }));
        const ext = req.format === 'gif' ? 'gif' : req.format === 'apng' ? 'png' : 'webp';
        const name = `${base}${set.suffix}${scaleTag}.${ext}`;
        let data: Uint8Array;
        if (req.format === 'gif') {
          const res = encodeGif(
            frames.map((f) => ({ image: f.raster, duration: f.duration })),
            {
              loops: set.loops,
              quantize: (colors, max) =>
                medianCut(new Map([...colors].map(([c, n]) => [((c << 8) | 255) >>> 0, n])), max).map(
                  (c) => c >>> 8,
                ),
            },
          );
          data = res.bytes;
          warnings.push(...res.warnings);
        } else if (req.format === 'apng')
          data = encodeApng(
            frames.map((f) => ({ image: f.raster, duration: f.duration })),
            { loops: set.loops },
          );
        else
          data = await encodeAnimatedWebp(frames, {
            loops: set.loops,
            lossless: req.lossless ?? true,
            quality: req.quality,
          });
        files.push({
          name,
          data,
          mime: req.format === 'gif' ? MIME.gif! : req.format === 'apng' ? MIME.apng! : MIME.webp!,
          width: frames[0]!.raster.width,
          height: frames[0]!.raster.height,
          frames: frames.length,
        });
      }
      break;
    }
    case 'spritesheet': {
      const imageName = `${base}${scaleTag}.png`;
      const sheet = buildSpriteSheet(doc, {
        ...req.sheet,
        scale: checkScale(req.scale),
        layers: req.layers,
        frames: req.frames,
        tag: req.tag,
        imageName,
      });
      warnings.push(...sheet.warnings);
      let raster = sheet.raster;
      if (req.background) raster = flattenOnMatte(raster, color(req.background));
      files.push({
        name: imageName,
        data: rasterToPng(raster),
        mime: MIME.png!,
        width: raster.width,
        height: raster.height,
        frames: sheet.cells.length,
      });
      if (sheet.json)
        files.push({
          name: `${base}${scaleTag}.json`,
          data: new TextEncoder().encode(JSON.stringify(sheet.json, null, 1)),
          mime: MIME.json!,
        });
      break;
    }
    case 'aseprite':
      files.push({
        name: `${base}.aseprite`,
        data: writeAseprite(doc),
        mime: MIME.aseprite!,
        width: st.width,
        height: st.height,
        frames: st.frames.length,
      });
      break;
    case 'pxc':
      files.push({ name: `${base}.pxc`, data: encodePxc(doc.snapshot()), mime: MIME.pxc! });
      break;
    case 'palette': {
      const fmt = req.paletteFormat ?? 'hex';
      const vals = paletteValues(st.palette).slice(1);
      const hex = vals.map((c) => '#' + c.toString(16).padStart(8, '0').slice(0, 6));
      const names = vals.map((_, i) => st.palette.names[String(i + 1)]);
      files.push({
        name: `${base}-palette.${fmt}`,
        data: writePalette({ name: st.palette.name, colors: hex, names }, fmt),
        mime: MIME.txt!,
      });
      break;
    }
    default:
      throw invalidArg(
        `Unknown export format '${String(req.format)}'`,
        `Formats: ${EXPORT_FORMATS.join(', ')}`,
      );
  }
  return { files, warnings };
}
