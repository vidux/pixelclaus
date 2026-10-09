/**
 * Timeline commands: add/duplicate/remove/move/reverse frames, durations.
 */
import { invalidArg, PixelClausError } from '../errors.js';
import type { SpriteDocument, Transaction } from '../model/document.js';
import { assertFrame, getCel } from '../model/lookup.js';
import { MAX_DOC_PIXELS, MAX_FRAMES, type CelState } from '../model/types.js';

export type NewCelMode = 'empty' | 'copy' | 'link';

export interface AddFramesOptions {
  /** Insert position (new frames get indices at..at+count-1). Default: end. */
  at?: number;
  count?: number;
  /** Duration of new frames (ms). Default: duration of the source frame or 100. */
  duration?: number;
  /** What new frames contain. Default 'empty' (continuous layers always link). */
  cels?: NewCelMode;
  /** Frame to copy/link from. Default: the frame before the insert position. */
  source?: number;
}

function shiftForInsert(tx: Transaction, at: number, count: number): void {
  const st = tx.state;
  for (const c of st.cels) if (c.frame >= at) c.frame += count;
  for (const t of st.tags) {
    if (t.from >= at) t.from += count;
    if (t.to >= at) t.to += count;
  }
  for (const s of st.slices) for (const k of s.keys) if (k.frame >= at && k.frame > 0) k.frame += count;
}

function cloneCel(tx: Transaction, src: CelState, frame: number, mode: 'copy' | 'link'): CelState {
  const imageId = mode === 'link' ? src.imageId : tx.adoptImage(tx.document.image(src.imageId).clone());
  return { ...src, frame, imageId };
}

export function addFrames(doc: SpriteDocument, opts: AddFramesOptions = {}): number[] {
  const st = doc.state;
  const count = opts.count ?? 1;
  if (!Number.isInteger(count) || count < 1) throw invalidArg('count must be a positive integer');
  if (st.frames.length + count > MAX_FRAMES)
    throw new PixelClausError('LIMIT', `Maximum of ${MAX_FRAMES} frames`);
  const at = opts.at ?? st.frames.length;
  if (!Number.isInteger(at) || at < 0 || at > st.frames.length)
    throw invalidArg(`at must be 0..${st.frames.length}`);
  const source = opts.source ?? (at > 0 ? at - 1 : 0);
  if (opts.source !== undefined) assertFrame(st, opts.source);
  const mode = opts.cels ?? 'empty';
  if (mode === 'copy') {
    // copies allocate new images: refuse before allocating if the project would exceed its budget
    const perFrame = st.cels
      .filter((c) => c.frame === source)
      .reduce((n, c) => n + doc.image(c.imageId).width * doc.image(c.imageId).height, 0);
    const current = [...doc.referencedImageIds()].reduce(
      (n, id) => n + doc.image(id).width * doc.image(id).height,
      0,
    );
    if (current + perFrame * count > MAX_DOC_PIXELS) {
      throw new PixelClausError(
        'LIMIT',
        `Copying ${count} frame(s) would grow the project to ${Math.round((current + perFrame * count) / 1e6)} Mpx (max ${MAX_DOC_PIXELS / 2 ** 20} Mpx)`,
        'Add frames with cels "link" or "empty", or split the animation into several projects',
      );
    }
  }
  return doc.transact(`Add ${count} frame(s) at ${at}`, (tx) => {
    const srcDuration = st.frames[Math.min(source, st.frames.length - 1)]?.duration ?? 100;
    const srcCels = st.cels.filter((c) => c.frame === source).map((c) => ({ ...c }));
    const srcShifted = source >= at ? source + count : source;
    shiftForInsert(tx, at, count);
    st.frames.splice(
      at,
      0,
      ...Array.from({ length: count }, () => ({ duration: opts.duration ?? srcDuration })),
    );
    const continuous = new Set(st.layers.filter((l) => l.continuous).map((l) => l.id));
    for (let k = 0; k < count; k++) {
      const f = at + k;
      for (const c of srcCels) {
        const live = getCel(st, c.layerId, srcShifted) ?? c;
        if (mode === 'copy') st.cels.push(cloneCel(tx, live, f, 'copy'));
        else if (mode === 'link' || continuous.has(c.layerId)) st.cels.push(cloneCel(tx, live, f, 'link'));
      }
    }
    return Array.from({ length: count }, (_, k) => at + k);
  });
}

export function duplicateFrame(
  doc: SpriteDocument,
  frame: number,
  opts: { count?: number; link?: boolean } = {},
): number[] {
  assertFrame(doc.state, frame);
  return addFrames(doc, {
    at: frame + 1,
    count: opts.count ?? 1,
    source: frame,
    cels: opts.link ? 'link' : 'copy',
  });
}

export function removeFrames(doc: SpriteDocument, frames: readonly number[]): number {
  const st = doc.state;
  frames.forEach((f) => assertFrame(st, f));
  const del = [...new Set(frames)].sort((a, b) => a - b);
  if (del.length >= st.frames.length)
    throw invalidArg('Cannot remove every frame; a sprite needs at least one');
  return doc.transact(`Remove ${del.length} frame(s)`, (tx) => {
    const s = tx.state;
    const set = new Set(del);
    const newIndex = (f: number) => f - del.filter((d) => d < f).length;
    s.cels = s.cels.filter((c) => !set.has(c.frame));
    for (const c of s.cels) c.frame = newIndex(c.frame);
    s.frames = s.frames.filter((_, i) => !set.has(i));
    s.tags = s.tags
      .map((t) => {
        const kept = [];
        for (let f = t.from; f <= t.to; f++) if (!set.has(f)) kept.push(newIndex(f));
        return kept.length ? { ...t, from: Math.min(...kept), to: Math.max(...kept) } : null;
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
    for (const sl of s.slices) {
      sl.keys = sl.keys
        .filter((k) => !set.has(k.frame) || k.frame === 0)
        .map((k) => ({ ...k, frame: set.has(k.frame) ? 0 : newIndex(k.frame) }));
    }
    return del.length;
  });
}

/** Reorder by an explicit permutation: order[i] = old index of the frame that ends up at i. */
function applyOrder(tx: Transaction, order: number[]): void {
  const s = tx.state;
  const inv = new Map<number, number>();
  order.forEach((old, ni) => inv.set(old, ni));
  s.frames = order.map((old) => s.frames[old]!);
  for (const c of s.cels) c.frame = inv.get(c.frame)!;
  for (const sl of s.slices) for (const k of sl.keys) k.frame = inv.get(k.frame) ?? k.frame;
}

export function moveFrame(doc: SpriteDocument, from: number, to: number): void {
  const st = doc.state;
  assertFrame(st, from);
  assertFrame(st, to);
  if (from === to) return;
  doc.transact(`Move frame ${from} → ${to}`, (tx) => {
    const order = st.frames.map((_, i) => i);
    order.splice(from, 1);
    order.splice(to, 0, from);
    applyOrder(tx, order);
  });
}

export function reverseFrames(doc: SpriteDocument, from: number, to: number): void {
  const st = doc.state;
  assertFrame(st, from);
  assertFrame(st, to);
  if (to <= from) throw invalidArg('reverse needs from < to');
  doc.transact(`Reverse frames ${from}..${to}`, (tx) => {
    const order = st.frames.map((_, i) => i);
    const seg = order.slice(from, to + 1).reverse();
    order.splice(from, seg.length, ...seg);
    applyOrder(tx, order);
  });
}

export interface DurationSpec {
  /** Same duration (ms) for all frames given. */
  duration?: number;
  /** Frames per second → duration = round(1000/fps). */
  fps?: number;
  /** Per-frame durations, aligned with `frames`. */
  durations?: readonly number[];
}

export function setDurations(doc: SpriteDocument, frames: readonly number[], spec: DurationSpec): void {
  const st = doc.state;
  frames.forEach((f) => assertFrame(st, f));
  const list = spec.durations
    ? spec.durations
    : frames.map(() => (spec.fps ? Math.round(1000 / spec.fps) : spec.duration));
  if (spec.durations && spec.durations.length !== frames.length) {
    throw invalidArg(
      `durations has ${spec.durations.length} values but ${frames.length} frame(s) were selected`,
    );
  }
  list.forEach((d) => {
    if (d === undefined || !Number.isFinite(d) || d < 1 || d > 65535)
      throw invalidArg('Durations must be 1..65535 ms (give duration, fps or durations)');
  });
  doc.transact(`Set duration of ${frames.length} frame(s)`, (tx) => {
    frames.forEach((f, i) => (tx.state.frames[f]!.duration = Math.round(list[i]!)));
  });
}

export function setFrameNotes(doc: SpriteDocument, frame: number, notes: string): void {
  assertFrame(doc.state, frame);
  doc.transact(`Notes frame ${frame}`, (tx) => {
    tx.state.frames[frame]!.notes = notes;
  });
}
