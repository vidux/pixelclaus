/**
 * Document payloads for compute workers: a consistent copy of the state plus the pixel buffers a task
 * needs (optionally only the cels of some frames), shaped for postMessage with transferable buffers.
 */
import {
  cloneJson,
  Mask,
  PixelBuffer,
  SpriteDocument,
  type DocumentSnapshot,
  type IdCounters,
  type SpriteState,
} from '@pixelclaus/core';

export interface DocPayload {
  state: SpriteState;
  counters: IdCounters;
  /** [id, width, height, pixels] */
  images: Array<[string, number, number, Uint32Array]>;
  /** [id, width, height, bits] */
  masks: Array<[string, number, number, Uint8Array]>;
}

export interface PayloadOptions {
  /** Only copy images of cels in these frames (default: every frame). */
  frames?: readonly number[] | null;
  /** Include selection masks (default false: no read-only task needs them). */
  masks?: boolean;
  /** Include clipboard images (complete copies such as checkpoints). */
  clipboards?: boolean;
}

/**
 * Copy what a task needs. Call it synchronously inside `projects.read`/`mutate` so the copy is
 * consistent; the heavy work then runs on a worker without holding any lock.
 */
export function docPayload(
  doc: SpriteDocument,
  opts: PayloadOptions = {},
): { payload: DocPayload; transfer: ArrayBuffer[] } {
  const wanted = opts.frames ? new Set(opts.frames) : null;
  const ids = new Set<string>();
  for (const c of doc.state.cels) if (!wanted || wanted.has(c.frame)) ids.add(c.imageId);
  if (opts.clipboards) for (const c of Object.values(doc.state.clipboards)) ids.add(c.imageId);
  const transfer: ArrayBuffer[] = [];
  const images: DocPayload['images'] = [];
  for (const id of ids) {
    const img = doc.image(id);
    const copy = img.data.slice();
    transfer.push(copy.buffer as ArrayBuffer);
    images.push([id, img.width, img.height, copy]);
  }
  const masks: DocPayload['masks'] = [];
  if (opts.masks) {
    for (const id of Object.values(doc.state.selections)) {
      const m = doc.mask(id);
      const copy = m.data.slice();
      transfer.push(copy.buffer as ArrayBuffer);
      masks.push([id, m.width, m.height, copy]);
    }
  }
  return {
    payload: { state: cloneJson(doc.state), counters: { ...doc.counters }, images, masks },
    transfer,
  };
}

/** Rebuild a (history-less) document from a payload. Cels whose images were not sent read as empty. */
export function payloadDoc(p: DocPayload): SpriteDocument {
  const images = new Map<string, PixelBuffer>();
  for (const [id, w, h, data] of p.images) images.set(id, new PixelBuffer(w, h, data));
  for (const c of p.state.cels) {
    if (!images.has(c.imageId)) images.set(c.imageId, new PixelBuffer(p.state.width, p.state.height));
  }
  for (const c of Object.values(p.state.clipboards)) {
    if (!images.has(c.imageId)) images.set(c.imageId, new PixelBuffer(1, 1));
  }
  const masks = new Map<string, Mask>();
  for (const [id, w, h, data] of p.masks) masks.set(id, new Mask(w, h, data));
  for (const id of Object.values(p.state.selections)) {
    if (!masks.has(id)) masks.set(id, new Mask(p.state.width, p.state.height));
  }
  return new SpriteDocument({ state: p.state, images, masks, counters: p.counters }, { maxEntries: 1 });
}

/** A complete payload (every image, mask and clipboard): what checkpoints and .pxc files contain. */
export function fullPayload(doc: SpriteDocument): { payload: DocPayload; transfer: ArrayBuffer[] } {
  return docPayload(doc, { masks: true, clipboards: true });
}

/** Payload → DocumentSnapshot (maps of buffers), e.g. to restore or adopt a decoded checkpoint. */
export function payloadSnapshot(p: DocPayload): DocumentSnapshot {
  const images = new Map<string, PixelBuffer>();
  for (const [id, w, h, data] of p.images) images.set(id, new PixelBuffer(w, h, data));
  const masks = new Map<string, Mask>();
  for (const [id, w, h, data] of p.masks) masks.set(id, new Mask(w, h, data));
  return { state: p.state, counters: p.counters, images, masks };
}

/** DocumentSnapshot → payload (inverse of payloadSnapshot, used by workers). */
export function snapshotPayload(snap: DocumentSnapshot): { payload: DocPayload; transfer: ArrayBuffer[] } {
  const transfer: ArrayBuffer[] = [];
  const images: DocPayload['images'] = [];
  for (const [id, img] of snap.images) {
    images.push([id, img.width, img.height, img.data]);
    transfer.push(img.data.buffer as ArrayBuffer);
  }
  const masks: DocPayload['masks'] = [];
  for (const [id, m] of snap.masks) {
    masks.push([id, m.width, m.height, m.data]);
    transfer.push(m.data.buffer as ArrayBuffer);
  }
  return { payload: { state: snap.state, counters: snap.counters, images, masks }, transfer };
}
