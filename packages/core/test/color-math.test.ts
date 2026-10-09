import { describe, expect, it } from 'vitest';
import {
  adjustColor,
  convertColorMode,
  draw,
  hslToRgb,
  mapToPalette,
  medianCut,
  offset,
  pack,
  parseHex,
  PixelBuffer,
  rgbToHsl,
  rotateNearest,
  rotateQuarter,
  scale2x,
  scale3x,
  unpack,
  resizeNearest,
  flipH,
  flipV,
} from '../src/index.js';
import { makeDoc, rows } from './helpers.js';

describe('hsl & adjustments', () => {
  it('round-trips hsl', () => {
    for (const [r, g, b] of [
      [255, 0, 0],
      [12, 200, 99],
      [128, 128, 128],
      [250, 240, 10],
    ]) {
      const back = hslToRgb(rgbToHsl(r!, g!, b!));
      expect(Math.abs(back.r - r!) + Math.abs(back.g - g!) + Math.abs(back.b - b!)).toBeLessThanOrEqual(3);
    }
  });
  it('hue / saturation / lightness / brightness / contrast', () => {
    const red = pack(200, 40, 40);
    expect(unpack(adjustColor(red, { hue: 120 })).g).toBeGreaterThan(150);
    expect(unpack(adjustColor(red, { saturation: -1 })).r).toBe(
      unpack(adjustColor(red, { saturation: -1 })).g,
    );
    expect(unpack(adjustColor(red, { lightness: 0.3 })).r).toBeGreaterThan(200);
    expect(unpack(adjustColor(red, { brightness: -0.1 })).r).toBe(175); // 200 - 25.5 rounded
    expect(unpack(adjustColor(pack(150, 150, 150), { contrast: 1 })).r).toBe(172);
    expect(adjustColor(0, { invert: true })).toBe(0);
    expect(adjustColor(pack(1, 2, 3, 77), { invert: true }) & 255).toBe(77);
  });
});

describe('quantisation & dithering', () => {
  it('median cut reduces colours and keeps representative ones', () => {
    const hist = new Map<number, number>();
    for (let i = 0; i < 64; i++) hist.set(pack(i * 4, 0, 0), 1);
    for (let i = 0; i < 64; i++) hist.set(pack(0, 0, i * 4), 1);
    const out = medianCut(hist, 4);
    expect(out.length).toBe(4);
    expect(out.some((c) => unpack(c).r > 100)).toBe(true);
    expect(out.some((c) => unpack(c).b > 100)).toBe(true);
    expect(medianCut(new Map([[pack(1, 1, 1), 5]]), 8)).toEqual([pack(1, 1, 1)]);
  });
  it('maps to a palette with every dither method', () => {
    const pal = [0, pack(0, 0, 0), pack(255, 255, 255)];
    const px = new Uint32Array(16 * 4).map((_, i) =>
      pack(
        Math.round(((i % 16) / 15) * 255),
        Math.round(((i % 16) / 15) * 255),
        Math.round(((i % 16) / 15) * 255),
      ),
    );
    for (const d of ['none', 'bayer2', 'bayer4', 'bayer8', 'floyd-steinberg'] as const) {
      const idx = mapToPalette(px, 16, 4, pal, d);
      expect(idx[0], d).toBe(1);
      expect(idx[15], d).toBe(2);
      if (d !== 'none') expect(new Set(idx.subarray(4, 12)).size, d).toBe(2);
    }
    expect(mapToPalette(Uint32Array.of(pack(1, 2, 3, 10)), 1, 1, pal)[0]).toBe(0);
  });
  it('converts RGBA art to indexed with dithering', () => {
    const doc = makeDoc({ colorMode: 'rgba', settings: { paletteLock: false } });
    draw(doc, {
      ops: [
        {
          op: 'pixels',
          points: [
            [0, 0, '#7f7f7f'],
            [1, 0, '#010101'],
          ],
        },
      ],
    });
    convertColorMode(doc, 'indexed', 'floyd-steinberg');
    expect(doc.state.colorMode).toBe('indexed');
    expect(rows(doc, 'Layer 1')[0]![1]).toBe('1');
  });
});

describe('buffer transforms', () => {
  const b = new PixelBuffer(3, 2, Uint32Array.from([1, 2, 3, 4, 5, 6]));
  it('flips and rotates', () => {
    expect([...flipH(b).data]).toEqual([3, 2, 1, 6, 5, 4]);
    expect([...flipV(b).data]).toEqual([4, 5, 6, 1, 2, 3]);
    const r = rotateQuarter(b, 1);
    expect([r.width, r.height]).toEqual([2, 3]);
    expect([...r.data]).toEqual([4, 1, 5, 2, 6, 3]);
    expect([...rotateQuarter(b, 3).data]).toEqual([3, 6, 2, 5, 1, 4]);
    expect([...rotateQuarter(b, 2).data]).toEqual([6, 5, 4, 3, 2, 1]);
    expect(
      rotateNearest(new PixelBuffer(4, 4).fill(7), 45).data.filter((v) => v === 7).length,
    ).toBeGreaterThan(6);
  });
  it('scales with nearest, scale2x and scale3x', () => {
    expect([...resizeNearest(b, 6, 4).data.subarray(0, 6)]).toEqual([1, 1, 2, 2, 3, 3]);
    const diag = new PixelBuffer(2, 2, Uint32Array.from([1, 0, 0, 1]));
    expect(scale2x(diag).width).toBe(4);
    const s3 = scale3x(diag);
    expect(s3.width).toBe(6);
    expect(s3.data.filter((v) => v === 1).length).toBeGreaterThanOrEqual(18);
  });
  it('offsets with and without wrap', () => {
    expect([...offset(b, 1, 0, true).data]).toEqual([3, 1, 2, 6, 4, 5]);
    expect([...offset(b, 1, 0, false).data]).toEqual([0, 1, 2, 0, 4, 5]);
  });
  it('parses hex shorthand with alpha', () => {
    expect(parseHex('#f008')).toBe(pack(255, 0, 0, 136));
  });
});
