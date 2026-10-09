/**
 * Node-only raster codecs backed by sharp (libvips): decoding arbitrary image files and encoding
 * JPEG / WebP / animated WebP. PNG, APNG and GIF use the pure encoders in @pixelclaus/formats.
 */
import sharp from 'sharp';
import { Raster } from '@pixelclaus/core';
import { decodeGif, decodePng, isPng } from '@pixelclaus/formats';

export interface DecodedFrames {
  width: number;
  height: number;
  frames: Array<{ raster: Raster; duration: number }>;
  format: string;
}

/** Decode PNG/GIF/JPEG/WebP/… into straight RGBA frames. */
export async function decodeImageFile(bytes: Uint8Array): Promise<DecodedFrames> {
  if (isPng(bytes)) {
    try {
      const d = decodePng(bytes);
      return {
        width: d.width,
        height: d.height,
        format: 'png',
        frames: [{ raster: new Raster(d.width, d.height, new Uint8ClampedArray(d.data)), duration: 100 }],
      };
    } catch {
      // fall through to sharp
    }
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const g = decodeGif(bytes);
    return {
      width: g.width,
      height: g.height,
      format: 'gif',
      frames: g.frames.map((f) => ({
        raster: new Raster(g.width, g.height, new Uint8ClampedArray(f.data)),
        duration: f.duration || 100,
      })),
    };
  }
  const img = sharp(bytes, { animated: true });
  const meta = await img.metadata();
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pages = meta.pages ?? 1;
  const pageH = meta.pageHeight ?? info.height / pages;
  const frames: DecodedFrames['frames'] = [];
  for (let p = 0; p < pages; p++) {
    const slice = new Uint8ClampedArray(
      data.buffer,
      data.byteOffset + p * info.width * pageH * 4,
      info.width * pageH * 4,
    );
    frames.push({
      raster: new Raster(info.width, pageH, new Uint8ClampedArray(slice)),
      duration: meta.delay?.[p] ?? 100,
    });
  }
  return { width: info.width, height: pageH, frames, format: meta.format ?? 'unknown' };
}

function rawInput(r: Raster) {
  return sharp(Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength), {
    raw: { width: r.width, height: r.height, channels: 4 },
  });
}

export async function encodeJpeg(r: Raster, opts: { quality?: number; matte: string }): Promise<Uint8Array> {
  const buf = await rawInput(r)
    .flatten({ background: opts.matte })
    .jpeg({ quality: opts.quality ?? 95, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toBuffer();
  return new Uint8Array(buf);
}

export async function encodeWebp(
  r: Raster,
  opts: { lossless?: boolean; quality?: number } = {},
): Promise<Uint8Array> {
  const buf = await rawInput(r)
    .webp({ lossless: opts.lossless ?? true, quality: opts.quality ?? 100, exact: true, effort: 6 })
    .toBuffer();
  return new Uint8Array(buf);
}

export async function encodeAnimatedWebp(
  frames: ReadonlyArray<{ raster: Raster; duration: number }>,
  opts: { loops?: number; lossless?: boolean; quality?: number } = {},
): Promise<Uint8Array> {
  if (!frames.length) throw new Error('No frames');
  const { width, height } = frames[0]!.raster;
  const all = new Uint8Array(width * height * 4 * frames.length);
  frames.forEach((f, i) => all.set(f.raster.data, i * width * height * 4));
  const buf = await sharp(Buffer.from(all.buffer), {
    raw: { width, height: height * frames.length, channels: 4, pageHeight: height },
  })
    .webp({
      lossless: opts.lossless ?? true,
      quality: opts.quality ?? 100,
      exact: true,
      effort: 6,
      loop: opts.loops ?? 0,
      delay: frames.map((f) => Math.max(1, Math.round(f.duration))),
    })
    .toBuffer();
  return new Uint8Array(buf);
}

export async function imageInfo(
  bytes: Uint8Array,
): Promise<{ format?: string; width?: number; height?: number; pages?: number }> {
  const m = await sharp(bytes, { animated: true }).metadata();
  return { format: m.format, width: m.width, height: m.pageHeight ?? m.height, pages: m.pages };
}
