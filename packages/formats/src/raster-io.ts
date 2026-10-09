/**
 * Glue between core Rasters and the encoders.
 */
import { Raster } from '@pixelclaus/core';
import { decodePng, encodePng, type PngEncodeOptions } from './png.js';

export function rasterToPng(r: Raster, opts?: PngEncodeOptions): Uint8Array {
  return encodePng({ width: r.width, height: r.height, data: r.data }, opts);
}

export function pngToRaster(bytes: Uint8Array): Raster {
  const d = decodePng(bytes);
  return new Raster(
    d.width,
    d.height,
    new Uint8ClampedArray(d.data.buffer, d.data.byteOffset, d.data.byteLength),
  );
}

/** Composite a raster over a solid matte colour (for formats without alpha, e.g. JPG). */
export function flattenOnMatte(r: Raster, matte: number): Raster {
  const out = Raster.filled(r.width, r.height, matte);
  out.draw(r, 0, 0);
  return out;
}
