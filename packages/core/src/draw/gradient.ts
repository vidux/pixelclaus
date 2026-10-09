import type { Point } from '../util/geometry.js';
import { ditherPick, type DitherKind } from './dither.js';

export type GradientType = 'linear' | 'radial';

/** Gradient parameter t ∈ [0,1] at pixel (x, y) (sampled at the pixel centre). */
export function gradientT(type: GradientType, from: Point, to: Point, x: number, y: number): number {
  const px = x + 0.5;
  const py = y + 0.5;
  const ax = from.x + 0.5;
  const ay = from.y + 0.5;
  const bx = to.x + 0.5;
  const by = to.y + 0.5;
  if (type === 'radial') {
    const r = Math.hypot(bx - ax, by - ay) || 1;
    return Math.min(1, Math.hypot(px - ax, py - ay) / r);
  }
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy || 1;
  const t = ((px - ax) * vx + (py - ay) * vy) / len2;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Pick one of `stops` for parameter t with ordered dithering between neighbouring stops. */
export function pickStop<T>(stops: readonly T[], t: number, dither: DitherKind, x: number, y: number): T {
  if (stops.length === 1) return stops[0]!;
  const s = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(s));
  const f = s - i;
  return ditherPick(dither, f, x, y) ? stops[i + 1]! : stops[i]!;
}
