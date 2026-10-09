/** Axis-aligned rectangle; `w`/`h` are sizes, so the covered pixels are x..x+w-1, y..y+h-1. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export function rect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, w, h };
}

/** Snap a rect to whole pixels (x/y rounded, w/h rounded and at least 0). */
export function roundRect(r: Rect): Rect {
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    w: Math.max(0, Math.round(r.w)),
    h: Math.max(0, Math.round(r.h)),
  };
}

export function isEmptyRect(r: Rect | null | undefined): boolean {
  return !r || r.w <= 0 || r.h <= 0;
}

export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a || isEmptyRect(a)) return b && !isEmptyRect(b) ? { ...b } : null;
  if (!b || isEmptyRect(b)) return { ...a };
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

export function pointInRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

/** Bounding rect of a set of points (inclusive pixel coverage). */
export function boundsOfPoints(points: readonly Point[], pad = 0): Rect | null {
  if (points.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return {
    x: Math.floor(x0) - pad,
    y: Math.floor(y0) - pad,
    w: Math.floor(x1) - Math.floor(x0) + 1 + 2 * pad,
    h: Math.floor(y1) - Math.floor(y0) + 1 + 2 * pad,
  };
}

export function rectToString(r: Rect | null): string {
  return r ? `${r.x},${r.y} ${r.w}x${r.h}` : 'none';
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 9-point anchor used by canvas resize. */
export type Anchor =
  'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right';

export const ANCHORS: readonly Anchor[] = [
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
];

/** Offset at which old content lands in a resized canvas for a given anchor. */
export function anchorOffset(oldW: number, oldH: number, newW: number, newH: number, anchor: Anchor): Point {
  const dx = newW - oldW;
  const dy = newH - oldH;
  const fx = anchor.endsWith('left') ? 0 : anchor.endsWith('right') ? 1 : 0.5;
  const fy = anchor.startsWith('top') ? 0 : anchor.startsWith('bottom') ? 1 : 0.5;
  // 'left' / 'right' / 'center' have no vertical prefix → centered vertically
  return { x: Math.floor(dx * fx), y: Math.floor(dy * fy) };
}

/** Deep copy of plain JSON data (document state is always JSON-safe). */
export function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
