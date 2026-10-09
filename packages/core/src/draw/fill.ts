import { Mask } from '../buffer/mask.js';

export interface FloodOptions {
  /** Only connected pixels (true, default) or every matching pixel on the canvas (false). */
  contiguous?: boolean;
  connectivity?: 4 | 8;
  /** Maximum distance between seed and candidate (semantics defined by `match`). */
  tolerance?: number;
}

/**
 * Compute the flood-fill region starting at (sx, sy).
 * `sample(x, y)` returns the comparable value at a pixel; `match(seed, v, tolerance)` decides membership.
 */
export function floodRegion(
  width: number,
  height: number,
  sx: number,
  sy: number,
  sample: (x: number, y: number) => number,
  match: (seed: number, v: number, tolerance: number) => boolean,
  opts: FloodOptions = {},
): Mask {
  const mask = new Mask(width, height);
  // seeds index typed arrays: a fractional seed would never mark itself visited (endless loop)
  sx = Math.round(sx);
  sy = Math.round(sy);
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx < 0 || sy < 0 || sx >= width || sy >= height)
    return mask;
  const tol = opts.tolerance ?? 0;
  const seed = sample(sx, sy);
  if (opts.contiguous === false) {
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) if (match(seed, sample(x, y), tol)) mask.data[y * width + x] = 1;
    return mask;
  }
  const eight = opts.connectivity === 8;
  const visited = new Uint8Array(width * height);
  const stack: number[] = [sy * width + sx];
  visited[sy * width + sx] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % width;
    const y = (i / width) | 0;
    if (!match(seed, sample(x, y), tol)) continue;
    mask.data[i] = 1;
    const push = (nx: number, ny: number) => {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
      const j = ny * width + nx;
      if (visited[j]) return;
      visited[j] = 1;
      stack.push(j);
    };
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
    if (eight) {
      push(x + 1, y + 1);
      push(x - 1, y - 1);
      push(x + 1, y - 1);
      push(x - 1, y + 1);
    }
  }
  return mask;
}
