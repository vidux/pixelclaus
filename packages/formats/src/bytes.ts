/** Little helpers for binary IO (browser-safe). */
import { strFromU8, strToU8 } from 'fflate';

export const utf8Encode = (s: string): Uint8Array => strToU8(s);
export const utf8Decode = (b: Uint8Array): string => strFromU8(b);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Raw CRC register update (no final XOR) — chain calls, then `crcFinal`. */
export function crcUpdate(c: number, data: Uint8Array, start = 0, end = data.length): number {
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return c >>> 0;
}

export function crcFinal(c: number): number {
  return (c ^ 0xffffffff) >>> 0;
}

/** Standard CRC-32 (PNG/zlib). */
export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  return crcFinal(crcUpdate(0xffffffff, data, start, end));
}

/** Growable byte buffer with typed writers. */
export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  length = 0;
  readonly littleEndian: boolean;

  constructor(initial = 1024, littleEndian = true) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
    this.littleEndian = littleEndian;
  }

  private ensure(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.buf[this.length++] = v & 255;
    return this;
  }

  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.length, v & 0xffff, this.littleEndian);
    this.length += 2;
    return this;
  }

  i16(v: number): this {
    this.ensure(2);
    this.view.setInt16(this.length, v, this.littleEndian);
    this.length += 2;
    return this;
  }

  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.length, v >>> 0, this.littleEndian);
    this.length += 4;
    return this;
  }

  i32(v: number): this {
    this.ensure(4);
    this.view.setInt32(this.length, v | 0, this.littleEndian);
    this.length += 4;
    return this;
  }

  bytes(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
    return this;
  }

  zeros(n: number): this {
    this.ensure(n);
    this.buf.fill(0, this.length, this.length + n);
    this.length += n;
    return this;
  }

  /** Overwrite a u32 at an absolute offset. */
  patchU32(offset: number, v: number): void {
    this.view.setUint32(offset, v >>> 0, this.littleEndian);
  }

  patchU16(offset: number, v: number): void {
    this.view.setUint16(offset, v & 0xffff, this.littleEndian);
  }

  toBytes(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

export class ByteReader {
  readonly data: Uint8Array;
  private view: DataView;
  pos = 0;
  readonly littleEndian: boolean;

  constructor(data: Uint8Array, littleEndian = true) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.littleEndian = littleEndian;
  }

  get remaining(): number {
    return this.data.length - this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.data.length)
      throw new RangeError(`Unexpected end of data at byte ${this.pos} (need ${n})`);
  }

  u8(): number {
    this.need(1);
    return this.data[this.pos++]!;
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, this.littleEndian);
    this.pos += 2;
    return v;
  }

  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos, this.littleEndian);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, this.littleEndian);
    this.pos += 4;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, this.littleEndian);
    this.pos += 4;
    return v;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const b = this.data.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }
}

/** Base64 (browser-safe, no Buffer). */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  if (i < bytes.length) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8);
    out +=
      B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=') + '=';
  }
  return out;
}

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/^data:[^,]*,/, '').replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  return out.subarray(0, o);
}
