import type { Point } from '../util/geometry.js';
import type { PointInput } from './draw-types.js';

/** Normalise `[x, y]` or `{x, y}` to an integer point. */
export function toPoint(p: PointInput): Point {
  if (Array.isArray(p)) return { x: Math.round(p[0] as number), y: Math.round(p[1] as number) };
  const o = p as { x: number; y: number };
  return { x: Math.round(o.x), y: Math.round(o.y) };
}
