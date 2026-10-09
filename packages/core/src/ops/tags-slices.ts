/**
 * Animation tags and slices (9-patch / pivot regions).
 */
import { invalidArg, notFound } from '../errors.js';
import type { SpriteDocument } from '../model/document.js';
import { assertFrame, resolveTag } from '../model/lookup.js';
import {
  TAG_DIRECTIONS,
  type SliceKey,
  type SliceState,
  type TagDirection,
  type TagState,
} from '../model/types.js';
import type { Point, Rect } from '../util/geometry.js';

const TAG_COLORS = ['#e05252', '#e0a052', '#d4d452', '#52e052', '#52d4d4', '#5252e0', '#a052e0', '#e052a0'];

export interface TagInput {
  name: string;
  from: number;
  to: number;
  direction?: TagDirection;
  repeat?: number;
  color?: string;
  notes?: string;
}

const HEX6 = /^#[0-9a-fA-F]{6}$/;

function validateColor(c: string | undefined): void {
  if (c !== undefined && !HEX6.test(c)) throw invalidArg(`Invalid colour '${c}'`, 'Use "#rrggbb"');
}

function validateTag(
  doc: SpriteDocument,
  t: { from: number; to: number; direction?: string; repeat?: number; color?: string },
): void {
  validateColor(t.color);
  assertFrame(doc.state, t.from);
  assertFrame(doc.state, t.to);
  if (t.to < t.from) throw invalidArg(`Tag range ${t.from}..${t.to} is reversed`);
  if (t.direction && !TAG_DIRECTIONS.includes(t.direction as TagDirection)) {
    throw invalidArg(`Unknown direction '${t.direction}'`, `Use ${TAG_DIRECTIONS.join(', ')}`);
  }
  if (t.repeat !== undefined && (!Number.isInteger(t.repeat) || t.repeat < 0 || t.repeat > 65535)) {
    throw invalidArg('repeat must be an integer 0..65535 (0 = loop forever)');
  }
}

export function addTag(doc: SpriteDocument, t: TagInput): TagState {
  const name = t.name.trim();
  if (!name) throw invalidArg('Tag name cannot be empty');
  if (doc.state.tags.some((x) => x.name === name))
    throw invalidArg(`Tag '${name}' already exists`, 'Use tag action "update" to change it');
  validateTag(doc, t);
  return doc.transact(`Add tag ${name}`, (tx) => {
    const tag: TagState = {
      name,
      from: t.from,
      to: t.to,
      direction: t.direction ?? 'forward',
      repeat: t.repeat ?? 0,
      color: t.color ?? TAG_COLORS[tx.state.tags.length % TAG_COLORS.length]!,
      ...(t.notes ? { notes: t.notes } : {}),
    };
    tx.state.tags.push(tag);
    tx.state.tags.sort((a, b) => a.from - b.from);
    return tag;
  });
}

export function updateTag(
  doc: SpriteDocument,
  name: string,
  patch: Partial<TagInput> & { newName?: string },
): TagState {
  const cur = resolveTag(doc.state, name);
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as typeof patch;
  const next = { ...cur, ...defined };
  validateTag(doc, next);
  if (patch.newName && patch.newName !== cur.name && doc.state.tags.some((x) => x.name === patch.newName)) {
    throw invalidArg(`Tag '${patch.newName}' already exists`);
  }
  return doc.transact(`Update tag ${name}`, (tx) => {
    const t = tx.state.tags.find((x) => x.name === cur.name)!;
    if (patch.newName) t.name = patch.newName.trim();
    if (patch.from !== undefined) t.from = patch.from;
    if (patch.to !== undefined) t.to = patch.to;
    if (patch.direction) t.direction = patch.direction;
    if (patch.repeat !== undefined) t.repeat = patch.repeat;
    if (patch.color) t.color = patch.color;
    if (patch.notes !== undefined) t.notes = patch.notes;
    tx.state.tags.sort((a, b) => a.from - b.from);
    return t;
  });
}

export function removeTag(doc: SpriteDocument, name: string): void {
  const t = resolveTag(doc.state, name);
  doc.transact(`Remove tag ${t.name}`, (tx) => {
    tx.state.tags = tx.state.tags.filter((x) => x.name !== t.name);
  });
}

export interface SliceInput {
  name: string;
  bounds: Rect;
  center?: Rect;
  pivot?: Point;
  /** Frame from which this key applies. Default 0. */
  frame?: number;
  color?: string;
  notes?: string;
}

function findSlice(doc: SpriteDocument, name: string): SliceState {
  const s =
    doc.state.slices.find((x) => x.name === name) ??
    doc.state.slices.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!s)
    throw notFound(
      'slice',
      name,
      doc.state.slices.map((x) => x.name),
    );
  return s;
}

function validateKey(doc: SpriteDocument, k: SliceKey, color?: string): void {
  validateColor(color);
  assertFrame(doc.state, k.frame);
  const b = k.bounds;
  if (b.w <= 0 || b.h <= 0) throw invalidArg('Slice bounds need positive w and h');
  if (k.center) {
    const c = k.center;
    if (c.x < 0 || c.y < 0 || c.x + c.w > b.w || c.y + c.h > b.h)
      throw invalidArg('9-patch center must lie inside the slice bounds (relative coordinates)');
  }
}

export function setSlice(doc: SpriteDocument, s: SliceInput): SliceState {
  const key: SliceKey = {
    frame: s.frame ?? 0,
    bounds: s.bounds,
    ...(s.center ? { center: s.center } : {}),
    ...(s.pivot ? { pivot: s.pivot } : {}),
  };
  validateKey(doc, key, s.color);
  const exists = doc.state.slices.some((x) => x.name === s.name);
  return doc.transact(`${exists ? 'Update' : 'Add'} slice ${s.name}`, (tx) => {
    let sl = tx.state.slices.find((x) => x.name === s.name);
    if (!sl) {
      sl = { name: s.name, color: s.color ?? '#0000ff', keys: [] };
      tx.state.slices.push(sl);
    }
    if (s.color) sl.color = s.color;
    if (s.notes !== undefined) sl.notes = s.notes;
    sl.keys = sl.keys.filter((k) => k.frame !== key.frame);
    sl.keys.push(key);
    sl.keys.sort((a, b) => a.frame - b.frame);
    return sl;
  });
}

export function removeSlice(doc: SpriteDocument, name: string): void {
  const s = findSlice(doc, name);
  doc.transact(`Remove slice ${s.name}`, (tx) => {
    tx.state.slices = tx.state.slices.filter((x) => x.name !== s.name);
  });
}

/** Slice key in effect at a frame (last key with key.frame ≤ frame). */
export function sliceKeyAt(slice: SliceState, frame: number): SliceKey | undefined {
  let k: SliceKey | undefined;
  for (const key of slice.keys) if (key.frame <= frame) k = key;
  return k ?? slice.keys[0];
}
