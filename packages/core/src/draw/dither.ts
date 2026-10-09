/** Ordered-dither matrices and fill patterns. */

function bayer(n: number): number[][] {
  if (n === 1) return [[0]];
  const half = bayer(n / 2);
  const size = n;
  const out: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const h = n / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < h; x++) {
      const v = half[y]![x]! * 4;
      out[y]![x] = v;
      out[y]![x + h] = v + 2;
      out[y + h]![x] = v + 3;
      out[y + h]![x + h] = v + 1;
    }
  }
  return out;
}

const MATRICES: Record<number, number[][]> = { 2: bayer(2), 4: bayer(4), 8: bayer(8) };

/** Threshold in (0,1) for an ordered dither matrix of size 2, 4 or 8 at (x, y). */
export function bayerThreshold(size: number, x: number, y: number): number {
  const m = MATRICES[size] ?? MATRICES[4]!;
  const n = m.length;
  const v = m[((y % n) + n) % n]![((x % n) + n) % n]!;
  return (v + 0.5) / (n * n);
}

export type DitherKind = 'none' | 'bayer2' | 'bayer4' | 'bayer8' | 'checker';

/** Returns true when the "second" colour should be used for coverage fraction `t` (0..1) at (x,y). */
export function ditherPick(kind: DitherKind, t: number, x: number, y: number): boolean {
  switch (kind) {
    case 'none':
      return t >= 0.5;
    case 'checker':
      if (t < 0.25) return false;
      if (t >= 0.75) return true;
      return ((x + y) & 1) === 1;
    case 'bayer2':
      return t > bayerThreshold(2, x, y);
    case 'bayer8':
      return t > bayerThreshold(8, x, y);
    default:
      return t > bayerThreshold(4, x, y);
  }
}

export type PatternName =
  | 'checker'
  | 'checker-2'
  | 'lines-h'
  | 'lines-v'
  | 'diagonal'
  | 'diagonal-alt'
  | 'grid'
  | 'dots'
  | 'bricks'
  | 'bayer-25'
  | 'bayer-50'
  | 'bayer-75';

export const PATTERNS: Record<PatternName, readonly string[]> = {
  checker: ['10', '01'],
  'checker-2': ['1100', '1100', '0011', '0011'],
  'lines-h': ['1', '0'],
  'lines-v': ['10'],
  diagonal: ['1000', '0100', '0010', '0001'],
  'diagonal-alt': ['0001', '0010', '0100', '1000'],
  grid: ['1111', '1000', '1000', '1000'],
  dots: ['1000', '0000', '0010', '0000'],
  bricks: ['11111111', '10000000', '10000000', '10000000', '11111111', '00001000', '00001000', '00001000'],
  'bayer-25': ['1000', '0000', '0010', '0000'],
  'bayer-50': ['10', '01'],
  'bayer-75': ['1110', '1111', '1011', '1111'],
};

/** True when pattern rows (strings of 0/1) have a 1 at (x, y) (tiled). */
export function patternHit(rows: readonly string[], x: number, y: number): boolean {
  const h = rows.length;
  if (!h) return false;
  const row = rows[((y % h) + h) % h]!;
  const w = row.length;
  return row[((x % w) + w) % w] === '1';
}
