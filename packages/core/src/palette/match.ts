import { packedToOklab, type Lab } from '../color/oklab.js';
import { alpha, type Packed } from '../color/rgba.js';

/**
 * Perceptual nearest-colour lookup into a palette. Index 0 (transparent) is only returned for
 * transparent / mostly transparent inputs.
 */
export class PaletteMatcher {
  readonly colors: readonly Packed[];
  private readonly labs: Array<Lab | null>;
  private readonly cache = new Map<Packed, number>();
  private readonly exactMap = new Map<Packed, number>();

  constructor(colors: readonly Packed[]) {
    this.colors = colors;
    this.labs = colors.map((c, i) => (i === 0 || c === 0 ? null : packedToOklab(c)));
    colors.forEach((c, i) => {
      if (!this.exactMap.has(c)) this.exactMap.set(c, i);
    });
  }

  /** Index of an exactly matching colour, or -1. */
  exact(c: Packed): number {
    if (c === 0) return 0;
    return this.exactMap.get(c) ?? -1;
  }

  nearest(c: Packed): number {
    if (alpha(c) < 128 && !this.hasSemiTransparent()) return 0;
    const hit = this.cache.get(c);
    if (hit !== undefined) return hit;
    const ex = this.exactMap.get(c);
    if (ex !== undefined) {
      this.cache.set(c, ex);
      return ex;
    }
    const lab = packedToOklab(c);
    const a = alpha(c) / 255;
    let best = 0;
    let bestD = Infinity;
    for (let i = 1; i < this.labs.length; i++) {
      const l = this.labs[i];
      if (!l) continue;
      const dL = lab.L - l.L;
      const da = lab.a - l.a;
      const db = lab.b - l.b;
      const dA = a - alpha(this.colors[i]!) / 255;
      const d = dL * dL + da * da + db * db + dA * dA;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best === 0 && alpha(c) < 128) best = 0;
    this.cache.set(c, best);
    return best;
  }

  /** ΔE between a colour and its nearest palette entry. */
  distanceToNearest(c: Packed): number {
    const i = this.nearest(c);
    const l = this.labs[i];
    if (!l) return 0;
    const lab = packedToOklab(c);
    return Math.sqrt((lab.L - l.L) ** 2 + (lab.a - l.a) ** 2 + (lab.b - l.b) ** 2);
  }

  private semi: boolean | undefined;
  private hasSemiTransparent(): boolean {
    if (this.semi === undefined)
      this.semi = this.colors.some((c, i) => i > 0 && alpha(c) > 0 && alpha(c) < 255);
    return this.semi;
  }
}
