/**
 * Numeric frame metrics — "numbers over pictures" feedback for animation work.
 */
import type { Raster } from '../buffer/raster.js';
import type { SpriteDocument } from '../model/document.js';
import { resolveFrames, resolveTag, tagPlaybackOrder, type FrameSpec } from '../model/lookup.js';
import { compositeFrame } from '../render/composite.js';
import type { Rect } from '../util/geometry.js';

export interface FrameMetrics {
  frame: number;
  duration: number;
  bbox: Rect | null;
  pixels: number;
  /** Mean position of opaque pixels (1 decimal). */
  centroid: { x: number; y: number } | null;
  /** Lowest opaque row (feet / baseline). */
  bottom: number | null;
  /** Highest opaque row. */
  top: number | null;
  /** Pixels that differ from the previous frame in the list. */
  changed: number | null;
}

export function rasterMetrics(r: Raster): Omit<FrameMetrics, 'frame' | 'duration' | 'changed'> {
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      if (r.data[(y * r.width + x) * 4 + 3]! > 0) {
        n++;
        sx += x;
        sy += y;
      }
    }
  }
  const bbox = r.bounds();
  return {
    bbox,
    pixels: n,
    centroid: n ? { x: Math.round((sx / n) * 10) / 10, y: Math.round((sy / n) * 10) / 10 } : null,
    bottom: bbox ? bbox.y + bbox.h - 1 : null,
    top: bbox ? bbox.y : null,
  };
}

export function rasterDiffCount(a: Raster, b: Raster): number {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const aa = a.data[i + 3]!;
    const ba = b.data[i + 3]!;
    if (aa === 0 && ba === 0) continue;
    if (
      aa !== ba ||
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2]
    )
      n++;
  }
  return n;
}

export interface AnimationMetricsRequest {
  frames?: FrameSpec;
  /** Use a tag's playback order (ping-pong unrolled). */
  tag?: string;
  /** Isolate layers (ids). */
  layers?: readonly string[];
}

export interface AnimationMetrics {
  frames: FrameMetrics[];
  totalDuration: number;
  summary: {
    baselineRange: [number, number] | null;
    centroidXRange: [number, number] | null;
    centroidYRange: [number, number] | null;
    pixelRange: [number, number];
    maxChanged: number;
  };
}

export function playbackFrames(doc: SpriteDocument, req: { frames?: FrameSpec; tag?: string }): number[] {
  if (req.tag) return tagPlaybackOrder(resolveTag(doc.state, req.tag));
  return resolveFrames(doc.state, req.frames, 'all');
}

export function animationMetrics(doc: SpriteDocument, req: AnimationMetricsRequest = {}): AnimationMetrics {
  const order = playbackFrames(doc, req);
  const rasters = new Map<number, Raster>();
  const get = (f: number) => {
    let r = rasters.get(f);
    if (!r) {
      r = compositeFrame(doc, { frame: f, isolate: req.layers, includeReference: false });
      rasters.set(f, r);
    }
    return r;
  };
  const frames: FrameMetrics[] = order.map((f, i) => {
    const r = get(f);
    return {
      frame: f,
      duration: doc.state.frames[f]!.duration,
      ...rasterMetrics(r),
      changed:
        i === 0
          ? order.length > 1
            ? rasterDiffCount(get(order[order.length - 1]!), r)
            : null
          : rasterDiffCount(get(order[i - 1]!), r),
    };
  });
  const range = (vals: number[]): [number, number] | null =>
    vals.length ? [Math.min(...vals), Math.max(...vals)] : null;
  return {
    frames,
    totalDuration: frames.reduce((s, f) => s + f.duration, 0),
    summary: {
      baselineRange: range(frames.map((f) => f.bottom).filter((v): v is number => v !== null)),
      centroidXRange: range(frames.map((f) => f.centroid?.x).filter((v): v is number => v !== undefined)),
      centroidYRange: range(frames.map((f) => f.centroid?.y).filter((v): v is number => v !== undefined)),
      pixelRange: range(frames.map((f) => f.pixels)) ?? [0, 0],
      maxChanged: Math.max(0, ...frames.map((f) => f.changed ?? 0)),
    },
  };
}
