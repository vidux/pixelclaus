/**
 * Project lifecycle + safe mutation, built for several agents working at once:
 * - mutations are serialised per project (different projects never wait for each other);
 * - loads are single-flight, and a reader never mistakes this process's own in-flight save for an
 *   external edit (which would reload the project and wipe its undo history);
 * - recently used or busy projects are never unloaded from the cache, so active agents keep undo;
 * - ids are reserved atomically, so concurrent creates with the same name get distinct projects;
 * - thumbnails are rendered on the compute pool, debounced, off the request path.
 */
import { randomBytes } from 'node:crypto';
import {
  createDocument,
  notFound,
  PixelClausError,
  slugify,
  SpriteDocument,
  suggest,
  type CreateDocumentOptions,
  type DocumentSnapshot,
} from '@pixelclaus/core';
import { ComputePool } from '../compute/pool.js';
import { docPayload, fullPayload, payloadSnapshot } from '../compute/snapshot.js';
import type { ServerConfig } from '../config.js';
import { projectsDir } from '../config.js';
import { KeyedMutex } from '../storage/fs-utils.js';
import {
  ProjectStore,
  type CheckpointInfo,
  type Manifest,
  type ProjectListing,
} from '../storage/project-store.js';

interface Entry {
  id: string;
  doc: SpriteDocument;
  manifest: Omit<Manifest, 'state' | 'counters'>;
  /** Manifest stamp this entry corresponds to (see ProjectStore.manifestStamp). */
  stamp: string;
  lastUsed: number;
  /** Operations currently using this entry (never unloaded while > 0). */
  busy: number;
}

export interface MutationResult<T> {
  value: T;
  warnings: string[];
  revision: number;
  changed: boolean;
}

function idleText(seconds: number): string {
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/** Thumbnail refresh delay after the last change (ms). */
const THUMBNAIL_DEBOUNCE_MS = 750;

export class ProjectService {
  readonly store: ProjectStore;
  readonly config: ServerConfig;
  private readonly compute: ComputePool;
  private cache = new Map<string, Entry>();
  private mutex = new KeyedMutex();
  /** Single-flight loads. */
  private loading = new Map<string, Promise<Entry>>();
  /** Projects with a mutation in progress in this process (their manifest may change under readers). */
  private writing = new Set<string>();
  /** Projects unloaded with undo history, and why (to tell the agent after a reload). */
  private unloaded = new Map<string, 'idle' | 'cap'>();
  private thumbTimers = new Map<string, NodeJS.Timeout>();
  private thumbInflight = new Map<string, Promise<void>>();
  /** Notes about reloads (e.g. external edits) surfaced with the next result. */
  private notices = new Map<string, string[]>();

  constructor(config: ServerConfig, compute?: ComputePool) {
    this.config = config;
    this.compute = compute ?? new ComputePool({ size: 0 });
    this.store = new ProjectStore(projectsDir(config));
  }

  async init(): Promise<void> {
    await this.store.init();
  }

  async list(): Promise<ProjectListing[]> {
    return this.store.list();
  }

  /** Short-lived listing for name lookups (reading every manifest per call gets slow with many projects). */
  private listing: { at: number; list: Promise<ProjectListing[]> } | null = null;

  private async namesListing(fresh = false): Promise<ProjectListing[]> {
    if (fresh || !this.listing || Date.now() - this.listing.at > 2000) {
      this.listing = { at: Date.now(), list: this.store.list() };
    }
    return this.listing.list;
  }

  /**
   * Resolve an id or a (case-insensitive) project name to an id. A name shared by several projects is
   * an error listing their ids — with several agents, silently picking one could edit someone else's work.
   */
  async resolveId(ref: string): Promise<string> {
    const r = ref.trim();
    if (await this.store.exists(r)) return r;
    let list = await this.namesListing();
    const match = (l: ProjectListing[]) =>
      l.filter((p) => p.name === r || p.name.toLowerCase() === r.toLowerCase());
    let byName = match(list);
    if (byName.length === 0) {
      // maybe created/renamed elsewhere since the cached listing: look again before failing
      list = await this.namesListing(true);
      byName = match(list);
    }
    if (byName.length === 1) return byName[0]!.id;
    if (byName.length > 1) {
      throw new PixelClausError(
        'INVALID_ARGUMENT',
        `Project name '${r}' is used by ${byName.length} projects`,
        `Pass the id instead: ${byName.map((p) => p.id).join(', ')}`,
      );
    }
    const slug = slugify(r);
    if (await this.store.exists(slug)) return slug;
    const candidates = [...list.map((p) => p.id), ...list.map((p) => p.name)];
    const err = notFound(
      'project',
      r,
      list.map((p) => `${p.id}${p.name !== p.id ? ` ("${p.name}")` : ''}`),
    );
    const close = suggest(r, candidates);
    if (close.length) err.message += ` — did you mean ${close.join(' or ')}?`;
    throw err;
  }

  /** Open projects and their state (diagnostics). */
  cacheStats(): { open: number; busy: number; writing: number } {
    return {
      open: this.cache.size,
      busy: [...this.cache.values()].filter((e) => e.busy > 0).length,
      writing: this.writing.size,
    };
  }

  /**
   * Keep at most `cacheSize` projects, but only unload ones that are idle (≥ cacheIdleSeconds), not
   * busy and fully saved — active agents keep their documents and undo history. A hard ceiling of
   * 4 × cacheSize bounds memory if many projects are active at once.
   */
  private evict(): void {
    const max = this.config.cacheSize;
    if (this.cache.size <= max) return;
    const now = Date.now();
    const idleMs = this.config.cacheIdleSeconds * 1000;
    const candidates = [...this.cache.values()]
      .filter((e) => e.busy === 0 && !e.doc.isDirty && !this.writing.has(e.id))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of candidates) {
      if (this.cache.size <= max) break;
      const idle = now - e.lastUsed >= idleMs;
      if (!idle && this.cache.size <= max * 4) break;
      this.cache.delete(e.id);
      if (e.doc.history.canUndo || e.doc.history.canRedo) this.unloaded.set(e.id, idle ? 'idle' : 'cap');
    }
  }

  /** Get a fresh document entry (reloads when another process changed the files). */
  private async entry(id: string): Promise<Entry> {
    const cached = this.cache.get(id);
    // our own save in progress changes the manifest mtime: that is not an external edit
    if (cached && this.writing.has(id)) return this.touch(cached);
    const disk = await this.store.manifestStamp(id);
    if (disk === null) {
      this.cache.delete(id);
      throw new PixelClausError(
        'NOT_FOUND',
        `Project '${id}' not found`,
        'It may have been deleted; list projects with project_list',
      );
    }
    const now = this.cache.get(id);
    if (now && (now.stamp === disk || this.writing.has(id))) return this.touch(now);
    let pending = this.loading.get(id);
    if (!pending) {
      pending = this.load(id, !!now).finally(() => this.loading.delete(id));
      this.loading.set(id, pending);
    }
    return this.touch(await pending);
  }

  private touch(e: Entry): Entry {
    e.lastUsed = Date.now();
    return e;
  }

  private async load(id: string, wasCached: boolean): Promise<Entry> {
    const loaded = await this.store.load(id, this.config.historyEntries);
    if (wasCached)
      this.addNotice(
        id,
        'Project files changed outside this session; reloaded the latest version (undo history was reset)',
      );
    else if (this.unloaded.has(id)) {
      this.addNotice(
        id,
        this.unloaded.get(id) === 'idle'
          ? `Undo history was cleared: the project was idle and unloaded from memory (unused for at least ${idleText(this.config.cacheIdleSeconds)} while more than ${this.config.cacheSize} projects were open)`
          : `Undo history was cleared: more than ${this.config.cacheSize * 4} projects were in use at once, so the least recently used ones were unloaded from memory (raise PIXELCLAUS_CACHE)`,
      );
    }
    this.unloaded.delete(id);
    for (const w of loaded.warnings) this.addNotice(id, w);
    const e: Entry = {
      id,
      doc: loaded.doc,
      manifest: loaded.manifest,
      stamp: loaded.stamp,
      lastUsed: Date.now(),
      busy: 0,
    };
    this.cache.set(id, e);
    this.evict();
    return e;
  }

  private addNotice(id: string, msg: string): void {
    const list = this.notices.get(id) ?? [];
    list.push(msg);
    this.notices.set(id, list);
  }

  private takeNotices(id: string): string[] {
    const n = this.notices.get(id) ?? [];
    this.notices.delete(id);
    return n;
  }

  private newManifest(): Omit<Manifest, 'state' | 'counters'> {
    return { format: 'pixelclaus-project', formatVersion: 1, revision: 1, checkpoints: [] };
  }

  /** Save a brand-new document under a freshly reserved id (released again if anything fails). */
  private async register(
    id: string,
    build: () => SpriteDocument,
  ): Promise<{ id: string; doc: SpriteDocument }> {
    let doc: SpriteDocument;
    const manifest = this.newManifest();
    let mt: string;
    try {
      doc = build();
      mt = await this.store.save(id, doc, manifest, true);
    } catch (err) {
      await this.store.releaseId(id);
      throw err;
    }
    this.cache.set(id, { id, doc, manifest, stamp: mt, lastUsed: Date.now(), busy: 0 });
    this.unloaded.delete(id);
    this.scheduleThumbnail(id, 0);
    this.evict();
    return { id, doc };
  }

  /**
   * Create a project. `ifExists`:
   * - 'suffix' (default for the service API): a taken id gets a suffix (hero-2);
   * - 'error' (default for the MCP tool): a name or id already in use is a CONFLICT, so agents never end
   *   up with an id they do not expect and never edit a project that merely has "their" name.
   */
  async create(
    opts: Omit<CreateDocumentOptions, 'id'>,
    options: { ifExists?: 'suffix' | 'error' } = {},
  ): Promise<{ id: string; doc: SpriteDocument }> {
    if (!opts.name?.trim()) throw new PixelClausError('INVALID_ARGUMENT', 'Project name is required');
    const slug = slugify(opts.name);
    let id: string;
    // names without any ASCII letters/digits all slugify to the fallback "sprite": they only conflict by name
    const fallbackSlug = slug === 'sprite' && slugify(`${opts.name}x`) === 'x';
    if (options.ifExists === 'error') {
      const name = opts.name.trim();
      const same = (await this.namesListing(true)).find(
        (p) => p.name.toLowerCase() === name.toLowerCase() || (!fallbackSlug && p.id === slug),
      );
      if (same) throw await this.conflict(name, same.id, same.name);
      if (fallbackSlug) id = await this.store.allocateId(slug);
      else if (await this.store.reserveId(slug))
        id = slug; // atomic: a concurrent create may have won
      else throw await this.conflict(name, slug, name);
    } else {
      id = await this.store.allocateId(slug);
    }
    this.listing = null;
    return this.register(id, () => createDocument({ ...opts, id }));
  }

  private async conflict(name: string, id: string, existingName: string): Promise<PixelClausError> {
    let alt = '';
    for (let i = 2; i < 100; i++) {
      const candidate = `${name} ${i}`;
      if (!(await this.store.exists(slugify(candidate)))) {
        alt = candidate;
        break;
      }
    }
    return new PixelClausError(
      'CONFLICT',
      `A project named '${existingName}' already exists (id '${id}')`,
      `If it is yours, keep working in it with project: "${id}". Otherwise create yours under another name${alt ? ` (e.g. "${alt}")` : ''}, or pass ifExists: "suffix" to get a new id automatically.`,
    );
  }

  /** Register an externally built snapshot (imports, duplicates) as a new project. */
  async adopt(snapshot: DocumentSnapshot, name: string): Promise<{ id: string; doc: SpriteDocument }> {
    const id = await this.store.allocateId(slugify(name));
    this.listing = null;
    return this.register(id, () => {
      snapshot.state.id = id;
      snapshot.state.name = name;
      const now = new Date().toISOString();
      snapshot.state.created = snapshot.state.created || now;
      snapshot.state.modified = now;
      return new SpriteDocument(snapshot, { maxEntries: this.config.historyEntries });
    });
  }

  /** Read-only access. Runs alongside other readers and other projects' mutations. */
  async read<T>(
    ref: string,
    fn: (doc: SpriteDocument, id: string) => T | Promise<T>,
  ): Promise<{ value: T; id: string; revision: number; notices: string[] }> {
    const id = await this.resolveId(ref);
    const e = await this.entry(id);
    e.busy++;
    try {
      const value = await fn(e.doc, id);
      return { value, id, revision: e.manifest.revision, notices: this.takeNotices(id) };
    } finally {
      e.busy--;
    }
  }

  /**
   * Exclusive access to one project (mutations, checkpoints); other projects are not affected. The
   * entry is fetched (and reloaded if another process changed it) before the project is marked as
   * being written, so readers then trust this process's in-flight save instead of reloading.
   */
  private exclusive<T>(id: string, fn: (e: Entry) => Promise<T>): Promise<T> {
    return this.mutex.run(id, async () => {
      // other processes sharing the data dir: hold the project's lock file from load to save, so their
      // edits are applied one after another (reloading in between) instead of overwriting each other
      const release = await this.store.lock(id);
      try {
        const e = await this.entry(id);
        this.writing.add(id);
        e.busy++;
        try {
          return await fn(e);
        } finally {
          e.busy--;
          this.writing.delete(id);
        }
      } finally {
        await release();
      }
    });
  }

  /** Mutate a project and autosave. Warnings from the document are returned. */
  async mutate<T>(
    ref: string,
    fn: (doc: SpriteDocument, id: string) => T | Promise<T>,
  ): Promise<MutationResult<T> & { id: string }> {
    const id = await this.resolveId(ref);
    return this.exclusive(id, async (e) => {
      e.doc.drainWarnings();
      const before = e.doc.revision;
      let value: T;
      try {
        value = await fn(e.doc, id);
      } catch (err) {
        e.doc.drainWarnings();
        throw err;
      }
      const warnings = [...this.takeNotices(id), ...e.doc.drainWarnings()];
      const changed = e.doc.revision !== before || e.doc.isDirty;
      if (changed) await this.persist(e);
      return { value, warnings, revision: e.manifest.revision, changed, id };
    });
  }

  private async persist(e: Entry, full = false): Promise<void> {
    const disk = await this.store.manifestStamp(e.id);
    if (disk !== null && disk !== e.stamp) {
      // Another process wrote in between; our in-memory doc wins but tell the agent.
      this.addNotice(
        e.id,
        'Warning: the project was also modified by another process; this session overwrote it',
      );
    }
    e.manifest.revision++;
    try {
      e.stamp = await this.store.save(e.id, e.doc, e.manifest, full);
    } catch (err) {
      e.doc.markAllDirty();
      throw err;
    }
    this.scheduleThumbnail(e.id);
  }

  // ─── thumbnails ───

  private scheduleThumbnail(id: string, delayMs = THUMBNAIL_DEBOUNCE_MS): void {
    if (this.thumbTimers.has(id)) return;
    const t = setTimeout(() => {
      this.thumbTimers.delete(id);
      void this.writeThumbnail(id).catch(() => undefined);
    }, delayMs);
    t.unref();
    this.thumbTimers.set(id, t);
  }

  /** Render frame 0 on the compute pool and write thumbnail.png (≤ 128 px). */
  async writeThumbnail(id: string): Promise<void> {
    const prev = this.thumbInflight.get(id);
    if (prev) await prev.catch(() => undefined);
    const run = this.renderThumbnail(id).finally(() => {
      if (this.thumbInflight.get(id) === run) this.thumbInflight.delete(id);
    });
    this.thumbInflight.set(id, run);
    return run;
  }

  private async renderThumbnail(id: string): Promise<void> {
    const e = this.cache.get(id);
    if (!e) return;
    const { payload, transfer } = docPayload(e.doc, { frames: [0] });
    const r = await this.compute.run(
      { kind: 'frame', doc: payload, req: { frame: 0, includeReference: false, fit: 128, level: 6 } },
      transfer,
      3, // background: never delays an agent's previews or exports
    );
    await this.store.writeThumbnailPng(id, r.png);
  }

  /** Write pending thumbnails now (shutdown, tests). */
  async flushThumbnails(): Promise<void> {
    const ids = [...this.thumbTimers.keys()];
    for (const id of ids) clearTimeout(this.thumbTimers.get(id));
    this.thumbTimers.clear();
    await Promise.all(ids.map((id) => this.writeThumbnail(id).catch(() => undefined)));
  }

  async delete(ref: string): Promise<string> {
    const id = await this.resolveId(ref);
    return this.mutex.run(id, async () => {
      clearTimeout(this.thumbTimers.get(id));
      this.thumbTimers.delete(id);
      this.cache.delete(id); // no new thumbnail can start for it
      await this.thumbInflight.get(id)?.catch(() => undefined);
      await this.store.lock(id); // wait for another process's save; the folder (and lock) go away
      await this.store.delete(id);
      this.cache.delete(id);
      this.unloaded.delete(id);
      this.listing = null;
      return id;
    });
  }

  async duplicate(ref: string, name?: string): Promise<{ id: string; doc: SpriteDocument }> {
    const { value: snap, id } = await this.read(ref, (doc) => doc.snapshot());
    return this.adopt(snap, name ?? `${snap.state.name} copy`).then((r) => ({ ...r, from: id }));
  }

  // ─── checkpoints ───

  async createCheckpoint(ref: string, name?: string): Promise<CheckpointInfo> {
    const id = await this.resolveId(ref);
    return this.exclusive(id, (e) => this.addCheckpoint(e, name));
  }

  /** Snapshot the entry into a new checkpoint (caller holds the project's lock). */
  private async addCheckpoint(e: Entry, name?: string): Promise<CheckpointInfo> {
    const cpId = `cp-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
    const cpName = (name ?? `checkpoint ${e.manifest.checkpoints.length + 1}`).trim();
    if (!cpName)
      throw new PixelClausError(
        'INVALID_ARGUMENT',
        'Checkpoint name is empty',
        'Give a short name like "before-shading", or omit name',
      );
    if (e.manifest.checkpoints.some((c) => c.name === cpName)) {
      throw new PixelClausError(
        'INVALID_ARGUMENT',
        `Checkpoint '${cpName}' already exists`,
        'Pick another name or delete the old one',
      );
    }
    // compress on the compute pool: big projects take hundreds of ms to deflate
    const { payload, transfer } = fullPayload(e.doc);
    const encoded = await this.compute.run({ kind: 'pxc-encode', doc: payload }, transfer);
    const bytes = await this.store.writeCheckpoint(e.id, cpId, encoded.bytes);
    const info: CheckpointInfo = {
      id: cpId,
      name: cpName,
      created: new Date().toISOString(),
      revision: e.manifest.revision,
      bytes,
    };
    e.manifest.checkpoints.push(info);
    e.doc.markMetaDirty();
    await this.persist(e);
    return info;
  }

  async listCheckpoints(ref: string): Promise<CheckpointInfo[]> {
    const e = await this.entry(await this.resolveId(ref));
    return [...e.manifest.checkpoints];
  }

  private findCheckpoint(e: Entry, ref: string): CheckpointInfo {
    const cp =
      e.manifest.checkpoints.find((c) => c.id === ref || c.name === ref) ??
      e.manifest.checkpoints.find((c) => c.name.toLowerCase() === ref.toLowerCase());
    if (!cp)
      throw notFound(
        'checkpoint',
        ref,
        e.manifest.checkpoints.map((c) => c.name),
      );
    return cp;
  }

  /**
   * Restore a checkpoint. Validation, the automatic backup and the replacement happen under one lock,
   * so a change another agent makes in between always ends up in the backup or after the restore.
   */
  async restoreCheckpoint(
    ref: string,
    cpRef: string,
  ): Promise<{ restored: CheckpointInfo; backup: CheckpointInfo }> {
    const id = await this.resolveId(ref);
    const result = await this.exclusive(id, async (e) => {
      // read + decode first so a typo, missing or corrupt file leaves no stray backup behind
      const cp = this.findCheckpoint(e, cpRef);
      const snap = await this.readCheckpointFile(id, cp);
      const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 15);
      const backup = await this.addCheckpoint(
        e,
        `auto-before-restore-${stamp}-${randomBytes(2).toString('hex')}`,
      );
      snap.state.id = id;
      e.doc.replaceWith(snap, `Restore checkpoint ${cp.name}`);
      await this.persist(e, true);
      return { restored: cp, backup };
    });
    this.scheduleThumbnail(id, 0);
    return result;
  }

  private async readCheckpointFile(id: string, cp: CheckpointInfo): Promise<DocumentSnapshot> {
    let bytes: Uint8Array;
    try {
      bytes = await this.store.readCheckpointBytes(id, cp.id);
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      throw new PixelClausError(
        missing ? 'NOT_FOUND' : 'INVALID_ARGUMENT',
        `Checkpoint '${cp.name}' ${missing ? 'file is missing' : 'file is unreadable'}; nothing was changed`,
        'Delete this checkpoint (checkpoint action "delete") and restore another one',
      );
    }
    try {
      const decoded = await this.compute.run({ kind: 'pxc-decode', bytes }, [bytes.buffer as ArrayBuffer]);
      return payloadSnapshot(decoded.doc);
    } catch {
      throw new PixelClausError(
        'INVALID_ARGUMENT',
        `Checkpoint '${cp.name}' file is unreadable; nothing was changed`,
        'Delete this checkpoint (checkpoint action "delete") and restore another one',
      );
    }
  }

  async deleteCheckpoint(ref: string, cpRef: string): Promise<CheckpointInfo> {
    const id = await this.resolveId(ref);
    return this.exclusive(id, async (e) => {
      const cp = this.findCheckpoint(e, cpRef);
      await this.store.deleteCheckpoint(id, cp.id);
      e.manifest.checkpoints = e.manifest.checkpoints.filter((c) => c.id !== cp.id);
      e.doc.markMetaDirty();
      await this.persist(e);
      return cp;
    });
  }

  /** Undo/redo (history lives in memory per process). */
  async history(
    ref: string,
    action: 'undo' | 'redo',
    steps = 1,
  ): Promise<MutationResult<string[]> & { id: string }> {
    return this.mutate(ref, (doc) => (action === 'undo' ? doc.undo(steps) : doc.redo(steps)));
  }
}
