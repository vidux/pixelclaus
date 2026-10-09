/**
 * Exports for projects: builds files on the compute pool (see export-build.ts) from a consistent copy of
 * the document, then writes them to the project's exports folder (or a checked outputDir) or returns a
 * single download.
 */
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { zipSync } from 'fflate';
import { PixelClausError } from '@pixelclaus/core';
import type { ComputePool } from '../compute/pool.js';
import { docPayload } from '../compute/snapshot.js';
import { framesForExport } from '../compute/tasks.js';
import { mkdirIn, writeFileAtomic } from '../storage/fs-utils.js';
import { MIME, type BuiltFile, type ExportRequest, type ExportResult } from './export-build.js';
import { realPathDeep, resolveUserPath, safeFileStem } from './paths.js';
import type { ProjectService } from './project-service.js';

export {
  buildExport,
  EXPORT_FORMATS,
  type BuiltFile,
  type ExportFormat,
  type ExportRequest,
  type ExportResult,
} from './export-build.js';

export class ExportService {
  constructor(
    private readonly projects: ProjectService,
    private readonly compute: ComputePool,
  ) {}

  /** Copy the document under the read path, then build on a worker (no lock held while building). */
  private async build(
    ref: string,
    req: ExportRequest,
  ): Promise<{ id: string; files: BuiltFile[]; warnings: string[] }> {
    const r = await this.projects.read(ref, (doc) => docPayload(doc, { frames: framesForExport(req) }));
    const { payload, transfer } = r.value;
    const out = await this.compute.run({ kind: 'export', doc: payload, id: r.id, req }, transfer);
    return { id: r.id, ...out };
  }

  /** Export a project to disk. */
  async export(ref: string, req: ExportRequest): Promise<ExportResult & { id: string }> {
    const { id, ...value } = await this.build(ref, req);
    const own = this.projects.store.exportsDir(id);
    const dir = req.outputDir ? resolveUserPath(this.projects.config, req.outputDir, own) : own;
    // never write into project folders (manifests, image blobs) except this project's exports folder;
    // compare real paths so symlinks (to the data dir or into another project) cannot sneak past
    const inside = (parent: string, child: string) => {
      const rel = relative(parent, child);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    };
    const realDir = realPathDeep(dir);
    const realRoot = realPathDeep(this.projects.store.root);
    const realOwn = join(realPathDeep(this.projects.store.dir(id)), 'exports');
    if (inside(realRoot, realDir) && !inside(realOwn, realDir)) {
      throw new PixelClausError(
        'INVALID_ARGUMENT',
        `outputDir '${req.outputDir}' points inside the PixelClaus projects folder`,
        `Omit outputDir to use ${own}, or choose a folder outside ${this.projects.store.root}`,
      );
    }
    // inside the project: never recreate a folder that was deleted while the export was building
    const ownFolder = inside(realOwn, realDir);
    if (ownFolder) {
      if (!(await this.projects.store.exists(id))) {
        throw new PixelClausError(
          'NOT_FOUND',
          `Project '${id}' was deleted while the export was being built; nothing was written`,
          'List projects with project_list',
        );
      }
      await mkdirIn(own);
      if (realDir !== realOwn) await mkdir(dir, { recursive: true }); // a subfolder of exports/
    }
    const out: ExportResult['files'] = [];
    for (const f of value.files) {
      const path = join(dir, f.name);
      await writeFileAtomic(path, f.data, { mkdir: !ownFolder });
      const { data, ...meta } = f;
      out.push({ ...meta, path, bytes: data.length });
    }
    const firstImg = value.files.find((f) => f.mime === 'image/png');
    return { id, files: out, warnings: value.warnings, preview: firstImg?.data };
  }

  /** Build a single downloadable payload (zip when several files). */
  async download(ref: string, req: ExportRequest): Promise<{ name: string; data: Uint8Array; mime: string }> {
    const { id, ...value } = await this.build(ref, req);
    if (value.files.length === 1) return value.files[0]!;
    const zip = zipSync(Object.fromEntries(value.files.map((f) => [f.name, f.data])), { level: 6 });
    return { name: `${safeFileStem(req.filename ?? id)}-${req.format}.zip`, data: zip, mime: MIME.zip! };
  }
}
