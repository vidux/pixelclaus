/**
 * Higher-level pixel-art effects: outline, selective outline (selout), ramp shading, light shading.
 * Effects compute their target pixels from a snapshot reader, then the caller writes them.
 */
import { N4, N8 } from '../buffer/mask.js';
import { packedToOklab, oklabToPacked } from '../color/oklab.js';
import type { ColorResolver } from '../model/colors.js';
import type { LightDirection, RampState } from '../model/types.js';
import { stepAlongRamps } from '../palette/ramps.js';
import type { Point } from '../util/geometry.js';

export type Reader = (x: number, y: number) => number;

export interface PixelChange extends Point {
  value: number;
}

export function lightVector(dir: LightDirection): Point {
  const x = dir.includes('left') ? -1 : dir.includes('right') ? 1 : 0;
  const y = dir.startsWith('top') ? -1 : dir.startsWith('bottom') ? 1 : 0;
  return { x, y };
}

/** Pixels to paint for an outline around (outside) or along (inside) the opaque area. */
export function outlinePixels(
  read: Reader,
  w: number,
  h: number,
  side: 'outside' | 'inside',
  connectivity: 4 | 8,
): Point[] {
  const nb = connectivity === 4 ? N4 : N8;
  const out: Point[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = read(x, y);
      if (side === 'outside') {
        if (v !== 0) continue;
        if (nb.some(([dx, dy]) => read(x + dx, y + dy) !== 0)) out.push({ x, y });
      } else {
        if (v === 0) continue;
        if (nb.some(([dx, dy]) => read(x + dx, y + dy) === 0)) out.push({ x, y });
      }
    }
  }
  return out;
}

/** Shifts pixel values along palette ramps (falls back to perceptual darken/lighten off-palette). */
export class RampShifter {
  private readonly resolver: ColorResolver;
  private readonly ramps: readonly RampState[];
  private readonly indexed: boolean;

  constructor(resolver: ColorResolver, ramps: readonly RampState[], indexed: boolean) {
    this.resolver = resolver;
    this.ramps = ramps;
    this.indexed = indexed;
  }

  shift(value: number, delta: number, rampName?: string): number {
    if (value === 0 || delta === 0) return value;
    const ramps = rampName
      ? this.ramps.filter((r) => r.name.toLowerCase() === rampName.toLowerCase())
      : this.ramps;
    const pal = this.resolver.palette;
    const idx = this.indexed ? value : this.resolver.paletteMatcher.exact(value);
    if (idx > 0) {
      const n = stepAlongRamps(pal, ramps.length ? ramps : this.ramps, idx, delta);
      return this.indexed ? n : (pal[n] ?? value);
    }
    // off-palette RGBA: adjust OKLab lightness, then apply palette policy
    const lab = packedToOklab(value);
    lab.L = Math.max(0, Math.min(1, lab.L + delta * 0.1));
    return this.resolver.fromRgba(oklabToPacked(lab, value & 255));
  }
}

/** Most frequent value among `values`. */
function mode(values: number[]): number | undefined {
  const m = new Map<number, number>();
  let best: number | undefined;
  let bestN = 0;
  for (const v of values) {
    const n = (m.get(v) ?? 0) + 1;
    m.set(v, n);
    if (n > bestN) {
      bestN = n;
      best = v;
    }
  }
  return best;
}

/**
 * Selective outline: recolour silhouette-edge pixels from the colour they enclose. Light-facing edges
 * become one ramp step darker than the interior, side edges two steps, shadow-facing edges keep the
 * existing outline (or `shadowValue`).
 */
export function seloutChanges(
  read: Reader,
  w: number,
  h: number,
  light: LightDirection,
  shifter: RampShifter,
  opts: { lightSteps?: number; sideSteps?: number; shadowValue?: number } = {},
): PixelChange[] {
  const L = lightVector(light);
  const len = Math.hypot(L.x, L.y) || 1;
  const isEdge = (x: number, y: number) =>
    read(x, y) !== 0 && N4.some(([dx, dy]) => read(x + dx, y + dy) === 0);
  const changes: PixelChange[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isEdge(x, y)) continue;
      let nx = 0;
      let ny = 0;
      const interior: number[] = [];
      for (const [dx, dy] of N8) {
        const v = read(x + dx, y + dy);
        if (v === 0) {
          nx += dx;
          ny += dy;
        } else if (!isEdge(x + dx, y + dy)) interior.push(v);
      }
      const base = mode(interior);
      if (base === undefined) continue;
      const nlen = Math.hypot(nx, ny) || 1;
      const dot = (nx * L.x + ny * L.y) / (nlen * len);
      let value: number;
      if (dot > 0.3) value = shifter.shift(base, -(opts.lightSteps ?? 1));
      else if (dot < -0.3) value = opts.shadowValue ?? read(x, y);
      else value = shifter.shift(base, -(opts.sideSteps ?? 2));
      // if the interior is already the darkest step, recolouring would merge the outline into the fill
      if (value === base) value = read(x, y);
      if (value !== read(x, y)) changes.push({ x, y, value });
    }
  }
  return changes;
}

/**
 * Light-direction shading: pixels whose light-facing neighbour is empty get highlighted, pixels within
 * `depth` of an edge facing away from the light get shadowed. `edgeValues` (e.g. the outline colour) are
 * treated as empty and never recoloured.
 */
export function lightShadeChanges(
  read: Reader,
  w: number,
  h: number,
  light: LightDirection,
  shifter: RampShifter,
  opts: {
    highlight?: number;
    shadow?: number;
    depth?: number;
    edgeValues?: ReadonlySet<number>;
    ramp?: string;
  } = {},
): PixelChange[] {
  const L = lightVector(light);
  const edge = opts.edgeValues ?? new Set<number>();
  const empty = (x: number, y: number) => {
    const v = read(x, y);
    return v === 0 || edge.has(v);
  };
  const depth = Math.max(1, opts.depth ?? 1);
  const hi = opts.highlight ?? 1;
  const sh = opts.shadow ?? 1;
  // for diagonal light, both orthogonal neighbours face the light too (top-left → up, left, up-left)
  const toward: Array<[number, number]> = [[L.x, L.y]];
  if (L.x !== 0 && L.y !== 0) toward.push([L.x, 0], [0, L.y]);
  const changes: PixelChange[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = read(x, y);
      if (v === 0 || edge.has(v)) continue;
      if (hi && toward.some(([dx, dy]) => empty(x + dx, y + dy))) {
        const nv = shifter.shift(v, hi, opts.ramp);
        if (nv !== v) changes.push({ x, y, value: nv });
        continue;
      }
      if (sh) {
        for (let k = 1; k <= depth; k++) {
          if (toward.some(([dx, dy]) => empty(x - dx * k, y - dy * k))) {
            const nv = shifter.shift(v, -sh, opts.ramp);
            if (nv !== v) changes.push({ x, y, value: nv });
            break;
          }
        }
      }
    }
  }
  return changes;
}
