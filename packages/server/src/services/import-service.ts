/**
 * Imports: images (new project or new layer), sprite sheets (sliced into frames), .aseprite, .pxc,
 * palette files.
 */
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import {
  addFrames,
  addLayer,
  ColorResolver,
  createDocument,
  invalidArg,
  makePalette,
  medianCut,
  PixelBuffer,
  PixelClausError,
  Raster,
  setPalette,
  slugify,
  addColors,
  type ColorMode,
  type SpriteDocument,
} from '@pixelclaus/core';
import {
  decodePxc,
  fromBase64,
  isPxc,
  readAseprite,
  readPalette,
  sliceSheet,
  type PaletteFile,
} from '@pixelclaus/formats';
import { decodeImageFile } from './raster-codecs.js';
import type { ProjectService } from './project-service.js';
import { resolveUserPath } from './paths.js';

export const IMPORT_KINDS = ['auto', 'image', 'spritesheet', 'aseprite', 'pxc', 'palette'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export interface ImportRequest {
  kind?: ImportKind;
  /** File path (absolute, ~, or relative to the data directory). */
  path?: string;
  /** Base64 file content (data: URLs accepted). */
  data?: string;
  /** Original file name (used to detect the kind when importing from data). */
  filename?: string;
  /** Import into this project (image → new layer, palette → replace/append). Omit to create a new project. */
  project?: string;
  /** Name for a new project. */
  name?: string;
  /** New-project colour mode (default: indexed if ≤ 255 colours, else rgba). */
  colorMode?: ColorMode;
  /** When building an indexed palette from > 255 colours, reduce to this many (default 32). */
  maxColors?: number;
  // image into existing project
  layer?: string;
  frame?: number;
  x?: number;
  y?: number;
  /** Animated images: create one frame per image frame (default true). */
  asFrames?: boolean;
  // sprite sheets
  frameWidth?: number;
  frameHeight?: number;
  count?: number;
  marginX?: number;
  marginY?: number;
  spacingX?: number;
  spacingY?: number;
  /** Frame duration (ms) for sliced sheets. */
  duration?: number;
  // palettes
  /** Palette import into a project: 'replace' (default, nearest remap) or 'append'. */
  paletteMode?: 'replace' | 'replace-keep-indices' | 'append';
}

export interface ImportResult {
  project: string;
  created: boolean;
  summary: string;
  warnings: string[];
}

function detectKind(bytes: Uint8Array, filename: string): ImportKind {
  const ext = extname(filename).toLowerCase();
  if (ext === '.aseprite' || ext === '.ase') return 'aseprite';
  if (ext === '.pxc' || isPxc(bytes)) return 'pxc';
  if (['.gpl', '.pal', '.act', '.hex'].includes(ext)) return 'palette';
  if (bytes.length > 6 && bytes[4] === 0xe0 && bytes[5] === 0xa5) return 'aseprite';
  return 'image';
}

/**
 * Fit a palette file into PixelClaus's 255 usable entries (index 0 is transparent): drop the declared
 * ACT transparency entry, then exact duplicates, then truncate — each with a warning.
 */
function fitPalette(p: PaletteFile): {
  colors: string[];
  names: Array<string | undefined>;
  warnings: string[];
} {
  const warnings: string[] = [];
  let entries = p.colors.map((c, i) => ({ c: c.toLowerCase(), n: p.names?.[i] }));
  if (p.transparentIndex !== undefined) {
    entries = entries.filter((_, i) => i !== p.transparentIndex);
    warnings.push(
      `Dropped entry ${p.transparentIndex} (the file's transparent colour); PixelClaus uses index 0 for transparency`,
    );
  }
  if (entries.length > 255) {
    const seen = new Set<string>();
    const before = entries.length;
    entries = entries.filter((e) => (seen.has(e.c) ? false : (seen.add(e.c), true)));
    if (entries.length < before) warnings.push(`Removed ${before - entries.length} duplicate colour(s)`);
  }
  if (entries.length > 255) {
    warnings.push(
      `Palette has ${entries.length} colours; kept the first 255 (index 0 is reserved for transparent)`,
    );
    entries = entries.slice(0, 255);
  }
  return { colors: entries.map((e) => e.c), names: entries.map((e) => e.n), warnings };
}

/** Run a parser and turn low-level failures into an actionable INVALID_ARGUMENT. */
function parseOrExplain<T>(fn: () => T, what: string, filename: string): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PixelClausError) throw e;
    throw invalidArg(
      `Could not read '${filename}' as ${what}: ${(e as Error).message}`,
      'Check the file (or base64 data) is complete; set "kind" if the type was detected wrongly',
    );
  }
}

async function decodeOrExplain(bytes: Uint8Array, filename: string) {
  try {
    const d = await decodeImageFile(bytes);
    if (!d.frames.length || d.width < 1 || d.height < 1) throw new Error('no frames');
    return d;
  } catch (e) {
    if (e instanceof PixelClausError) throw e;
    throw invalidArg(
      `Could not decode '${filename}' as an image (${bytes.length} bytes): ${(e as Error).message.split('\n')[0]}`,
      'Supported: PNG, APNG, GIF, JPEG, WebP, BMP/TIFF; for .aseprite/.pxc/.gpl set "kind" or a matching filename',
    );
  }
}

/** Distinct opaque colours of a set of rasters. */
function colorHistogram(rasters: Raster[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of rasters) {
    for (let i = 0; i < r.data.length; i += 4) {
      const a = r.data[i + 3]!;
      if (a === 0) continue;
      const c = ((r.data[i]! << 24) | (r.data[i + 1]! << 16) | (r.data[i + 2]! << 8) | a) >>> 0;
      m.set(c, (m.get(c) ?? 0) + 1);
    }
  }
  return m;
}

export class ImportService {
  constructor(private readonly projects: ProjectService) {}

  private async bytesOf(req: ImportRequest): Promise<{ bytes: Uint8Array; filename: string }> {
    if (req.data) return { bytes: fromBase64(req.data), filename: req.filename ?? 'import' };
    if (!req.path) throw invalidArg('Give "path" or "data" (base64)');
    const full = resolveUserPath(this.projects.config, req.path, this.projects.config.dataDir);
    try {
      return { bytes: new Uint8Array(await readFile(full)), filename: req.filename ?? basename(full) };
    } catch {
      throw new PixelClausError(
        'NOT_FOUND',
        `Cannot read '${full}'`,
        'Check the path; relative paths resolve against the PixelClaus data directory',
      );
    }
  }

  async import(req: ImportRequest): Promise<ImportResult> {
    const r = await this.importInner(req);
    if (r.created) {
      const listing = await this.projects.read(r.project, (doc) => doc.state.name);
      const expected = slugify(listing.value);
      if (r.project !== expected && !(expected === 'sprite' && r.project.startsWith('sprite'))) {
        r.warnings.unshift(
          `'${expected}' was taken, so the new project's id is '${r.project}'. Pass project: "${r.project}" in every call.`,
        );
      }
    }
    return r;
  }

  private async importInner(req: ImportRequest): Promise<ImportResult> {
    const { bytes, filename } = await this.bytesOf(req);
    const kind = req.kind && req.kind !== 'auto' ? req.kind : detectKind(bytes, filename);
    const stem = filename.replace(/\.[^.]+$/, '') || 'imported';
    switch (kind) {
      case 'aseprite': {
        const { snapshot, warnings } = parseOrExplain(
          () => readAseprite(bytes, req.name ?? stem),
          'an .aseprite file',
          filename,
        );
        const { id, doc } = await this.projects.adopt(snapshot, req.name ?? stem);
        return {
          project: id,
          created: true,
          summary: `Imported .aseprite: ${doc.state.width}x${doc.state.height}, ${doc.state.layers.length} layers, ${doc.state.frames.length} frames, ${doc.state.tags.length} tags`,
          warnings,
        };
      }
      case 'pxc': {
        const snap = parseOrExplain(() => decodePxc(bytes), 'a .pxc project', filename);
        const { id } = await this.projects.adopt(snap, req.name ?? snap.state.name ?? stem);
        return {
          project: id,
          created: true,
          summary: `Imported .pxc project '${snap.state.name}'`,
          warnings: [],
        };
      }
      case 'palette': {
        const raw = parseOrExplain(() => readPalette(bytes, filename), 'a palette file', filename);
        const { colors, names, warnings } = fitPalette(raw);
        if (!req.project) {
          const { id } = await this.projects.create({
            name: req.name ?? raw.name,
            width: 16,
            height: 16,
            palette: colors,
            paletteName: raw.name,
            paletteNames: names,
          });
          return {
            project: id,
            created: true,
            summary: `Created a 16x16 project with palette '${raw.name}' (${colors.length} colours)`,
            warnings,
          };
        }
        const r = await this.projects.mutate(req.project, (doc) => {
          if (req.paletteMode === 'append') return `appended ${addColors(doc, colors, names).length} colours`;
          const changed = setPalette(doc, colors, {
            name: raw.name,
            names,
            strategy: req.paletteMode === 'replace-keep-indices' ? 'index' : 'nearest',
          });
          return `palette replaced with '${raw.name}' (${colors.length} colours), ${changed} pixel(s) remapped`;
        });
        return { project: r.id, created: false, summary: r.value, warnings: [...warnings, ...r.warnings] };
      }
      case 'spritesheet':
      case 'image': {
        const decoded = await decodeOrExplain(bytes, filename);
        let frames = decoded.frames;
        if (kind === 'spritesheet') {
          if (!req.frameWidth || !req.frameHeight)
            throw invalidArg('spritesheet import needs frameWidth and frameHeight');
          const cells = sliceSheet(frames[0]!.raster, {
            frameWidth: req.frameWidth,
            frameHeight: req.frameHeight,
            count: req.count,
            marginX: req.marginX,
            marginY: req.marginY,
            spacingX: req.spacingX,
            spacingY: req.spacingY,
          });
          if (!cells.length)
            throw invalidArg(
              'No non-empty frames found in the sheet',
              'Check frameWidth/frameHeight/margins',
            );
          frames = cells.map((raster) => ({ raster, duration: req.duration ?? 100 }));
        } else if (req.asFrames === false) frames = frames.slice(0, 1);
        return req.project ? this.intoProject(req, frames, stem) : this.newProject(req, frames, stem);
      }
      default:
        throw invalidArg(`Unknown import kind '${kind}'`);
    }
  }

  private async newProject(
    req: ImportRequest,
    frames: Array<{ raster: Raster; duration: number }>,
    stem: string,
  ): Promise<ImportResult> {
    const w = frames[0]!.raster.width;
    const h = frames[0]!.raster.height;
    const warnings: string[] = [];
    const hist = colorHistogram(frames.map((f) => f.raster));
    const mode: ColorMode = req.colorMode ?? (hist.size <= 255 ? 'indexed' : 'rgba');
    let colors = [...hist.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    if (colors.length > 255) {
      colors = medianCut(hist, Math.min(255, req.maxColors ?? 32));
      if (mode === 'indexed')
        warnings.push(
          `Image has ${hist.size} colours; quantised to ${colors.length} for the indexed palette`,
        );
    }
    const name = req.name ?? stem;
    const { id } = await this.projects.create({
      name,
      width: w,
      height: h,
      colorMode: mode,
      palette: colors.map((c) => '#' + c.toString(16).padStart(8, '0')),
      frames: frames.length,
      layers: ['Imported'],
      settings: { paletteLock: mode === 'indexed' },
    });
    const r = await this.projects.mutate(id, (doc) => {
      doc.transact('Import image', (tx) => {
        const resolver = new ColorResolver(doc, tx);
        const layer = tx.state.layers[0]!;
        frames.forEach((f, i) => {
          const buf = rasterToBuffer(f.raster, resolver);
          tx.state.cels.push({
            layerId: layer.id,
            frame: i,
            imageId: tx.adoptImage(buf),
            x: 0,
            y: 0,
            opacity: 255,
            zIndex: 0,
          });
          tx.state.frames[i]!.duration = f.duration;
        });
      });
      doc.history.clear();
      doc.drainWarnings();
    });
    warnings.push(...r.warnings);
    return {
      project: id,
      created: true,
      summary: `Created ${w}x${h} ${mode} project '${name}' with ${frames.length} frame(s) and ${Math.min(colors.length, 255)} palette colour(s)`,
      warnings,
    };
  }

  private async intoProject(
    req: ImportRequest,
    frames: Array<{ raster: Raster; duration: number }>,
    stem: string,
  ): Promise<ImportResult> {
    const r = await this.projects.mutate(req.project!, (doc: SpriteDocument) => {
      return doc.transact('Import image as layer', (tx) => {
        const st = tx.state;
        const layer = addLayer(doc, { name: req.layer ?? stem });
        const start = req.frame ?? 0;
        const ix = req.x ?? 0;
        const iy = req.y ?? 0;
        const fw = frames[0]!.raster.width;
        const fh = frames[0]!.raster.height;
        if (ix >= st.width || iy >= st.height || ix + fw <= 0 || iy + fh <= 0) {
          throw invalidArg(
            `Image (${fw}x${fh}) at ${ix},${iy} lies completely outside the ${st.width}x${st.height} canvas`,
            'Use x/y inside the canvas (default 0,0)',
          );
        }
        const needed = start + frames.length - st.frames.length;
        if (needed > 0) {
          addFrames(doc, { count: needed });
          tx.warn(`Added ${needed} frame(s) so the import fits (sprite now has ${st.frames.length} frames)`);
        }
        const resolver = new ColorResolver(doc, tx);
        const snapped: SnapStats = { colors: new Set(), pixels: 0 };
        let cropped = false;
        frames.forEach((f, i) => {
          const canvas = new Raster(st.width, st.height);
          canvas.draw(f.raster, req.x ?? 0, req.y ?? 0);
          if (f.raster.width + (req.x ?? 0) > st.width || f.raster.height + (req.y ?? 0) > st.height)
            cropped = true;
          const buf = rasterToBuffer(canvas, resolver, snapped);
          st.cels.push({
            layerId: layer.id,
            frame: start + i,
            imageId: tx.adoptImage(buf),
            x: 0,
            y: 0,
            opacity: 255,
            zIndex: 0,
          });
        });
        const sw = snapWarning(snapped, doc);
        if (sw) tx.warn(sw);
        if (cropped)
          tx.warn(
            `Image (${frames[0]!.raster.width}x${frames[0]!.raster.height}) is larger than the canvas at that position and was cropped`,
          );
        return `Imported ${frames.length} frame(s) into new layer '${layer.name}' (${layer.id}) starting at frame ${start}`;
      });
    });
    return { project: r.id, created: false, summary: r.value, warnings: r.warnings };
  }
}

/** Convert an RGBA raster into document pixel values (snapping to the palette as the document requires). */
export function rasterToBuffer(r: Raster, resolver: ColorResolver, snapped?: SnapStats): PixelBuffer {
  const buf = new PixelBuffer(r.width, r.height);
  const cache = new Map<number, number>();
  for (let i = 0; i < buf.data.length; i++) {
    const a = r.data[i * 4 + 3]!;
    if (a === 0) continue;
    const c = ((r.data[i * 4]! << 24) | (r.data[i * 4 + 1]! << 16) | (r.data[i * 4 + 2]! << 8) | a) >>> 0;
    let v = cache.get(c);
    if (v === undefined) {
      v = resolver.fromRgba(c);
      cache.set(c, v);
      if (snapped && resolver.rgba(v) >>> 0 !== c) snapped.colors.add(c);
    }
    if (snapped && snapped.colors.has(c)) snapped.pixels++;
    buf.data[i] = v;
  }
  return buf;
}

/** Off-palette colours met while converting imported pixels. */
export interface SnapStats {
  colors: Set<number>;
  pixels: number;
}

function snapWarning(s: SnapStats, doc: SpriteDocument): string | null {
  if (!s.colors.size) return null;
  const sample = [...s.colors].slice(0, 4).map((c) => '#' + c.toString(16).padStart(8, '0').slice(0, 6));
  const target =
    doc.state.colorMode === 'indexed'
      ? 'the nearest palette colour'
      : 'the nearest palette colour (palette lock is on)';
  return `${s.colors.size} imported colour(s) (${sample.join(', ')}${s.colors.size > 4 ? ', …' : ''}) are not in the palette; ${s.pixels} pixel(s) were snapped to ${target}. Add the colours first (palette action "add") or import into a new project to keep them exact`;
}

export { makePalette, createDocument };
