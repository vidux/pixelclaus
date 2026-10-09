import { PixelBuffer, diffBounds } from '../buffer/pixel-buffer.js';
import { Mask } from '../buffer/mask.js';
import { PixelClausError } from '../errors.js';
import { cloneJson } from '../util/geometry.js';
import { History, patchBytes, type HistoryEntry, type HistoryLimits, type ImagePatch } from './history.js';
import type { SpriteState } from './types.js';

export interface IdCounters {
  layer: number;
  image: number;
  mask: number;
}

export interface DocumentSnapshot {
  state: SpriteState;
  images: Map<string, PixelBuffer>;
  masks: Map<string, Mask>;
  counters: IdCounters;
}

export type ChangeKind = 'commit' | 'undo' | 'redo' | 'replace';

export interface ChangeEvent {
  kind: ChangeKind;
  label: string;
  revision: number;
  structural: boolean;
  imageIds: string[];
}

export interface DirtySet {
  meta: boolean;
  images: Set<string>;
  masks: Set<string>;
}

/** Serialise state for history comparison, ignoring the volatile `modified` timestamp. */
function metaJson(state: SpriteState): string {
  return JSON.stringify(state, (k, v) => (k === 'modified' ? undefined : v));
}

/**
 * Mutation scope. Obtain via `doc.transact()`. All pixel writes must go through `writeImage()` so the
 * original content is backed up for undo and rollback.
 */
export class Transaction {
  readonly label: string;
  private readonly doc: SpriteDocument;
  private readonly metaBefore: string;
  private readonly backups = new Map<string, PixelBuffer>();
  private readonly created = new Set<string>();
  private readonly createdMasks = new Set<string>();

  constructor(doc: SpriteDocument, label: string) {
    this.doc = doc;
    this.label = label;
    this.metaBefore = metaJson(doc.state);
  }

  get state(): SpriteState {
    return this.doc.state;
  }

  get document(): SpriteDocument {
    return this.doc;
  }

  /** Get an image for writing (backs it up on first access). */
  writeImage(id: string): PixelBuffer {
    const img = this.doc.image(id);
    if (!this.created.has(id) && !this.backups.has(id)) this.backups.set(id, img.clone());
    return img;
  }

  /** Swap an image's buffer (e.g. resize). */
  replaceImage(id: string, buf: PixelBuffer): void {
    const old = this.doc.image(id);
    if (!this.created.has(id) && !this.backups.has(id)) this.backups.set(id, old.clone());
    this.doc.images.set(id, buf);
  }

  createImage(width: number, height: number, data?: Uint32Array): string {
    const id = this.doc.nextId('image');
    this.doc.images.set(id, new PixelBuffer(width, height, data));
    this.created.add(id);
    return id;
  }

  adoptImage(buf: PixelBuffer): string {
    const id = this.doc.nextId('image');
    this.doc.images.set(id, buf);
    this.created.add(id);
    return id;
  }

  createMask(mask: Mask): string {
    const id = this.doc.nextId('mask');
    this.doc.masks.set(id, mask);
    this.createdMasks.add(id);
    return id;
  }

  warn(message: string): void {
    this.doc.addWarning(message);
  }

  /** @internal */
  commit(): HistoryEntry | null {
    const metaAfter = metaJson(this.doc.state);
    const structural = metaAfter !== this.metaBefore;
    const patches: ImagePatch[] = [];
    for (const [id, before] of this.backups) {
      const after = this.doc.images.get(id);
      if (!after) continue;
      if (after.width !== before.width || after.height !== before.height) {
        // own a copy: the live buffer keeps changing after this transaction
        patches.push({ kind: 'replace', imageId: id, before, after: after.clone() });
        continue;
      }
      const r = diffBounds(before, after);
      if (!r) continue;
      patches.push({
        kind: 'region',
        imageId: id,
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        before: before.crop(r).data,
        after: after.crop(r).data,
      });
    }
    const touchedImages = [...patches.map((p) => p.imageId), ...this.created];
    for (const id of touchedImages) this.doc.markImageDirty(id);
    for (const id of this.createdMasks) this.doc.markMaskDirty(id);
    if (!structural && patches.length === 0) {
      if (this.created.size || this.createdMasks.size) this.doc.markMetaDirty();
      return null;
    }
    this.doc.markMetaDirty();
    const entry = this.doc.history.push({
      label: this.label,
      time: new Date().toISOString(),
      metaBefore: structural ? this.metaBefore : null,
      metaAfter: structural ? metaAfter : null,
      patches,
      bytes:
        patches.reduce((n, p) => n + patchBytes(p), 0) +
        (structural ? (this.metaBefore.length + metaAfter.length) * 2 : 0),
    });
    this.doc.bump('commit', this.label, structural, touchedImages);
    return entry;
  }

  /** @internal Restore everything touched by this transaction. */
  rollback(): void {
    for (const [id, before] of this.backups) this.doc.images.set(id, before);
    for (const id of this.created) this.doc.images.delete(id);
    for (const id of this.createdMasks) this.doc.masks.delete(id);
    this.doc.restoreMeta(this.metaBefore);
  }
}

/**
 * A sprite document: metadata state + image/mask stores + undo history.
 * This is the central object a UI or the MCP server manipulates through commands in `ops/`.
 */
export class SpriteDocument {
  state: SpriteState;
  readonly images: Map<string, PixelBuffer>;
  readonly masks: Map<string, Mask>;
  readonly history: History;
  counters: IdCounters;
  revision = 0;

  private activeTx: Transaction | null = null;
  private listeners = new Set<(e: ChangeEvent) => void>();
  private warnings: string[] = [];
  private dirty: DirtySet = { meta: false, images: new Set(), masks: new Set() };

  constructor(snapshot: DocumentSnapshot, historyLimits?: Partial<HistoryLimits>) {
    this.state = snapshot.state;
    this.images = snapshot.images;
    this.masks = snapshot.masks;
    this.counters = { ...snapshot.counters };
    this.history = new History(historyLimits);
  }

  get inTransaction(): boolean {
    return this.activeTx !== null;
  }

  /**
   * Run `fn` as one undoable step. Nested calls join the outer transaction. Throwing inside `fn`
   * rolls back every change made by the (outermost) transaction.
   */
  transact<T>(label: string, fn: (tx: Transaction) => T): T {
    if (this.activeTx) return fn(this.activeTx);
    const tx = new Transaction(this, label);
    this.activeTx = tx;
    try {
      const result = fn(tx);
      this.activeTx = null;
      tx.commit();
      return result;
    } catch (e) {
      this.activeTx = null;
      tx.rollback();
      throw e;
    }
  }

  undo(steps = 1): string[] {
    this.assertNoTx();
    const labels: string[] = [];
    for (let i = 0; i < steps; i++) {
      const e = this.history.popUndo();
      if (!e) break;
      this.applyEntry(e, 'before');
      labels.push(e.label);
      this.bump(
        'undo',
        e.label,
        e.metaBefore !== null,
        e.patches.map((p) => p.imageId),
      );
    }
    return labels;
  }

  redo(steps = 1): string[] {
    this.assertNoTx();
    const labels: string[] = [];
    for (let i = 0; i < steps; i++) {
      const e = this.history.popRedo();
      if (!e) break;
      this.applyEntry(e, 'after');
      labels.push(e.label);
      this.bump(
        'redo',
        e.label,
        e.metaAfter !== null,
        e.patches.map((p) => p.imageId),
      );
    }
    return labels;
  }

  private applyEntry(e: HistoryEntry, side: 'before' | 'after'): void {
    const patches = side === 'before' ? [...e.patches].reverse() : e.patches;
    for (const p of patches) {
      if (p.kind === 'replace') {
        // hand out a copy so later in-place edits never mutate the history entry
        this.images.set(p.imageId, (side === 'before' ? p.before : p.after).clone());
      } else {
        const img = this.images.get(p.imageId);
        if (!img) continue;
        const src = side === 'before' ? p.before : p.after;
        for (let y = 0; y < p.h; y++) {
          img.data.set(src.subarray(y * p.w, (y + 1) * p.w), (p.y + y) * img.width + p.x);
        }
      }
      this.markImageDirty(p.imageId);
    }
    const meta = side === 'before' ? e.metaBefore : e.metaAfter;
    if (meta) this.restoreMeta(meta);
    this.markMetaDirty();
  }

  /** @internal */
  restoreMeta(json: string): void {
    const modified = this.state.modified;
    this.state = JSON.parse(json) as SpriteState;
    this.state.modified = modified;
  }

  private assertNoTx(): void {
    if (this.activeTx) throw new PixelClausError('CONFLICT', 'Cannot undo/redo inside a transaction');
  }

  /** @internal */
  bump(kind: ChangeKind, label: string, structural: boolean, imageIds: string[]): void {
    this.revision++;
    this.state.modified = new Date().toISOString();
    const ev: ChangeEvent = { kind, label, revision: this.revision, structural, imageIds };
    for (const l of this.listeners) l(ev);
  }

  /** Replace the whole document content (checkpoint restore). Clears history. */
  replaceWith(snapshot: DocumentSnapshot, label = 'Restore'): void {
    this.assertNoTx();
    this.state = snapshot.state;
    this.images.clear();
    for (const [k, v] of snapshot.images) this.images.set(k, v);
    this.masks.clear();
    for (const [k, v] of snapshot.masks) this.masks.set(k, v);
    this.counters = {
      layer: Math.max(this.counters.layer, snapshot.counters.layer),
      image: Math.max(this.counters.image, snapshot.counters.image),
      mask: Math.max(this.counters.mask, snapshot.counters.mask),
    };
    this.history.clear();
    this.markAllDirty();
    this.bump('replace', label, true, [...this.images.keys()]);
  }

  onChange(listener: (e: ChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  nextId(kind: keyof IdCounters): string {
    const n = ++this.counters[kind];
    const prefix = kind === 'layer' ? 'L' : kind === 'image' ? 'i' : 'm';
    return `${prefix}${n}`;
  }

  image(id: string): PixelBuffer {
    const img = this.images.get(id);
    if (!img) throw new PixelClausError('INTERNAL', `Image ${id} missing from store`);
    return img;
  }

  mask(id: string): Mask {
    const m = this.masks.get(id);
    if (!m) throw new PixelClausError('INTERNAL', `Mask ${id} missing from store`);
    return m;
  }

  addWarning(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  drainWarnings(): string[] {
    const w = this.warnings;
    this.warnings = [];
    return w;
  }

  markImageDirty(id: string): void {
    this.dirty.images.add(id);
  }

  markMaskDirty(id: string): void {
    this.dirty.masks.add(id);
  }

  markMetaDirty(): void {
    this.dirty.meta = true;
  }

  markAllDirty(): void {
    this.dirty.meta = true;
    for (const id of this.images.keys()) this.dirty.images.add(id);
    for (const id of this.masks.keys()) this.dirty.masks.add(id);
  }

  get isDirty(): boolean {
    return this.dirty.meta || this.dirty.images.size > 0 || this.dirty.masks.size > 0;
  }

  takeDirty(): DirtySet {
    const d = this.dirty;
    this.dirty = { meta: false, images: new Set(), masks: new Set() };
    return d;
  }

  referencedImageIds(): Set<string> {
    const s = new Set<string>();
    for (const c of this.state.cels) s.add(c.imageId);
    for (const c of Object.values(this.state.clipboards)) s.add(c.imageId);
    return s;
  }

  referencedMaskIds(): Set<string> {
    return new Set(Object.values(this.state.selections));
  }

  /** Deep copy of the current content (referenced images/masks only). */
  snapshot(): DocumentSnapshot {
    const images = new Map<string, PixelBuffer>();
    for (const id of this.referencedImageIds()) {
      const img = this.images.get(id);
      if (img) images.set(id, img.clone());
    }
    const masks = new Map<string, Mask>();
    for (const id of this.referencedMaskIds()) {
      const m = this.masks.get(id);
      if (m) masks.set(id, m.clone());
    }
    return { state: cloneJson(this.state), images, masks, counters: { ...this.counters } };
  }

  /** Drop images/masks not referenced by the current state or history. Only call when history is empty. */
  collectGarbage(): number {
    if (this.history.canUndo || this.history.canRedo) return 0;
    const imgs = this.referencedImageIds();
    const masks = this.referencedMaskIds();
    let n = 0;
    for (const id of [...this.images.keys()]) {
      if (imgs.has(id)) continue;
      this.images.delete(id);
      n++;
    }
    for (const id of [...this.masks.keys()]) {
      if (masks.has(id)) continue;
      this.masks.delete(id);
      n++;
    }
    return n;
  }
}
