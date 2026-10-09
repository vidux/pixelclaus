/**
 * Native binary encodings:
 * - `encodeImageBlob` / `decodeImageBlob`: one PixelBuffer (used by on-disk project storage)
 * - `encodePxc` / `decodePxc`: a whole document (state + images + masks) in one file — used for
 *   checkpoints, duplication and portable backups.
 */
import { unzlibSync, zlibSync } from 'fflate';
import {
  Mask,
  PixelBuffer,
  type DocumentSnapshot,
  type IdCounters,
  type SpriteState,
} from '@pixelclaus/core';
import { ByteReader, ByteWriter, utf8Decode, utf8Encode } from './bytes.js';

const IMG_MAGIC = 0x31495850; // 'PXI1' little-endian
const PXC_MAGIC = 0x31435850; // 'PXC1'

/** Bytes per pixel needed to store a buffer losslessly. */
function bppFor(buf: PixelBuffer): 1 | 4 {
  for (let i = 0; i < buf.data.length; i++) if (buf.data[i]! > 255) return 4;
  return 1;
}

function packPixels(buf: PixelBuffer, bpp: 1 | 4): Uint8Array {
  if (bpp === 1) return Uint8Array.from(buf.data);
  const out = new Uint8Array(buf.data.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < buf.data.length; i++) dv.setUint32(i * 4, buf.data[i]!, true);
  return out;
}

function unpackPixels(raw: Uint8Array, w: number, h: number, bpp: number): PixelBuffer {
  const buf = new PixelBuffer(w, h);
  if (bpp === 1) buf.data.set(raw.subarray(0, w * h));
  else {
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let i = 0; i < w * h; i++) buf.data[i] = dv.getUint32(i * 4, true);
  }
  return buf;
}

export function encodeImageBlob(
  buf: PixelBuffer,
  level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6,
): Uint8Array {
  const bpp = bppFor(buf);
  const body = zlibSync(packPixels(buf, bpp), { level });
  const w = new ByteWriter(body.length + 16);
  w.u32(IMG_MAGIC).u32(buf.width).u32(buf.height).u8(bpp).zeros(3).bytes(body);
  return w.toBytes();
}

export function decodeImageBlob(bytes: Uint8Array): PixelBuffer {
  const r = new ByteReader(bytes);
  if (r.u32() !== IMG_MAGIC) throw new Error('Not a PixelClaus image blob');
  const w = r.u32();
  const h = r.u32();
  const bpp = r.u8();
  r.skip(3);
  return unpackPixels(unzlibSync(r.bytes(r.remaining)), w, h, bpp);
}

export function encodeMaskBlob(m: Mask): Uint8Array {
  const body = zlibSync(m.data, { level: 6 });
  const w = new ByteWriter(body.length + 12);
  w.u32(m.width).u32(m.height).bytes(body);
  return w.toBytes();
}

export function decodeMaskBlob(bytes: Uint8Array): Mask {
  const r = new ByteReader(bytes);
  const w = r.u32();
  const h = r.u32();
  return new Mask(w, h, unzlibSync(r.bytes(r.remaining)).slice(0, w * h));
}

interface PxcHeader {
  version: 1;
  state: SpriteState;
  counters: IdCounters;
  images: Array<{ id: string; len: number }>;
  masks: Array<{ id: string; len: number }>;
}

export function encodePxc(snap: DocumentSnapshot): Uint8Array {
  const blobs: Uint8Array[] = [];
  const header: PxcHeader = { version: 1, state: snap.state, counters: snap.counters, images: [], masks: [] };
  for (const [id, img] of snap.images) {
    const b = encodeImageBlob(img);
    header.images.push({ id, len: b.length });
    blobs.push(b);
  }
  for (const [id, m] of snap.masks) {
    const b = encodeMaskBlob(m);
    header.masks.push({ id, len: b.length });
    blobs.push(b);
  }
  const json = utf8Encode(JSON.stringify(header));
  const w = new ByteWriter(json.length + blobs.reduce((s, b) => s + b.length, 0) + 16);
  w.u32(PXC_MAGIC).u32(json.length).bytes(json);
  for (const b of blobs) w.bytes(b);
  return w.toBytes();
}

export function isPxc(bytes: Uint8Array): boolean {
  return bytes.length > 8 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) === PXC_MAGIC;
}

export function decodePxc(bytes: Uint8Array): DocumentSnapshot {
  const r = new ByteReader(bytes);
  if (r.u32() !== PXC_MAGIC) throw new Error('Not a .pxc file');
  const header = JSON.parse(utf8Decode(r.bytes(r.u32()))) as PxcHeader;
  const images = new Map<string, PixelBuffer>();
  for (const e of header.images) images.set(e.id, decodeImageBlob(r.bytes(e.len)));
  const masks = new Map<string, Mask>();
  for (const e of header.masks) masks.set(e.id, decodeMaskBlob(r.bytes(e.len)));
  return { state: header.state, counters: header.counters, images, masks };
}
