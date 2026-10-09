import { describe, expect, it } from 'vitest';
import {
  blendInto,
  deltaEPacked,
  oklabToPacked,
  pack,
  packedToOklab,
  parseHex,
  toHex,
  unpack,
  adjustColor,
  lightness,
} from '../src/index.js';

describe('rgba', () => {
  it('parses hex forms', () => {
    expect(parseHex('#fff')).toBe(0xffffffff);
    expect(parseHex('ff8800')).toBe(0xff8800ff);
    expect(parseHex('#ff880080')).toBe(0xff880080);
    expect(parseHex('#0000')).toBe(0);
    expect(parseHex('nope')).toBeNull();
  });
  it('formats hex', () => {
    expect(toHex(pack(255, 136, 0))).toBe('#ff8800');
    expect(toHex(pack(1, 2, 3, 4))).toBe('#01020304');
  });
  it('normalises alpha 0 to transparent', () => {
    expect(pack(10, 20, 30, 0)).toBe(0);
    expect(unpack(pack(10, 20, 30, 40))).toEqual({ r: 10, g: 20, b: 30, a: 40 });
  });
});

describe('oklab', () => {
  it('round-trips sRGB', () => {
    for (const c of [pack(255, 0, 0), pack(12, 200, 99), pack(0, 0, 0), pack(255, 255, 255)]) {
      expect(oklabToPacked(packedToOklab(c))).toBe(c);
    }
  });
  it('orders lightness', () => {
    expect(lightness(pack(0, 0, 0))).toBeLessThan(lightness(pack(128, 128, 128)));
    expect(deltaEPacked(pack(10, 10, 10), pack(10, 10, 10))).toBe(0);
  });
});

describe('blend', () => {
  it('normal source-over', () => {
    const d = new Uint8ClampedArray([0, 0, 255, 255]);
    blendInto(d, 0, 255, 0, 0, 255, 0.5, 'normal');
    expect([...d]).toEqual([128, 0, 128, 255]);
  });
  it('multiply darkens', () => {
    const d = new Uint8ClampedArray([200, 200, 200, 255]);
    blendInto(d, 0, 128, 128, 128, 255, 1, 'multiply');
    expect(d[0]).toBe(100);
  });
  it('blends onto transparent as copy', () => {
    const d = new Uint8ClampedArray([0, 0, 0, 0]);
    blendInto(d, 0, 10, 20, 30, 255, 1, 'screen');
    expect([...d]).toEqual([10, 20, 30, 255]);
  });
  it('all modes produce valid bytes', () => {
    for (const m of [
      'overlay',
      'darken',
      'lighten',
      'color-dodge',
      'color-burn',
      'hard-light',
      'soft-light',
      'difference',
      'exclusion',
      'hue',
      'saturation',
      'color',
      'luminosity',
      'addition',
      'subtract',
      'divide',
    ] as const) {
      const d = new Uint8ClampedArray([100, 150, 200, 255]);
      blendInto(d, 0, 50, 100, 250, 200, 1, m);
      expect(d[3]).toBe(255);
    }
  });
});

describe('adjust', () => {
  it('inverts and desaturates', () => {
    expect(adjustColor(pack(255, 0, 0), { invert: true })).toBe(pack(0, 255, 255));
    const g = unpack(adjustColor(pack(255, 0, 0), { desaturate: true }));
    expect(g.r).toBe(g.g);
  });
});
