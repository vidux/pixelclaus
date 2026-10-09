/**
 * Lint rules that look at shapes inside one frame: line art (doubles, jaggies), pillow shading, banding.
 */
import { N4, N8 } from '../buffer/mask.js';
import type { Raster } from '../buffer/raster.js';
import { lightness } from '../color/oklab.js';
import type { Packed } from '../color/rgba.js';
import { lightVector } from '../draw/effects.js';
import type { LightDirection } from '../model/types.js';
import type { Point } from '../util/geometry.js';
import { opaque, sample, type LintFinding, type LintRule } from './lint-types.js';

/**
 * Line-art pixels = pixels in the outline colour: `outline` if given, else the colour covering ≥ 50% of
 * the silhouette edge. Shading rims, highlights and colour boundaries are not lines and are skipped.
 */
export function lineArtMask(r: Raster, outlineColor: Packed | null): Uint8Array {
  const W = r.width;
  const H = r.height;
  const isEdge = (x: number, y: number) =>
    r.get(x, y) !== 0 && N8.some(([dx, dy]) => r.get(x + dx, y + dy) === 0);
  const counts = new Map<Packed, number>();
  let edges = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (isEdge(x, y)) {
        edges++;
        const c = r.get(x, y);
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
  let outline: Packed | null = outlineColor;
  if (outline === null) {
    // an outline is the dominant edge colour AND darker than the inside (a light rim is a highlight)
    let innerL = 0;
    let innerN = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const c = r.get(x, y);
        if (c !== 0 && !isEdge(x, y)) {
          innerL += lightness(c);
          innerN++;
        }
      }
    const meanInner = innerN ? innerL / innerN : 1;
    for (const [c, n] of counts)
      if (n / Math.max(1, edges) >= 0.5 && lightness(c) < meanInner - 0.05) outline = c;
  }
  const m = new Uint8Array(W * H);
  if (outline === null) return m;
  for (let i = 0; i < W * H; i++) if (r.get(i % W, (i / W) | 0) === outline) m[i] = 1;
  return m;
}

export function lineChecks(
  r: Raster,
  frame: number,
  rules: Set<LintRule>,
  out: LintFinding[],
  outlineColor: Packed | null,
): void {
  const W = r.width;
  const H = r.height;
  const line = lineArtMask(r, outlineColor);
  const same = (x: number, y: number, c: Packed) => x >= 0 && y >= 0 && x < W && y < H && r.get(x, y) === c;
  const degree = (x: number, y: number, c: Packed) => N8.filter(([dx, dy]) => same(x + dx, y + dy, c)).length;
  if (rules.has('doubles')) {
    const hits: Point[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = r.get(x, y);
        if (c === 0 || !line[y * W + x]) continue;
        // part of a solid 2x2 block → area, not a 1-px line
        if (
          (
            [
              [1, 1],
              [1, -1],
              [-1, 1],
              [-1, -1],
            ] as const
          ).some(([dx, dy]) => same(x + dx, y, c) && same(x, y + dy, c) && same(x + dx, y + dy, c))
        )
          continue;
        for (const [hx, vy] of [
          [1, 1],
          [1, -1],
          [-1, 1],
          [-1, -1],
        ] as const) {
          if (!same(x + hx, y, c) || !same(x, y + vy, c) || same(x + hx, y + vy, c)) continue;
          const straight = same(x + 2 * hx, y, c) && same(x, y + 2 * vy, c);
          if (!straight) {
            hits.push({ x, y });
            break;
          }
        }
      }
    }
    if (hits.length)
      out.push({
        rule: 'doubles',
        severity: 'warning',
        frame,
        count: hits.length,
        pixels: sample(hits),
        message: `${hits.length} L-shaped corner pixel(s) in 1-px lines ("doubles")`,
        hint: 'Remove the corner pixel so the line steps diagonally (path ops with pixelPerfect:true avoid this)',
      });
  }
  if (rules.has('jaggies')) {
    // horizontal runs of thin-line pixels chained diagonally; flag dips/spikes in run length
    const hits: Point[] = [];
    const check = (
      get: (a: number, b: number) => Packed,
      A: number,
      B: number,
      toPoint: (a: number, b: number) => Point,
    ) => {
      for (let b = 0; b < B; b++) {
        let a = 0;
        while (a < A) {
          const c = get(a, b);
          if (c === 0) {
            a++;
            continue;
          }
          let e = a;
          while (e + 1 < A && get(e + 1, b) === c) e++;
          // follow chain: next run starts diagonally after e on b+1 or b-1
          const runs: Array<{ len: number; at: Point }> = [{ len: e - a + 1, at: toPoint(a, b) }];
          let curEnd = e;
          let row = b;
          let dir = 0; // lock the vertical direction: a slope that turns (top of a circle) is a curve, not a jaggy
          for (let guard = 0; guard < 64; guard++) {
            let found = false;
            for (const dr of dir ? [dir] : [1, -1]) {
              const nr = row + dr;
              if (nr < 0 || nr >= B) continue;
              const ns = curEnd + 1;
              if (ns >= A || get(ns, nr) !== c || get(ns - 1, nr) === c) continue;
              let ne = ns;
              while (ne + 1 < A && get(ne + 1, nr) === c) ne++;
              runs.push({ len: ne - ns + 1, at: toPoint(ns, nr) });
              curEnd = ne;
              row = nr;
              dir = dr;
              found = true;
              break;
            }
            if (!found) break;
          }
          if (runs.length >= 4) {
            for (let i = 1; i + 1 < runs.length; i++) {
              const p = runs[i - 1]!.len;
              const q = runs[i]!.len;
              const s = runs[i + 1]!.len;
              if ((q + 1 < p && q + 1 < s) || (q > p + 1 && q > s + 1)) hits.push(runs[i]!.at);
            }
          }
          a = e + 1;
        }
      }
    };
    // only thin (line-like) pixels take part: ≤ 2 same-colour 8-neighbours
    const thin = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const c = r.get(x, y);
        if (c !== 0 && line[y * W + x] && degree(x, y, c) <= 2) thin[y * W + x] = 1;
      }
    const lineAt = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < W && y < H && thin[y * W + x] ? r.get(x, y) : 0;
    check(
      (x, y) => lineAt(x, y),
      W,
      H,
      (x, y) => ({ x, y }),
    );
    check(
      (y, x) => lineAt(x, y),
      H,
      W,
      (y, x) => ({ x, y }),
    );
    const uniq = [...new Map(hits.map((p) => [`${p.x},${p.y}`, p])).values()];
    if (uniq.length)
      out.push({
        rule: 'jaggies',
        severity: 'info',
        frame,
        count: uniq.length,
        pixels: sample(uniq),
        message: `${uniq.length} irregular step(s) in diagonal lines (run lengths like 3-1-3)`,
        hint: 'Use consistent run lengths along a slope (e.g. 2-2-2 or 3-2-3-2) for smooth lines',
      });
  }
}

export function pillowCheck(r: Raster, frame: number, out: LintFinding[], light: LightDirection): void {
  // silhouette-edge pixels (usually the outline) are excluded: they are always the darkest band
  const interior = (x: number, y: number) =>
    opaque(r, x, y) && N4.every(([dx, dy]) => opaque(r, x + dx, y + dy));
  let n = 0;
  let sx = 0;
  let sy = 0;
  let maxD = 0;
  for (let y = 0; y < r.height; y++)
    for (let x = 0; x < r.width; x++) {
      if (!interior(x, y)) continue;
      n++;
      sx += x;
      sy += y;
    }
  if (n < 30) return;
  const cx = sx / n;
  const cy = sy / n;
  for (let y = 0; y < r.height; y++)
    for (let x = 0; x < r.width; x++) if (interior(x, y)) maxD = Math.max(maxD, Math.hypot(x - cx, y - cy));
  if (maxD < 4) return;
  const L = lightVector(light);
  let litS = 0;
  let litN = 0;
  let shS = 0;
  let shN = 0;
  // per sector: mean lightness in inner / middle / outer bands
  const bands = Array.from({ length: 8 }, () => [0, 0, 0].map(() => ({ s: 0, n: 0 })));
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      if (!interior(x, y)) continue;
      const l = lightness(r.get(x, y));
      const d = Math.hypot(x - cx, y - cy) / maxD;
      const sector = Math.floor(((Math.atan2(y - cy, x - cx) + Math.PI) / (2 * Math.PI)) * 8) % 8;
      const band = d < 0.34 ? 0 : d < 0.67 ? 1 : 2;
      const cell = bands[sector]![band]!;
      cell.s += l;
      cell.n++;
      const dot = (x - cx) * L.x + (y - cy) * L.y;
      if (dot > 0) {
        litS += l;
        litN++;
      } else if (dot < 0) {
        shS += l;
        shN++;
      }
    }
  }
  let concentric = 0;
  for (const s of bands) {
    if (s.some((b) => b.n === 0)) continue;
    const [i, m, o] = s.map((b) => b.s / b.n) as [number, number, number];
    if (i > m + 0.02 && m > o + 0.02) concentric++;
  }
  // true pillow shading is radially symmetric: the light and shadow halves end up equally bright
  const asym = litN && shN ? Math.abs(litS / litN - shS / shN) : 0;
  if (concentric >= 6 && asym < 0.03) {
    out.push({
      rule: 'pillow-shading',
      severity: 'warning',
      frame,
      count: concentric,
      message: `Lightness rises toward the centre in ${concentric}/8 directions and both halves are equally lit (pillow shading)`,
      hint: `Commit to the light direction (${light}): highlights on the light-facing side, shadows on the far side`,
    });
  }
}

export function bandingCheck(r: Raster, frame: number, out: LintFinding[]): void {
  // candidate per row: start x of three consecutive equal-width (≥2) runs stepping monotonically in lightness
  const cands: number[][] = [];
  for (let y = 0; y < r.height; y++) {
    const runs: Array<{ c: Packed; len: number; x: number }> = [];
    let x = 0;
    while (x < r.width) {
      const c = r.get(x, y);
      let e = x;
      while (e + 1 < r.width && r.get(e + 1, y) === c) e++;
      runs.push({ c, len: e - x + 1, x });
      x = e + 1;
    }
    const rowC: number[] = [];
    for (let i = 0; i + 2 < runs.length; i++) {
      const [a, b, c] = [runs[i]!, runs[i + 1]!, runs[i + 2]!];
      if (a.c === 0 || b.c === 0 || c.c === 0) continue;
      if (a.len >= 2 && a.len === b.len && b.len === c.len) {
        const la = lightness(a.c);
        const lb = lightness(b.c);
        const lc = lightness(c.c);
        if ((la < lb && lb < lc) || (la > lb && lb > lc)) rowC.push(b.x);
      }
    }
    cands.push(rowC);
  }
  // banding = the same stair-step repeated on ≥ 3 consecutive rows with a constant shift (bands follow the contour)
  const hits: Point[] = [];
  for (let y = 0; y + 2 < cands.length; y++) {
    for (const p0 of cands[y]!) {
      for (const d of [-2, -1, 0, 1, 2]) {
        if (cands[y + 1]!.includes(p0 + d) && cands[y + 2]!.includes(p0 + 2 * d)) {
          hits.push({ x: p0, y });
          break;
        }
      }
    }
  }
  if (hits.length)
    out.push({
      rule: 'banding',
      severity: 'warning',
      frame,
      count: hits.length,
      pixels: sample(hits),
      message: `Equal-width colour bands repeat in lock-step over ${hits.length + 2}+ rows (banding)`,
      hint: 'Vary the widths of shade bands and break the stair-step alignment',
    });
}
