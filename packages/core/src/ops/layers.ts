/**
 * Layer commands: add, update, remove, move, duplicate, merge down, flatten.
 */
import { PixelBuffer } from '../buffer/pixel-buffer.js';
import { blendInto, isBlendMode, type BlendMode } from '../color/blend.js';
import { invalidArg, PixelClausError } from '../errors.js';
import { ColorResolver } from '../model/colors.js';
import { newLayer } from '../model/create.js';
import type { SpriteDocument, Transaction } from '../model/document.js';
import { descendants, getCel, layerChildren, resolveLayer } from '../model/lookup.js';
import { MAX_LAYERS, type LayerState, type LayerType } from '../model/types.js';
import { compositeFrame } from '../render/composite.js';
import { cloneJson } from '../util/geometry.js';

export interface LayerPosition {
  /** Place directly above this sibling layer (id or name). */
  above?: string;
  /** Place directly below this sibling layer. */
  below?: string;
  /** Parent group (id or name); null/'' for root. */
  parent?: string | null;
  /** Index among siblings, 0 = bottom. */
  index?: number;
}

export interface AddLayerOptions extends LayerPosition {
  name?: string;
  type?: LayerType;
  opacity?: number;
  blendMode?: BlendMode;
  visible?: boolean;
  locked?: boolean;
  continuous?: boolean;
  color?: string;
  notes?: string;
}

export interface LayerPatch {
  name?: string;
  visible?: boolean;
  locked?: boolean;
  opacity?: number;
  blendMode?: BlendMode;
  continuous?: boolean;
  color?: string;
  notes?: string;
  collapsed?: boolean;
}

function uniqueName(doc: SpriteDocument, base: string): string {
  const names = new Set(doc.state.layers.map((l) => l.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

function validateOpacity(o: number | undefined): void {
  if (o !== undefined && (!Number.isFinite(o) || o < 0 || o > 255))
    throw invalidArg(`opacity must be 0..255, got ${o}`);
}

function validateBlend(b: string | undefined): void {
  if (b !== undefined && !isBlendMode(b)) throw invalidArg(`Unknown blend mode '${b}'`);
}

/** Global array index at which to insert a layer with the given position semantics. */
function placementIndex(tx: Transaction, layer: LayerState, pos: LayerPosition): void {
  const st = tx.state;
  const doc = tx.document;
  let parentId: string | null = layer.parentId;
  let anchor: LayerState | undefined;
  let after = true;
  if (pos.above || pos.below) {
    anchor = resolveLayer(doc, (pos.above ?? pos.below)!);
    if (anchor.id === layer.id) throw invalidArg('A layer cannot be positioned relative to itself');
    parentId = anchor.parentId;
    after = !!pos.above;
  } else if (pos.parent !== undefined) {
    parentId = pos.parent ? resolveLayer(doc, pos.parent).id : null;
  }
  if (parentId) {
    const parent = st.layers.find((l) => l.id === parentId);
    if (!parent || parent.type !== 'group') throw invalidArg(`Parent '${pos.parent}' is not a group layer`);
    if (layer.type === 'group' && (parentId === layer.id || descendants(st, layer.id).includes(parentId))) {
      throw invalidArg('Cannot move a group into itself');
    }
  }
  // remove from array (if present)
  const cur = st.layers.indexOf(layer);
  if (cur >= 0) st.layers.splice(cur, 1);
  layer.parentId = parentId;
  const siblings = st.layers.filter((l) => l.parentId === parentId);
  let globalIndex: number;
  if (anchor) {
    const ai = st.layers.indexOf(anchor);
    globalIndex = after ? ai + 1 : ai;
  } else if (pos.index !== undefined && siblings.length) {
    const i = Math.max(0, Math.min(siblings.length, Math.round(pos.index)));
    globalIndex =
      i >= siblings.length
        ? st.layers.indexOf(siblings[siblings.length - 1]!) + 1
        : st.layers.indexOf(siblings[i]!);
  } else if (siblings.length) {
    globalIndex = st.layers.indexOf(siblings[siblings.length - 1]!) + 1;
  } else {
    const parentIdx = parentId ? st.layers.findIndex((l) => l.id === parentId) : -1;
    globalIndex = parentIdx + 1;
  }
  st.layers.splice(globalIndex, 0, layer);
  // the background layer must stay at the bottom of the root
  const bg = st.layers.find((l) => l.isBackground);
  if (bg && layer.id !== bg.id) {
    const roots = st.layers.filter((l) => l.parentId === null);
    if (roots[0] && roots[0].id !== bg.id) {
      st.layers.splice(st.layers.indexOf(bg), 1);
      st.layers.unshift(bg);
      if (layer.parentId === null && roots[0].id === layer.id)
        tx.warn('The Background layer must stay bottom-most; placed the layer above it');
    }
  }
}

export function addLayer(doc: SpriteDocument, opts: AddLayerOptions = {}): LayerState {
  if (doc.state.layers.length >= MAX_LAYERS)
    throw new PixelClausError('LIMIT', `Maximum of ${MAX_LAYERS} layers reached`);
  validateOpacity(opts.opacity);
  validateBlend(opts.blendMode);
  const type = opts.type ?? 'image';
  return doc.transact(`Add ${type} layer`, (tx) => {
    const layer = newLayer(
      doc.nextId('layer'),
      uniqueName(doc, opts.name ?? (type === 'group' ? 'Group' : `Layer ${doc.counters.layer}`)),
      {
        type,
        opacity: opts.opacity ?? 255,
        blendMode: opts.blendMode ?? 'normal',
        visible: opts.visible ?? true,
        locked: opts.locked ?? false,
        continuous: opts.continuous ?? false,
        ...(opts.color ? { color: opts.color } : {}),
        ...(opts.notes ? { notes: opts.notes } : {}),
      },
    );
    placementIndex(tx, layer, opts);
    return layer;
  });
}

export function updateLayer(doc: SpriteDocument, ref: string, patch: LayerPatch): LayerState {
  validateOpacity(patch.opacity);
  validateBlend(patch.blendMode);
  const layer = resolveLayer(doc, ref);
  return doc.transact(`Update layer ${layer.name}`, (tx) => {
    const l = tx.state.layers.find((x) => x.id === layer.id)!;
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw invalidArg('Layer name cannot be empty');
      l.name = name;
    }
    if (patch.visible !== undefined) l.visible = patch.visible;
    if (patch.locked !== undefined) l.locked = patch.locked;
    if (patch.opacity !== undefined) l.opacity = Math.round(patch.opacity);
    if (patch.blendMode !== undefined) l.blendMode = patch.blendMode;
    if (patch.continuous !== undefined) l.continuous = patch.continuous;
    if (patch.color !== undefined) l.color = patch.color;
    if (patch.notes !== undefined) l.notes = patch.notes;
    if (patch.collapsed !== undefined) l.collapsed = patch.collapsed;
    return l;
  });
}

export function removeLayer(doc: SpriteDocument, ref: string): string[] {
  const layer = resolveLayer(doc, ref);
  return doc.transact(`Remove layer ${layer.name}`, (tx) => {
    const ids = new Set([layer.id, ...(layer.type === 'group' ? descendants(tx.state, layer.id) : [])]);
    tx.state.layers = tx.state.layers.filter((l) => !ids.has(l.id));
    tx.state.cels = tx.state.cels.filter((c) => !ids.has(c.layerId));
    if (!tx.state.layers.some((l) => l.type === 'image'))
      tx.warn('The sprite now has no image layers; add one with layer {action:"add"} before drawing');
    return [...ids];
  });
}

export function moveLayer(doc: SpriteDocument, ref: string, pos: LayerPosition): LayerState {
  const layer = resolveLayer(doc, ref);
  if (layer.isBackground)
    throw invalidArg('The Background layer cannot be moved', 'It always stays bottom-most');
  if (!pos.above && !pos.below && pos.parent === undefined && pos.index === undefined) {
    throw invalidArg('move needs "above", "below", "parent" or "index"');
  }
  return doc.transact(`Move layer ${layer.name}`, (tx) => {
    const l = tx.state.layers.find((x) => x.id === layer.id)!;
    const group = l.type === 'group' ? descendants(tx.state, l.id) : [];
    placementIndex(tx, l, pos);
    // keep group children right after the group in the global array (cosmetic, keeps files tidy)
    if (group.length) {
      const kids = tx.state.layers.filter((x) => group.includes(x.id));
      tx.state.layers = tx.state.layers.filter((x) => !group.includes(x.id));
      tx.state.layers.splice(tx.state.layers.indexOf(l) + 1, 0, ...kids);
    }
    return l;
  });
}

export function duplicateLayer(doc: SpriteDocument, ref: string, name?: string): LayerState {
  const src = resolveLayer(doc, ref);
  return doc.transact(`Duplicate layer ${src.name}`, (tx) => {
    const st = tx.state;
    const map = new Map<string, string>();
    const copyOne = (l: LayerState, parentId: string | null, nm?: string): LayerState => {
      const c: LayerState = {
        ...cloneJson(l),
        id: doc.nextId('layer'),
        parentId,
        name: nm ?? uniqueName(doc, `${l.name} copy`),
        isBackground: false,
      };
      map.set(l.id, c.id);
      return c;
    };
    const top = copyOne(src, src.parentId, name ? uniqueName(doc, name) : undefined);
    st.layers.splice(st.layers.indexOf(src) + 1, 0, top);
    if (src.type === 'group') {
      let insertAt = st.layers.indexOf(top) + 1;
      const rec = (oldParent: string, newParent: string) => {
        for (const child of layerChildren(st, oldParent)) {
          const c = copyOne(child, newParent, child.name);
          st.layers.splice(insertAt++, 0, c);
          if (child.type === 'group') rec(child.id, c.id);
        }
      };
      rec(src.id, top.id);
    }
    const imageMap = new Map<string, string>();
    for (const cel of [...st.cels]) {
      const nl = map.get(cel.layerId);
      if (!nl) continue;
      let img = imageMap.get(cel.imageId);
      if (!img) {
        img = tx.adoptImage(doc.image(cel.imageId).clone());
        imageMap.set(cel.imageId, img);
      }
      st.cels.push({ ...cel, layerId: nl, imageId: img });
    }
    return top;
  });
}

/** Merge a layer into the image layer directly below it (same parent). */
export function mergeDown(doc: SpriteDocument, ref: string): LayerState {
  const src = resolveLayer(doc, ref);
  if (src.type !== 'image')
    throw invalidArg(`Only image layers can be merged down ('${src.name}' is a ${src.type})`);
  const siblings = layerChildren(doc.state, src.parentId);
  const idx = siblings.indexOf(src);
  const dst = siblings[idx - 1];
  if (!dst) throw invalidArg(`Layer '${src.name}' has no layer below it to merge into`);
  if (dst.type !== 'image')
    throw invalidArg(`The layer below ('${dst.name}') is a ${dst.type}; merge down needs an image layer`);
  return doc.transact(`Merge ${src.name} into ${dst.name}`, (tx) => {
    const st = tx.state;
    const resolver = new ColorResolver(doc, tx);
    const W = st.width;
    const H = st.height;
    const cache = new Map<string, string>();
    for (let f = 0; f < st.frames.length; f++) {
      const sc = getCel(st, src.id, f);
      if (!sc) continue;
      const dc = getCel(st, dst.id, f);
      const key = `${dc?.imageId ?? '-'}@${dc?.x},${dc?.y}|${sc.imageId}@${sc.x},${sc.y},${sc.opacity}`;
      const cached = cache.get(key);
      if (cached) {
        if (dc) Object.assign(dc, { imageId: cached, x: 0, y: 0 });
        else
          st.cels.push({ layerId: dst.id, frame: f, imageId: cached, x: 0, y: 0, opacity: 255, zIndex: 0 });
        continue;
      }
      const out = new PixelBuffer(W, H);
      if (dc) out.blit(doc.image(dc.imageId), dc.x, dc.y);
      const simg = doc.image(sc.imageId);
      const op = (src.opacity / 255) * (sc.opacity / 255);
      const exact = src.blendMode === 'normal' && op >= 1;
      const tmp = new Uint8Array(4);
      for (let y = 0; y < simg.height; y++) {
        for (let x = 0; x < simg.width; x++) {
          const v = simg.data[y * simg.width + x]!;
          if (v === 0) continue;
          const cx = x + sc.x;
          const cy = y + sc.y;
          if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
          const c = resolver.rgba(v);
          if (exact && (c & 255) === 255) {
            out.data[cy * W + cx] = v;
            continue;
          }
          const d = resolver.rgba(out.data[cy * W + cx]!);
          tmp[0] = d >>> 24;
          tmp[1] = (d >>> 16) & 255;
          tmp[2] = (d >>> 8) & 255;
          tmp[3] = d & 255;
          blendInto(tmp, 0, c >>> 24, (c >>> 16) & 255, (c >>> 8) & 255, c & 255, op, src.blendMode);
          out.data[cy * W + cx] = resolver.fromRgba(
            ((tmp[0]! << 24) | (tmp[1]! << 16) | (tmp[2]! << 8) | tmp[3]!) >>> 0,
          );
        }
      }
      const id = tx.adoptImage(out);
      cache.set(key, id);
      if (dc) Object.assign(dc, { imageId: id, x: 0, y: 0 });
      else st.cels.push({ layerId: dst.id, frame: f, imageId: id, x: 0, y: 0, opacity: 255, zIndex: 0 });
    }
    st.layers = st.layers.filter((l) => l.id !== src.id);
    st.cels = st.cels.filter((c) => c.layerId !== src.id);
    return st.layers.find((l) => l.id === dst.id)!;
  });
}

/** Flatten all visible layers into a single image layer (hidden layers are discarded). */
export function flatten(doc: SpriteDocument, name = 'Flattened'): LayerState {
  return doc.transact('Flatten', (tx) => {
    const st = tx.state;
    const resolver = new ColorResolver(doc, tx);
    const rasters = st.frames.map((_, f) => compositeFrame(doc, { frame: f, includeReference: false }));
    const hadBg = st.layers.some((l) => l.isBackground && l.visible);
    const layer = newLayer(doc.nextId('layer'), name, { isBackground: hadBg });
    st.layers = [layer];
    st.cels = [];
    rasters.forEach((r, f) => {
      const buf = new PixelBuffer(st.width, st.height);
      for (let i = 0; i < buf.data.length; i++) {
        const c = r.get(i % st.width, (i / st.width) | 0);
        buf.data[i] = c === 0 ? 0 : resolver.fromRgba(c);
      }
      if (!buf.isEmpty())
        st.cels.push({
          layerId: layer.id,
          frame: f,
          imageId: tx.adoptImage(buf),
          x: 0,
          y: 0,
          opacity: 255,
          zIndex: 0,
        });
    });
    return layer;
  });
}
