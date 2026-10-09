/**
 * On-disk project folders.
 *
 *   <projectsDir>/<id>/project.json        manifest: state + revision + counters + checkpoint index
 *   <projectsDir>/<id>/images/<imageId>.bin
 *   <projectsDir>/<id>/masks/<maskId>.bin
 *   <projectsDir>/<id>/thumbnail.png
 *   <projectsDir>/<id>/checkpoints/<cp>.pxc
 *   <projectsDir>/<id>/exports/…
 *
 * Saves are incremental (only dirty images/masks are rewritten) and atomic (temp + rename, manifest last).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type DocumentSnapshot,
  type IdCounters,
  Mask,
  PixelBuffer,
  PixelClausError,
  SpriteDocument,
  type SpriteState,
} from '@pixelclaus/core';
import {
  decodeImageBlob,
  decodeMaskBlob,
  decodePxc,
  encodeImageBlob,
  encodeMaskBlob,
  encodePxc,
} from '@pixelclaus/formats';
import {
  exists,
  fileStamp,
  isWindowsBusy,
  mkdirIn,
  renameReplacing,
  stampOf,
  writeFileAtomic,
} from './fs-utils.js';

export const MANIFEST = 'project.json';
export const MANIFEST_FORMAT = 'pixelclaus-project';
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface CheckpointInfo {
  id: string;
  name: string;
  created: string;
  revision: number;
  bytes: number;
}

export interface Manifest {
  format: typeof MANIFEST_FORMAT;
  formatVersion: 1;
  revision: number;
  counters: IdCounters;
  checkpoints: CheckpointInfo[];
  state: SpriteState;
}

export interface ProjectListing {
  id: string;
  name: string;
  width: number;
  height: number;
  colorMode: string;
  frames: number;
  layers: number;
  tags: string[];
  revision: number;
  modified: string;
  created: string;
}

export interface LoadedProject {
  doc: SpriteDocument;
  manifest: Omit<Manifest, 'state' | 'counters'>;
  /** Manifest version stamp at load time (see manifestStamp). */
  stamp: string;
  /** Problems found while loading (e.g. missing image files). */
  warnings: string[];
}

export function validateProjectId(id: string): string {
  if (!ID_RE.test(id))
    throw new PixelClausError(
      'INVALID_ARGUMENT',
      `Invalid project id '${id}'`,
      'Ids use lowercase letters, digits, - and _',
    );
  return id;
}

export class ProjectStore {
  readonly root: string;
  /** Image/mask blobs known to exist on disk per project (undo can resurrect images whose files were GC'd). */
  private onDisk = new Map<string, { images: Set<string>; masks: Set<string> }>();

  constructor(root: string) {
    this.root = root;
  }

  dir(id: string): string {
    return join(this.root, validateProjectId(id));
  }

  manifestPath(id: string): string {
    return join(this.dir(id), MANIFEST);
  }

  exportsDir(id: string): string {
    return join(this.dir(id), 'exports');
  }

  thumbnailPath(id: string): string {
    return join(this.dir(id), 'thumbnail.png');
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async exists(id: string): Promise<boolean> {
    return ID_RE.test(id) && exists(this.manifestPath(id));
  }

  /** Version stamp of the manifest (inode:mtime:size), or null when the project does not exist. */
  async manifestStamp(id: string): Promise<string | null> {
    return fileStamp(this.manifestPath(id));
  }

  async readManifest(id: string): Promise<Manifest> {
    let raw: string;
    try {
      raw = await readFile(this.manifestPath(id), 'utf8');
    } catch {
      throw new PixelClausError('NOT_FOUND', `Project '${id}' not found`);
    }
    const m = JSON.parse(raw) as Manifest;
    if (m.format !== MANIFEST_FORMAT)
      throw new PixelClausError('INVALID_ARGUMENT', `${id}/project.json is not a PixelClaus manifest`);
    return m;
  }

  async list(): Promise<ProjectListing[]> {
    await this.init();
    const out: ProjectListing[] = [];
    for (const e of await readdir(this.root, { withFileTypes: true })) {
      if (!e.isDirectory() || !ID_RE.test(e.name)) continue;
      try {
        const m = await this.readManifest(e.name);
        const s = m.state;
        out.push({
          id: e.name,
          name: s.name,
          width: s.width,
          height: s.height,
          colorMode: s.colorMode,
          frames: s.frames.length,
          layers: s.layers.length,
          tags: s.tags.map((t) => t.name),
          revision: m.revision,
          modified: s.modified,
          created: s.created,
        });
      } catch {
        // skip unreadable folders
      }
    }
    return out.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  async load(id: string, historyEntries?: number): Promise<LoadedProject> {
    // stamp first: if the manifest changes while we read, the next access sees a newer stamp and reloads
    const stamp = (await this.manifestStamp(id)) ?? '';
    const m = await this.readManifest(id);
    const dir = this.dir(id);
    const images = new Map<string, PixelBuffer>();
    const masks = new Map<string, Mask>();
    const imageIds = new Set<string>([
      ...m.state.cels.map((c) => c.imageId),
      ...Object.values(m.state.clipboards).map((c) => c.imageId),
    ]);
    const known = { images: new Set<string>(), masks: new Set<string>() };
    const missing: string[] = [];
    await Promise.all(
      [...imageIds].map(async (iid) => {
        try {
          images.set(iid, decodeImageBlob(new Uint8Array(await readFile(join(dir, 'images', `${iid}.bin`)))));
          known.images.add(iid);
        } catch {
          images.set(iid, new PixelBuffer(m.state.width, m.state.height));
          missing.push(iid);
        }
      }),
    );
    await Promise.all(
      Object.values(m.state.selections).map(async (mid) => {
        try {
          masks.set(mid, decodeMaskBlob(new Uint8Array(await readFile(join(dir, 'masks', `${mid}.bin`)))));
          known.masks.add(mid);
        } catch {
          masks.set(mid, new Mask(m.state.width, m.state.height));
        }
      }),
    );
    this.onDisk.set(id, known);
    const warnings: string[] = [];
    if (missing.length) {
      const where = m.state.cels
        .filter((c) => missing.includes(c.imageId))
        .map((c) => `${c.layerId}@${c.frame}`);
      warnings.push(
        `${missing.length} image file(s) were missing or unreadable and load as empty cels (${where.slice(0, 12).join(', ')}); restore a checkpoint if pixels are lost`,
      );
    }
    const doc = new SpriteDocument(
      { state: m.state, images, masks, counters: m.counters },
      historyEntries ? { maxEntries: historyEntries } : undefined,
    );
    doc.takeDirty();
    const { state: _s, counters: _c, ...rest } = m;
    return { doc, manifest: rest, stamp, warnings };
  }

  /** Persist a document. Only dirty images/masks are written unless `full`. Returns the new stamp. */
  async save(
    id: string,
    doc: SpriteDocument,
    manifest: Omit<Manifest, 'state' | 'counters'>,
    full = false,
  ): Promise<string> {
    const dir = this.dir(id);
    if (!(await exists(dir))) {
      throw new PixelClausError(
        'NOT_FOUND',
        `Project '${id}' was deleted`,
        'List projects with project_list',
      );
    }
    const dirty = doc.takeDirty();
    const imgRefs = doc.referencedImageIds();
    const maskRefs = doc.referencedMaskIds();
    const known = this.onDisk.get(id) ?? { images: new Set<string>(), masks: new Set<string>() };
    this.onDisk.set(id, known);
    // write dirty blobs plus any referenced blob that is not on disk (e.g. brought back by undo after GC)
    const imgIds = full
      ? [...imgRefs]
      : [...imgRefs].filter((i) => dirty.images.has(i) || !known.images.has(i));
    const maskIds = full
      ? [...maskRefs]
      : [...maskRefs].filter((i) => dirty.masks.has(i) || !known.masks.has(i));
    const local = { mkdir: false };
    await mkdirIn(join(dir, 'images'));
    if (maskIds.length) await mkdirIn(join(dir, 'masks'));
    // compress blob by blob, yielding to the event loop every few ms: saving a big project (hundreds of
    // images) must not freeze the requests of other agents
    const writes: Promise<unknown>[] = [];
    let slice = Date.now();
    for (const iid of imgIds) {
      writes.push(writeFileAtomic(join(dir, 'images', `${iid}.bin`), encodeImageBlob(doc.image(iid)), local));
      if (Date.now() - slice > 8) {
        await new Promise((r) => setImmediate(r));
        slice = Date.now();
      }
    }
    for (const mid of maskIds) {
      writes.push(writeFileAtomic(join(dir, 'masks', `${mid}.bin`), encodeMaskBlob(doc.mask(mid)), local));
    }
    await Promise.all(writes);
    for (const i of imgIds) known.images.add(i);
    for (const i of maskIds) known.masks.add(i);
    const m: Manifest = {
      ...manifest,
      format: MANIFEST_FORMAT,
      formatVersion: 1,
      counters: doc.counters,
      state: doc.state,
    };
    const st = await writeFileAtomic(join(dir, MANIFEST), JSON.stringify(m), local);
    if (full || dirty.meta || imgIds.length) await this.gc(id, imgRefs, maskRefs);
    return stampOf(st);
  }

  private async gc(id: string, imgRefs: Set<string>, maskRefs: Set<string>): Promise<void> {
    const dir = this.dir(id);
    for (const [sub, refs] of [
      ['images', imgRefs],
      ['masks', maskRefs],
    ] as const) {
      try {
        for (const f of await readdir(join(dir, sub))) {
          const key = f.replace(/\.bin$/, '');
          if (f.endsWith('.bin') && !refs.has(key)) {
            await rm(join(dir, sub, f), { force: true });
            this.onDisk.get(id)?.[sub === 'images' ? 'images' : 'masks'].delete(key);
          }
        }
      } catch {
        // folder may not exist
      }
    }
  }

  /** Thumbnails are rendered by the project service (on a compute worker) and written here. */
  async writeThumbnailPng(id: string, png: Uint8Array): Promise<void> {
    // no mkdir: a project deleted meanwhile must not be resurrected as a folder with only a thumbnail
    const tmp = join(this.dir(id), `.thumb-${randomBytes(4).toString('hex')}.tmp`);
    try {
      await writeFile(tmp, png);
      await renameReplacing(tmp, this.thumbnailPath(id));
    } catch {
      await rm(tmp, { force: true });
    }
  }

  async delete(id: string): Promise<void> {
    if (!(await this.exists(id))) throw new PixelClausError('NOT_FOUND', `Project '${id}' not found`);
    // retry: another thread/process may be finishing a write (e.g. a thumbnail) inside the folder
    await rm(this.dir(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
    this.onDisk.delete(id);
  }

  /**
   * Reserve a free id derived from a name by creating its folder exclusively: concurrent creates (other
   * sessions, threads or processes) can never receive the same id. Call `releaseId` if the project is
   * not saved after all.
   */
  async allocateId(base: string): Promise<string> {
    await this.init();
    const slug = (base || 'sprite').slice(0, 56);
    for (let i = 1; i <= 10000; i++) {
      const candidate = i === 1 ? slug : `${slug}-${i}`;
      try {
        await mkdir(join(this.root, candidate));
        return candidate;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
    throw new PixelClausError(
      'CONFLICT',
      `No free project id for '${slug}'`,
      'Choose a different project name',
    );
  }

  /**
   * Cross-process lock for one project (several `pixelclaus mcp` processes may share a data dir): an
   * exclusively created `.lock` file. Waits while another process holds it; a lock older than
   * `staleMs` (a crashed process) is broken. Returns the release function.
   */
  async lock(id: string, opts: { timeoutMs?: number; staleMs?: number } = {}): Promise<() => Promise<void>> {
    const file = join(this.dir(id), '.lock');
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const staleMs = opts.staleMs ?? 60_000;
    const start = Date.now();
    let lastError: unknown;
    for (let wait = 2; ; wait = Math.min(wait * 2, 50)) {
      try {
        await writeFile(file, `${process.pid} ${new Date().toISOString()}`, { flag: 'wx' });
        return async () => {
          await rm(file, { force: true });
        };
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          throw new PixelClausError(
            'NOT_FOUND',
            `Project '${id}' not found`,
            'It may have been deleted; list projects with project_list',
          );
        }
        // Windows: EPERM while the previous holder's .lock is still being deleted; wait like for EEXIST
        if (code !== 'EEXIST' && !isWindowsBusy(e)) throw e;
        lastError = code === 'EEXIST' ? undefined : e;
      }
      const age = await stat(file).then(
        (st) => Date.now() - st.mtimeMs,
        () => 0,
      );
      if (age > staleMs) {
        await rm(file, { force: true });
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        if (lastError) throw lastError; // never cleared: a real permission problem, not a busy project
        throw new PixelClausError(
          'CONFLICT',
          `Project '${id}' is busy in another PixelClaus process`,
          'Retry in a moment; if it persists, another process may be stuck (its .lock file expires after 60 s)',
        );
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  /** Reserve exactly this id (exclusive mkdir). False when it is already taken. */
  async reserveId(id: string): Promise<boolean> {
    await this.init();
    try {
      await mkdir(join(this.root, validateProjectId(id)));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
  }

  /** Undo an `allocateId` reservation (only removes a folder that never got a manifest). */
  async releaseId(id: string): Promise<void> {
    if (!(await exists(this.manifestPath(id)))) await rm(this.dir(id), { recursive: true, force: true });
  }

  // ─── checkpoints ───

  checkpointPath(id: string, cp: string): string {
    return join(this.dir(id), 'checkpoints', `${cp}.pxc`);
  }

  /**
   * Write a checkpoint: .pxc bytes (the service encodes them on the compute pool) or a snapshot to
   * encode here. Returns its size.
   */
  async writeCheckpoint(id: string, cpId: string, data: Uint8Array | DocumentSnapshot): Promise<number> {
    const bytes = data instanceof Uint8Array ? data : encodePxc(data);
    await mkdirIn(join(this.dir(id), 'checkpoints'));
    await writeFileAtomic(this.checkpointPath(id, cpId), bytes, { mkdir: false });
    return bytes.length;
  }

  /** Raw checkpoint bytes (the service decodes them on the compute pool). */
  async readCheckpointBytes(id: string, cpId: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.checkpointPath(id, cpId)));
  }

  /** Decoded checkpoint (inline; tools and tests). */
  async readCheckpoint(id: string, cpId: string): Promise<DocumentSnapshot> {
    return decodePxc(await this.readCheckpointBytes(id, cpId));
  }

  async deleteCheckpoint(id: string, cpId: string): Promise<void> {
    await rm(this.checkpointPath(id, cpId), { force: true });
  }

  async dirSize(id: string): Promise<number> {
    let total = 0;
    const walk = async (p: string) => {
      for (const e of await readdir(p, { withFileTypes: true })) {
        const fp = join(p, e.name);
        if (e.isDirectory()) await walk(fp);
        else total += (await stat(fp)).size;
      }
    };
    await walk(this.dir(id));
    return total;
  }
}
