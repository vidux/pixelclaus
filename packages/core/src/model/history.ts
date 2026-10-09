import type { PixelBuffer } from '../buffer/pixel-buffer.js';

/** Changed sub-rectangle of an image, or a whole-image replacement (size change / new buffer). */
export type ImagePatch =
  | {
      kind: 'region';
      imageId: string;
      x: number;
      y: number;
      w: number;
      h: number;
      before: Uint32Array;
      after: Uint32Array;
    }
  | {
      kind: 'replace';
      imageId: string;
      before: PixelBuffer;
      after: PixelBuffer;
    };

export interface HistoryEntry {
  id: number;
  label: string;
  time: string;
  /** JSON of SpriteState before / after (null when metadata did not change). */
  metaBefore: string | null;
  metaAfter: string | null;
  patches: ImagePatch[];
  /** Approximate memory footprint in bytes. */
  bytes: number;
}

export interface HistoryLimits {
  maxEntries: number;
  maxBytes: number;
}

export const DEFAULT_HISTORY_LIMITS: HistoryLimits = { maxEntries: 300, maxBytes: 96 * 1024 * 1024 };

export function patchBytes(p: ImagePatch): number {
  return p.kind === 'region'
    ? p.before.byteLength + p.after.byteLength
    : p.before.data.byteLength + p.after.data.byteLength;
}

/** Linear undo/redo stacks with memory limits. */
export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private nextId = 1;
  private bytes = 0;
  readonly limits: HistoryLimits;

  constructor(limits: Partial<HistoryLimits> = {}) {
    this.limits = { ...DEFAULT_HISTORY_LIMITS, ...limits };
  }

  push(entry: Omit<HistoryEntry, 'id'>): HistoryEntry {
    const e: HistoryEntry = { ...entry, id: this.nextId++ };
    this.undoStack.push(e);
    this.bytes += e.bytes;
    for (const r of this.redoStack) this.bytes -= r.bytes;
    this.redoStack = [];
    this.prune();
    return e;
  }

  private prune(): void {
    while (
      this.undoStack.length > 1 &&
      (this.undoStack.length > this.limits.maxEntries || this.bytes > this.limits.maxBytes)
    ) {
      const old = this.undoStack.shift()!;
      this.bytes -= old.bytes;
    }
  }

  popUndo(): HistoryEntry | undefined {
    const e = this.undoStack.pop();
    if (e) this.redoStack.push(e);
    return e;
  }

  popRedo(): HistoryEntry | undefined {
    const e = this.redoStack.pop();
    if (e) this.undoStack.push(e);
    return e;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoCount(): number {
    return this.undoStack.length;
  }

  get redoCount(): number {
    return this.redoStack.length;
  }

  get memoryBytes(): number {
    return this.bytes;
  }

  /** Most recent first. */
  listUndo(limit = 20): Array<Pick<HistoryEntry, 'id' | 'label' | 'time'>> {
    return this.undoStack
      .slice(-limit)
      .reverse()
      .map(({ id, label, time }) => ({ id, label, time }));
  }

  listRedo(limit = 20): Array<Pick<HistoryEntry, 'id' | 'label' | 'time'>> {
    return this.redoStack
      .slice(-limit)
      .reverse()
      .map(({ id, label, time }) => ({ id, label, time }));
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.bytes = 0;
  }
}
