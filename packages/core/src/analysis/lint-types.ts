/**
 * Lint types and small shared helpers (rule ids, finding/report shapes, sampling).
 */
import type { Raster } from '../buffer/raster.js';
import type { FrameSpec } from '../model/lookup.js';
import type { Point } from '../util/geometry.js';

export const LINT_RULES = [
  'stray-pixels',
  'orphan-pixels',
  'doubles',
  'jaggies',
  'semi-transparent',
  'off-palette',
  'near-duplicate-colors',
  'color-budget',
  'unused-palette',
  'ramp-contrast',
  'pillow-shading',
  'banding',
  'outline-gaps',
  'black-outline',
  'rare-colors',
  'baseline-drift',
  'frame-jitter',
  'size-drift',
  'background-contrast',
  'detail-density',
  'tile-seams',
  'symmetry',
] as const;
export type LintRule = (typeof LINT_RULES)[number];

/** Rules that only make sense when asked for. */
export const OPT_IN_RULES: readonly LintRule[] = ['tile-seams', 'symmetry'];

export type Severity = 'error' | 'warning' | 'info';

export interface LintFinding {
  rule: LintRule;
  severity: Severity;
  message: string;
  frame?: number;
  /** All frames with this identical finding (findings are merged across frames). */
  frames?: number[];
  count?: number;
  /** Up to 24 example locations. */
  pixels?: Point[];
  hint?: string;
}

export interface LintRequest {
  rules?: readonly LintRule[];
  /** Frames to check (default: all). */
  frames?: FrameSpec;
  /** Lint a single layer instead of the composite. */
  layer?: string;
  /** Tag for animation rules (default: each tag, or all frames). */
  tag?: string;
}

export interface LintReport {
  findings: LintFinding[];
  checked: { frames: number[]; rules: LintRule[]; layer: string | null };
  summary: { errors: number; warnings: number; infos: number };
}

export const MAX_PIXELS = 24;

export function sample<T>(arr: T[]): T[] {
  return arr.slice(0, MAX_PIXELS);
}

/** Default colour budget from canvas size (expert table). */
export function defaultBudget(w: number, h: number): number {
  const m = Math.max(w, h);
  if (m <= 16) return 6;
  if (m <= 32) return 10;
  if (m <= 64) return 19;
  return 32;
}

export function opaque(r: Raster, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= r.width || y >= r.height) return false;
  return r.data[(y * r.width + x) * 4 + 3]! > 0;
}
