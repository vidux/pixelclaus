/** Rasterisation of pixel-art primitives. All functions return canvas-space integer points. */
import type { Point, Rect } from '../util/geometry.js';

/** Bresenham line, endpoints inclusive. */
export function linePoints(x0: number, y0: number, x1: number, y1: number): Point[] {
  x0 = Math.round(x0);
  y0 = Math.round(y0);
  x1 = Math.round(x1);
  y1 = Math.round(y1);
  const pts: Point[] = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    pts.push({ x, y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return pts;
}

/** Polyline through points (shared vertices not duplicated). */
export function polylinePoints(points: readonly Point[], closed = false): Point[] {
  if (points.length === 0) return [];
  if (points.length === 1) return [{ x: Math.round(points[0]!.x), y: Math.round(points[0]!.y) }];
  const out: Point[] = [];
  const seq = closed ? [...points, points[0]!] : points;
  for (let i = 0; i < seq.length - 1; i++) {
    const seg = linePoints(seq[i]!.x, seq[i]!.y, seq[i + 1]!.x, seq[i + 1]!.y);
    // no spread: a long segment (131k points) would overflow the call stack
    for (let k = i > 0 ? 1 : 0; k < seg.length; k++) out.push(seg[k]!);
  }
  if (closed && out.length > 1) {
    const f = out[0]!;
    const l = out[out.length - 1]!;
    if (f.x === l.x && f.y === l.y) out.pop();
  }
  return out;
}

/**
 * Pixel-perfect filter: removes "L-corner" pixels from a 1-px stroke so diagonal lines have no doubles.
 * Point b is dropped when a and c (its neighbours in the stroke) are diagonal to each other and b is
 * orthogonally adjacent to both.
 */
export function pixelPerfect(points: readonly Point[]): Point[] {
  if (points.length < 3) return [...points];
  const out: Point[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1]!;
    const b = points[i]!;
    const c = points[i + 1]!;
    const lCorner =
      Math.abs(a.x - c.x) === 1 &&
      Math.abs(a.y - c.y) === 1 &&
      (a.x === b.x || a.y === b.y) &&
      (c.x === b.x || c.y === b.y);
    if (!lCorner) out.push(b);
  }
  out.push(points[points.length - 1]!);
  return out;
}

export type BrushShape = 'square' | 'circle';

/** Pixel offsets covered by a brush of `size` centred on (0,0). */
export function brushOffsets(size: number, shape: BrushShape = 'circle'): Point[] {
  const n = Math.max(1, Math.round(size));
  if (n === 1) return [{ x: 0, y: 0 }];
  const off = Math.floor((n - 1) / 2);
  const c = (n - 1) / 2;
  const r = n / 2 - 0.25;
  const out: Point[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (shape === 'circle' && (x - c) ** 2 + (y - c) ** 2 > r * r) continue;
      out.push({ x: x - off, y: y - off });
    }
  }
  return out;
}

/** Stamp a brush along a stroke; returns unique points. */
export function strokeWithBrush(
  points: readonly Point[],
  size: number,
  shape: BrushShape,
  clip?: Rect,
): Point[] {
  const inClip = (x: number, y: number, pad: number) =>
    !clip ||
    (x >= clip.x - pad && y >= clip.y - pad && x < clip.x + clip.w + pad && y < clip.y + clip.h + pad);
  if (size <= 1) return clip ? points.filter((p) => inClip(p.x, p.y, 0)) : [...points];
  const offs = brushOffsets(size, shape);
  const reach = Math.ceil(size / 2) + 1;
  const seen = new Set<number>();
  const out: Point[] = [];
  for (const p of points) {
    // expanding off-screen points by the brush is the expensive part: skip them first
    if (!inClip(p.x, p.y, reach)) continue;
    for (const o of offs) {
      const x = p.x + o.x;
      const y = p.y + o.y;
      if (!inClip(x, y, 0)) continue;
      const k = (y + 262144) * 524288 + (x + 262144);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ x, y });
    }
  }
  return out;
}

/** Intersection helper: limits rasterisation work to the visible area. */
function clipBounds(r: Rect, clip?: Rect): { x0: number; y0: number; x1: number; y1: number } {
  const x0 = clip ? Math.max(r.x, clip.x) : r.x;
  const y0 = clip ? Math.max(r.y, clip.y) : r.y;
  const x1 = clip ? Math.min(r.x + r.w, clip.x + clip.w) : r.x + r.w;
  const y1 = clip ? Math.min(r.y + r.h, clip.y + clip.h) : r.y + r.h;
  return { x0, y0, x1, y1 };
}

export function rectOutlinePoints(r: Rect, thickness = 1, clip?: Rect): Point[] {
  const out: Point[] = [];
  const t = Math.max(1, thickness);
  const { x0, y0, x1, y1 } = clipBounds(r, clip);
  for (let y = y0; y < y1; y++) {
    const band = y < r.y + t || y >= r.y + r.h - t;
    if (band) {
      for (let x = x0; x < x1; x++) out.push({ x, y });
      continue;
    }
    for (let x = Math.max(x0, r.x); x < Math.min(x1, r.x + t); x++) out.push({ x, y });
    for (let x = Math.max(x0, r.x + r.w - t, r.x + t); x < Math.min(x1, r.x + r.w); x++) out.push({ x, y });
  }
  return out;
}

export function rectFillPoints(r: Rect, clip?: Rect): Point[] {
  const out: Point[] = [];
  const { x0, y0, x1, y1 } = clipBounds(r, clip);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out.push({ x, y });
  return out;
}

/**
 * Walk the outline of the ellipse inscribed in a bounding box (Zingl's rasteriser) — handles even and
 * odd sizes and produces clean small circles. Points may repeat.
 */
function walkEllipse(r: Rect, put: (x: number, y: number) => void): void {
  let x0 = r.x;
  let y0 = r.y;
  let x1 = r.x + r.w - 1;
  let y1 = r.y + r.h - 1;
  let a = Math.abs(x1 - x0);
  const b = Math.abs(y1 - y0);
  let b1 = b & 1;
  let dx = 4 * (1 - a) * b * b;
  let dy = 4 * (b1 + 1) * a * a;
  let err = dx + dy + b1 * a * a;
  y0 += Math.floor((b + 1) / 2);
  y1 = y0 - b1;
  a = 8 * a * a;
  b1 = 8 * b * b;
  do {
    put(x1, y0);
    put(x0, y0);
    put(x0, y1);
    put(x1, y1);
    const e2 = 2 * err;
    if (e2 <= dy) {
      y0++;
      y1--;
      dy += a;
      err += dy;
    }
    if (e2 >= dx || 2 * err > dy) {
      x0++;
      x1--;
      dx += b1;
      err += dx;
    }
  } while (x0 <= x1);
  while (y0 - y1 <= b) {
    put(x0 - 1, y0);
    put(x1 + 1, y0++);
    put(x0 - 1, y1);
    put(x1 + 1, y1--);
  }
}

/**
 * Outline of the ellipse inscribed in r. Only points inside `clip` are returned: a huge ellipse is still
 * walked in O(perimeter) integer steps, but no off-canvas points are stored.
 */
export function ellipseOutlinePoints(r: Rect, clip?: Rect): Point[] {
  if (r.w <= 0 || r.h <= 0) return [];
  if (r.w <= 2 || r.h <= 2) return rectFillPoints(r, clip);
  const bx0 = clip ? Math.max(r.x, clip.x) : r.x;
  const by0 = clip ? Math.max(r.y, clip.y) : r.y;
  const bx1 = clip ? Math.min(r.x + r.w, clip.x + clip.w) : r.x + r.w;
  const by1 = clip ? Math.min(r.y + r.h, clip.y + clip.h) : r.y + r.h;
  if (bx1 <= bx0 || by1 <= by0) return [];
  const bw = bx1 - bx0;
  const seen = new Set<number>();
  const out: Point[] = [];
  walkEllipse(r, (x, y) => {
    if (x < bx0 || y < by0 || x >= bx1 || y >= by1) return;
    const k = (y - by0) * bw + (x - bx0);
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ x, y });
  });
  return out;
}

/** Filled ellipse: every pixel between the outline's extremes on each (visible) row. */
export function ellipseFillPoints(r: Rect, clip?: Rect): Point[] {
  if (r.w <= 0 || r.h <= 0) return [];
  if (r.w <= 2 || r.h <= 2) return rectFillPoints(r, clip);
  const y0 = clip ? Math.max(r.y, clip.y) : r.y;
  const y1 = clip ? Math.min(r.y + r.h, clip.y + clip.h) : r.y + r.h;
  const rows = new Map<number, [number, number]>();
  walkEllipse(r, (x, y) => {
    if (y < y0 || y >= y1 || x < r.x || x >= r.x + r.w) return;
    const cur = rows.get(y);
    if (!cur) rows.set(y, [x, x]);
    else {
      if (x < cur[0]) cur[0] = x;
      if (x > cur[1]) cur[1] = x;
    }
  });
  const out: Point[] = [];
  for (const [y, [a, b]] of rows) {
    const xa = clip ? Math.max(a, clip.x) : a;
    const xb = clip ? Math.min(b, clip.x + clip.w - 1) : b;
    for (let x = xa; x <= xb; x++) out.push({ x, y });
  }
  return out;
}

/** Circle from centre + radius, as an ellipse in a (2r+1) box. */
export function circleRect(cx: number, cy: number, radius: number): Rect {
  const r = Math.max(0, Math.round(radius));
  return { x: Math.round(cx) - r, y: Math.round(cy) - r, w: 2 * r + 1, h: 2 * r + 1 };
}

/** Even-odd scanline polygon fill sampled at pixel centres, plus its outline for crisp edges. */
export function polygonFillPoints(vertices: readonly Point[], clip?: Rect): Point[] {
  if (vertices.length < 3) return polylinePoints(vertices, true);
  let minY = Infinity;
  let maxY = -Infinity;
  for (const v of vertices) {
    minY = Math.min(minY, v.y);
    maxY = Math.max(maxY, v.y);
  }
  const out = new Map<number, Point>();
  const put = (x: number, y: number) => out.set(y * 100000 + x, { x, y });
  const yStart = clip ? Math.max(Math.floor(minY), clip.y) : Math.floor(minY);
  const yEnd = clip ? Math.min(Math.ceil(maxY), clip.y + clip.h - 1) : Math.ceil(maxY);
  for (let y = yStart; y <= yEnd; y++) {
    const sy = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i]!;
      const b = vertices[(i + 1) % vertices.length]!;
      const ay = a.y + 0.5;
      const by = b.y + 0.5;
      if (ay === by) continue;
      if ((sy >= ay && sy < by) || (sy >= by && sy < ay)) {
        xs.push(a.x + 0.5 + ((sy - ay) / (by - ay)) * (b.x - a.x));
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      let xa = Math.ceil(xs[i]! - 0.5);
      let xb = Math.floor(xs[i + 1]! - 0.5);
      if (clip) {
        xa = Math.max(xa, clip.x);
        xb = Math.min(xb, clip.x + clip.w - 1);
      }
      for (let x = xa; x <= xb; x++) put(x, y);
    }
  }
  for (const p of polylinePoints(vertices, true)) put(p.x, p.y);
  return [...out.values()];
}

export function pointsBounds(points: readonly Point[]): Rect | null {
  if (!points.length) return null;
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
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
