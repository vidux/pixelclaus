import { invalidArg, notFound, PixelClausError } from '../errors.js';
import type { SpriteDocument } from './document.js';
import type { CelState, LayerState, SpriteState, TagState } from './types.js';

export function findLayer(state: SpriteState, ref: string): LayerState | undefined {
  const byId = state.layers.find((l) => l.id === ref);
  if (byId) return byId;
  const exact = state.layers.filter((l) => l.name === ref);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw invalidArg(
      `Layer name '${ref}' is ambiguous (${exact.length} layers)`,
      `Use a layer id instead: ${exact.map((l) => `${l.id} (${layerPath(state, l)})`).join(', ')}`,
    );
  }
  const ci = state.layers.filter((l) => l.name.toLowerCase() === ref.toLowerCase());
  if (ci.length === 1) return ci[0];
  // allow "Group/Child" paths
  if (ref.includes('/'))
    return state.layers.find((l) => layerPath(state, l).toLowerCase() === ref.toLowerCase());
  return undefined;
}

export function layerLabels(state: SpriteState): string[] {
  return state.layers.map((l) => `${l.name} (${l.id})`);
}

export function resolveLayer(doc: SpriteDocument, ref: string): LayerState {
  const l = findLayer(doc.state, ref);
  if (!l)
    throw notFound(
      'layer',
      ref,
      doc.state.layers.map((x) => x.name).concat(doc.state.layers.map((x) => x.id)),
    );
  return l;
}

/** Resolve a drawable (image) layer. */
export function resolveImageLayer(doc: SpriteDocument, ref: string): LayerState {
  const l = resolveLayer(doc, ref);
  if (l.type === 'group') {
    const kids = layerChildren(doc.state, l.id).map((k) => k.name);
    throw invalidArg(
      `Layer '${l.name}' is a group and has no pixels`,
      kids.length ? `Target one of its children: ${kids.join(', ')}` : 'Add an image layer inside it first',
    );
  }
  return l;
}

export function layerChildren(state: SpriteState, parentId: string | null): LayerState[] {
  return state.layers.filter((l) => l.parentId === parentId);
}

export function layerPath(state: SpriteState, layer: LayerState): string {
  const parts = [layer.name];
  let p = layer.parentId;
  let guard = 0;
  while (p && guard++ < 64) {
    const parent = state.layers.find((l) => l.id === p);
    if (!parent) break;
    parts.unshift(parent.name);
    p = parent.parentId;
  }
  return parts.join('/');
}

export function layerDepth(state: SpriteState, layer: LayerState): number {
  let d = 0;
  let p = layer.parentId;
  while (p && d < 64) {
    const parent = state.layers.find((l) => l.id === p);
    if (!parent) break;
    d++;
    p = parent.parentId;
  }
  return d;
}

/** Depth-first walk: siblings bottom → top, a group is visited before its children. */
export function walkLayers(state: SpriteState, visit: (l: LayerState, depth: number) => void): void {
  const rec = (parent: string | null, depth: number) => {
    for (const l of layerChildren(state, parent)) {
      visit(l, depth);
      if (l.type === 'group') rec(l.id, depth + 1);
    }
  };
  rec(null, 0);
}

/** Descendant layer ids of a group (not including the group). */
export function descendants(state: SpriteState, groupId: string): string[] {
  const out: string[] = [];
  const rec = (pid: string) => {
    for (const l of layerChildren(state, pid)) {
      out.push(l.id);
      if (l.type === 'group') rec(l.id);
    }
  };
  rec(groupId);
  return out;
}

export function isEffectivelyVisible(state: SpriteState, layer: LayerState): boolean {
  let l: LayerState | undefined = layer;
  let guard = 0;
  while (l && guard++ < 64) {
    if (!l.visible) return false;
    const pid: string | null = l.parentId;
    l = pid ? state.layers.find((x) => x.id === pid) : undefined;
  }
  return true;
}

export function isEffectivelyLocked(state: SpriteState, layer: LayerState): boolean {
  let l: LayerState | undefined = layer;
  let guard = 0;
  while (l && guard++ < 64) {
    if (l.locked) return true;
    const pid: string | null = l.parentId;
    l = pid ? state.layers.find((x) => x.id === pid) : undefined;
  }
  return false;
}

export function assertFrame(state: SpriteState, frame: number): void {
  if (!Number.isInteger(frame) || frame < 0 || frame >= state.frames.length) {
    throw new PixelClausError(
      'INVALID_ARGUMENT',
      `Frame ${frame} out of range`,
      `Frames are 0-indexed; this sprite has ${state.frames.length} frame(s): 0..${state.frames.length - 1}`,
    );
  }
}

export type FrameSpec = number | number[] | { from: number; to: number } | { tag: string } | 'all';

/** Resolve a frame specification into a sorted unique list of frame indices. */
export function resolveFrames(
  state: SpriteState,
  spec: FrameSpec | undefined,
  fallback: 'all' | 'first' = 'first',
): number[] {
  if (spec === undefined) return fallback === 'all' ? state.frames.map((_, i) => i) : [0];
  if (spec === 'all') return state.frames.map((_, i) => i);
  if (typeof spec === 'number') {
    assertFrame(state, spec);
    return [spec];
  }
  if (Array.isArray(spec)) {
    spec.forEach((f) => assertFrame(state, f));
    return [...new Set(spec)].sort((a, b) => a - b);
  }
  if ('tag' in spec) {
    const t = resolveTag(state, spec.tag);
    return range(t.from, t.to);
  }
  assertFrame(state, spec.from);
  assertFrame(state, spec.to);
  if (spec.to < spec.from) throw invalidArg(`Frame range from ${spec.from} to ${spec.to} is reversed`);
  return range(spec.from, spec.to);
}

export function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

export function resolveTag(state: SpriteState, name: string): TagState {
  const t =
    state.tags.find((x) => x.name === name) ??
    state.tags.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!t)
    throw notFound(
      'tag',
      name,
      state.tags.map((x) => x.name),
    );
  return t;
}

export function getCel(state: SpriteState, layerId: string, frame: number): CelState | undefined {
  return state.cels.find((c) => c.layerId === layerId && c.frame === frame);
}

export function celsOfLayer(state: SpriteState, layerId: string): CelState[] {
  return state.cels.filter((c) => c.layerId === layerId).sort((a, b) => a.frame - b.frame);
}

/** Frames (in the same layer) whose cels share this cel's image. */
export function linkedFrames(state: SpriteState, cel: CelState): number[] {
  return state.cels
    .filter((c) => c.imageId === cel.imageId && c !== cel)
    .map((c) => c.frame)
    .sort((a, b) => a - b);
}

/** All cels referencing an image. */
export function celsUsingImage(state: SpriteState, imageId: string): CelState[] {
  return state.cels.filter((c) => c.imageId === imageId);
}

/** Playback order of frames for a tag (ping-pong unrolled, one cycle). */
export function tagPlaybackOrder(tag: TagState): number[] {
  const fwd = range(tag.from, tag.to);
  switch (tag.direction) {
    case 'forward':
      return fwd;
    case 'reverse':
      return [...fwd].reverse();
    case 'pingpong':
      return fwd.length <= 1 ? fwd : [...fwd, ...fwd.slice(1, -1).reverse()];
    case 'pingpong_reverse': {
      const rev = [...fwd].reverse();
      return rev.length <= 1 ? rev : [...rev, ...rev.slice(1, -1).reverse()];
    }
  }
}
