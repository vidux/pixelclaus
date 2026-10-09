/**
 * Pure pixel-buffer transforms (value-preserving: no new colours are introduced).
 */
import { PixelBuffer } from '../buffer/pixel-buffer.js';

export function flipH(b: PixelBuffer): PixelBuffer {
  const out = new PixelBuffer(b.width, b.height);
  for (let y = 0; y < b.height; y++)
    for (let x = 0; x < b.width; x++) out.data[y * b.width + x] = b.data[y * b.width + (b.width - 1 - x)]!;
  return out;
}

export function flipV(b: PixelBuffer): PixelBuffer {
  const out = new PixelBuffer(b.width, b.height);
  for (let y = 0; y < b.height; y++)
    out.data.set(b.data.subarray((b.height - 1 - y) * b.width, (b.height - y) * b.width), y * b.width);
  return out;
}

/** Rotate by a multiple of 90° clockwise (1, 2, 3). Dimensions swap for 1 and 3. */
export function rotateQuarter(b: PixelBuffer, quarters: number): PixelBuffer {
  const q = ((quarters % 4) + 4) % 4;
  if (q === 0) return b.clone();
  const W = b.width;
  const H = b.height;
  const out = q === 2 ? new PixelBuffer(W, H) : new PixelBuffer(H, W);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = b.data[y * W + x]!;
      if (q === 1) out.data[x * H + (H - 1 - y)] = v;
      else if (q === 2) out.data[(H - 1 - y) * W + (W - 1 - x)] = v;
      else out.data[(W - 1 - x) * H + y] = v;
    }
  }
  return out;
}

/** Nearest-neighbour rotation around (cx, cy) (default centre), output same size as input. */
export function rotateNearest(b: PixelBuffer, degrees: number, cx?: number, cy?: number): PixelBuffer {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const ox = cx ?? b.width / 2;
  const oy = cy ?? b.height / 2;
  const out = new PixelBuffer(b.width, b.height);
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      const dx = x + 0.5 - ox;
      const dy = y + 0.5 - oy;
      // inverse rotation
      const sx = Math.floor(cos * dx + sin * dy + ox);
      const sy = Math.floor(-sin * dx + cos * dy + oy);
      out.data[y * b.width + x] = b.get(sx, sy);
    }
  }
  return out;
}

/** EPX / Scale2x. */
export function scale2x(b: PixelBuffer): PixelBuffer {
  const W = b.width;
  const H = b.height;
  const out = new PixelBuffer(W * 2, H * 2);
  const g = (x: number, y: number) => b.get(Math.max(0, Math.min(W - 1, x)), Math.max(0, Math.min(H - 1, y)));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const P = g(x, y);
      const A = g(x, y - 1);
      const B = g(x + 1, y);
      const C = g(x - 1, y);
      const D = g(x, y + 1);
      const o = out.width;
      out.data[2 * y * o + 2 * x] = C === A && C !== D && A !== B ? A : P;
      out.data[2 * y * o + 2 * x + 1] = A === B && A !== C && B !== D ? B : P;
      out.data[(2 * y + 1) * o + 2 * x] = D === C && D !== B && C !== A ? C : P;
      out.data[(2 * y + 1) * o + 2 * x + 1] = B === D && B !== A && D !== C ? D : P;
    }
  }
  return out;
}

/** AdvMAME3x / Scale3x. */
export function scale3x(b: PixelBuffer): PixelBuffer {
  const W = b.width;
  const H = b.height;
  const out = new PixelBuffer(W * 3, H * 3);
  const g = (x: number, y: number) => b.get(Math.max(0, Math.min(W - 1, x)), Math.max(0, Math.min(H - 1, y)));
  const o = out.width;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const A = g(x - 1, y - 1),
        B = g(x, y - 1),
        C = g(x + 1, y - 1);
      const D = g(x - 1, y),
        E = g(x, y),
        F = g(x + 1, y);
      const G = g(x - 1, y + 1),
        Hh = g(x, y + 1),
        I = g(x + 1, y + 1);
      const e: number[] = new Array(9).fill(E);
      if (B !== Hh && D !== F) {
        e[0] = D === B ? D : E;
        e[1] = (D === B && E !== C) || (B === F && E !== A) ? B : E;
        e[2] = B === F ? F : E;
        e[3] = (D === B && E !== G) || (D === Hh && E !== A) ? D : E;
        e[5] = (B === F && E !== I) || (Hh === F && E !== C) ? F : E;
        e[6] = D === Hh ? D : E;
        e[7] = (D === Hh && E !== I) || (Hh === F && E !== G) ? Hh : E;
        e[8] = Hh === F ? F : E;
      }
      for (let k = 0; k < 9; k++) out.data[(3 * y + Math.floor(k / 3)) * o + 3 * x + (k % 3)] = e[k]!;
    }
  }
  return out;
}

/** Nearest-neighbour resize to an exact size. */
export function resizeNearest(b: PixelBuffer, w: number, h: number): PixelBuffer {
  const out = new PixelBuffer(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(b.height - 1, Math.floor(((y + 0.5) * b.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(b.width - 1, Math.floor(((x + 0.5) * b.width) / w));
      out.data[y * w + x] = b.data[sy * b.width + sx]!;
    }
  }
  return out;
}

/**
 * RotSprite-style rotation: upscale 8× with Scale2x (three passes), rotate with nearest neighbour,
 * then sample back down. Produces far cleaner edges than plain nearest rotation for sprites.
 */
export function rotsprite(b: PixelBuffer, degrees: number, cx?: number, cy?: number): PixelBuffer {
  const big = scale2x(scale2x(scale2x(b)));
  const rot = rotateNearest(big, degrees, (cx ?? b.width / 2) * 8, (cy ?? b.height / 2) * 8);
  const out = new PixelBuffer(b.width, b.height);
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      // majority vote of the 4 central samples of the 8×8 block, ties → centre sample
      const samples = [
        rot.get(x * 8 + 3, y * 8 + 3),
        rot.get(x * 8 + 4, y * 8 + 3),
        rot.get(x * 8 + 3, y * 8 + 4),
        rot.get(x * 8 + 4, y * 8 + 4),
      ];
      const counts = new Map<number, number>();
      let best = samples[3]!;
      let bestN = 0;
      for (const s of samples) {
        const n = (counts.get(s) ?? 0) + 1;
        counts.set(s, n);
        if (n > bestN) {
          bestN = n;
          best = s;
        }
      }
      out.data[y * b.width + x] = best;
    }
  }
  return out;
}

/** Shift content; with `wrap` pixels leaving one edge enter at the opposite edge (tiling). */
export function offset(b: PixelBuffer, dx: number, dy: number, wrap: boolean): PixelBuffer {
  const W = b.width;
  const H = b.height;
  const out = new PixelBuffer(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let tx = x + dx;
      let ty = y + dy;
      if (wrap) {
        tx = ((tx % W) + W) % W;
        ty = ((ty % H) + H) % H;
      } else if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      out.data[ty * W + tx] = b.data[y * W + x]!;
    }
  }
  return out;
}

/** Place `src` into a new w×h buffer at (x, y) (cropping as needed). */
export function placeInto(src: PixelBuffer, w: number, h: number, x: number, y: number): PixelBuffer {
  const out = new PixelBuffer(w, h);
  out.blit(src, x, y);
  return out;
}
