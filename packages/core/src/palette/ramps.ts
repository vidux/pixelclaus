/**
 * Colour ramps: OKLCH-based generator with hue shifting (shadows → cool, highlights → warm) and
 * automatic ramp detection for palettes without authored ramps.
 */
import { hueDelta, oklchToPacked, packedToOklch } from '../color/oklab.js';
import type { Packed } from '../color/rgba.js';

export interface RampOptions {
  /** Total colours in the ramp including the base. Default 5. */
  steps?: number;
  /** Number of colours darker than the base. Default floor((steps-1)/2). */
  shadowSteps?: number;
  /** OKLCH lightness change per shadow step. Default 0.12 */
  shadowStep?: number;
  /** OKLCH lightness change per highlight step. Default 0.09 */
  highlightStep?: number;
  /** Degrees of hue rotation per shadow step toward the cool target (~260°). Default 18 */
  hueShiftShadow?: number;
  /** Degrees of hue rotation per highlight step toward the warm target (~70°). Default 12 */
  hueShiftHighlight?: number;
  /** Cool target hue. Default 260 */
  shadowHue?: number;
  /** Warm target hue. Default 70 */
  highlightHue?: number;
}

function rotateToward(h: number, target: number, amount: number): number {
  const d = hueDelta(h, target);
  const step = Math.sign(d) * Math.min(Math.abs(d), Math.abs(amount));
  return (h + step + 360) % 360;
}

/** Generate a ramp (dark → light) around `base`. The base colour is included unchanged. */
export function generateRamp(base: Packed, opts: RampOptions = {}): Packed[] {
  const steps = Math.max(2, Math.min(16, opts.steps ?? 5));
  const shadows = Math.max(0, Math.min(steps - 1, opts.shadowSteps ?? Math.floor((steps - 1) / 2)));
  const highlights = steps - 1 - shadows;
  const sStep = opts.shadowStep ?? 0.12;
  const hStep = opts.highlightStep ?? 0.09;
  const hueS = opts.hueShiftShadow ?? 18;
  const hueH = opts.hueShiftHighlight ?? 12;
  const coolHue = opts.shadowHue ?? 260;
  const warmHue = opts.highlightHue ?? 70;
  const b = packedToOklch(base);
  const achromatic = b.C < 0.02;
  const out: Packed[] = [];
  // dark bases: spread the shadow steps evenly down to a floor instead of collapsing them into duplicates
  const floorL = Math.min(0.15, b.L * 0.5);
  const shadowStepL = shadows ? Math.min(sStep, (b.L - floorL) / shadows) : sStep;
  const ceilL = 0.97;
  const highlightStepL = highlights ? Math.min(hStep, Math.max(0.02, (ceilL - b.L) / highlights)) : hStep;
  for (let i = shadows; i >= 1; i--) {
    const L = Math.max(0.02, b.L - shadowStepL * i);
    // chroma bell: +15% at first shadow, falling to 80% at the darkest
    const t = shadows === 1 ? 0 : (i - 1) / (shadows - 1);
    const C = achromatic ? b.C : b.C * (1.15 - 0.35 * t);
    let h = b.h;
    for (let k = 0; k < i; k++) h = rotateToward(h, coolHue, hueS);
    out.push(oklchToPacked({ L, C, h }));
  }
  out.push(base);
  for (let j = 1; j <= highlights; j++) {
    const L = Math.min(0.98, b.L + highlightStepL * j);
    const t = j / highlights;
    const C = achromatic ? b.C : b.C * (1 - 0.45 * t);
    let h = b.h;
    for (let k = 0; k < j; k++) h = rotateToward(h, warmHue, hueH);
    out.push(oklchToPacked({ L, C, h }));
  }
  return out;
}

/** Interpolate `steps` colours between two endpoints in OKLCH (shortest hue path). */
export function rampBetween(dark: Packed, light: Packed, steps: number): Packed[] {
  const a = packedToOklch(dark);
  const b = packedToOklch(light);
  const n = Math.max(2, steps);
  const dh = hueDelta(a.h, b.h);
  const out: Packed[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out.push(
      oklchToPacked({ L: a.L + (b.L - a.L) * t, C: a.C + (b.C - a.C) * t, h: (a.h + dh * t + 360) % 360 }),
    );
  }
  return out;
}

export interface DetectedRamp {
  name: string;
  indices: number[];
}

const HUE_NAMES: Array<[number, string]> = [
  [15, 'red'],
  [45, 'orange'],
  [75, 'brown'],
  [110, 'yellow'],
  [165, 'green'],
  [200, 'teal'],
  [250, 'blue'],
  [300, 'purple'],
  [345, 'pink'],
  [361, 'red'],
];

export function hueName(h: number): string {
  for (const [limit, name] of HUE_NAMES) if (h < limit) return name;
  return 'red';
}

/**
 * Group palette entries (index ≥ 1) into ramps: low-chroma colours form a gray ramp, chromatic colours
 * are clustered by hue (a gap > `hueGap`° or a cluster span > `maxSpan`° starts a new cluster), large
 * clusters are split into saturated/muted ramps, and each ramp is sorted by lightness.
 * Authored ramps (presets, palette action set_ramps) are always better; this is a fallback.
 */
export function detectRamps(colors: readonly Packed[], hueGap = 20, maxSpan = 50): DetectedRamp[] {
  const items = colors.map((c, i) => ({ i, c, lch: packedToOklch(c) })).filter((x) => x.i > 0 && x.c !== 0);
  const grays = items.filter((x) => x.lch.C < 0.035);
  const chroma = items.filter((x) => x.lch.C >= 0.035).sort((a, b) => a.lch.h - b.lch.h);
  type Item = (typeof items)[number];
  let clusters: Item[][] = [];
  for (const it of chroma) {
    const last = clusters[clusters.length - 1];
    const gapOk = last && Math.abs(hueDelta(last[last.length - 1]!.lch.h, it.lch.h)) <= hueGap;
    const spanOk = last && Math.abs(hueDelta(last[0]!.lch.h, it.lch.h)) <= maxSpan;
    if (last && gapOk && spanOk) last.push(it);
    else clusters.push([it]);
  }
  // merge wrap-around cluster (hue ~360 with ~0)
  if (clusters.length > 1) {
    const first = clusters[0]!;
    const last = clusters[clusters.length - 1]!;
    if (
      Math.abs(hueDelta(last[last.length - 1]!.lch.h, first[0]!.lch.h)) <= hueGap &&
      Math.abs(hueDelta(last[0]!.lch.h, first[first.length - 1]!.lch.h)) <= maxSpan
    ) {
      clusters[0] = [...last, ...first];
      clusters.pop();
    }
  }
  // large clusters usually hold parallel ramps: split saturated vs muted
  clusters = clusters.flatMap((cl) => {
    if (cl.length <= 7) return [cl];
    const sorted = [...cl].sort((a, b) => a.lch.C - b.lch.C);
    const mid = Math.floor(sorted.length / 2);
    return [sorted.slice(mid), sorted.slice(0, mid)];
  });
  const ramps: DetectedRamp[] = [];
  const used = new Map<string, number>();
  const pushRamp = (base: string, members: Item[]) => {
    if (members.length < 2) return;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    ramps.push({
      name: n === 1 ? base : `${base}-${n}`,
      indices: [...members].sort((a, b) => a.lch.L - b.lch.L).map((m) => m.i),
    });
  };
  pushRamp('gray', grays);
  for (const cl of clusters) {
    const meanHue = cl.reduce((s, x) => s + x.lch.h, 0) / cl.length;
    pushRamp(hueName(meanHue), cl);
  }
  return ramps;
}

/**
 * The palette index one or more steps darker (negative) or lighter (positive) than `index`,
 * using ramps that contain it; falls back to a perceptual search for a similar-hue neighbour.
 */
export function stepAlongRamps(
  colors: readonly Packed[],
  ramps: ReadonlyArray<{ indices: readonly number[] }>,
  index: number,
  delta: number,
): number {
  if (index <= 0 || delta === 0) return index;
  const ramp = ramps.find((r) => r.indices.includes(index));
  if (ramp) {
    const pos = ramp.indices.indexOf(index);
    const np = Math.max(0, Math.min(ramp.indices.length - 1, pos + delta));
    return ramp.indices[np]!;
  }
  // fallback: walk |delta| times to the closest colour that is darker/lighter
  let cur = index;
  for (let s = 0; s < Math.abs(delta); s++) {
    const base = packedToOklch(colors[cur]!);
    let best = cur;
    let bestScore = Infinity;
    for (let i = 1; i < colors.length; i++) {
      if (i === cur || colors[i] === 0) continue;
      const l = packedToOklch(colors[i]!);
      const dL = l.L - base.L;
      if (delta < 0 ? dL >= -0.02 : dL <= 0.02) continue;
      const hueCost = base.C < 0.035 || l.C < 0.035 ? 0.05 : Math.abs(hueDelta(base.h, l.h)) / 180;
      const score = Math.abs(dL) + hueCost * 0.6 + Math.abs(l.C - base.C) * 0.5;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best === cur) break;
    cur = best;
  }
  return cur;
}
