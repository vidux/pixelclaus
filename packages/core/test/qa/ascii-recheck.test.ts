/**
 * QA recheck (D4/D5 + legend minors): adversarial ASCII grids and a randomized readback → grid round trip
 * covering RLE runs next to [n] cells, multi-digit counts, off-palette symbols and wide headers.
 */
import { describe, expect, it } from 'vitest';
import { addColors, createDocument, draw, parseGrid, readPixels, type SpriteDocument } from '@pixelclaus/core';

const L = 'Layer 1';

function doc(w: number, h: number, mode: 'indexed' | 'rgba' = 'indexed'): SpriteDocument {
  const d = createDocument({
    name: 'a',
    width: w,
    height: h,
    palette: 'pico-8',
    colorMode: mode,
    ...(mode === 'rgba' ? { settings: { paletteLock: false, missingColor: 'add' } as never } : {}),
  });
  // 16 + 150 colours → indices 58..166 need [n] tokens
  addColors(d, Array.from({ length: 150 }, (_, i) => '#' + (0x100000 + i * 4099).toString(16).slice(-6)));
  return d;
}

const json = (d: SpriteDocument, region?: { x: number; y: number; w: number; h: number }) =>
  JSON.stringify(readPixels(d, { layer: L, format: 'json', region }).rows);

describe('grid parsing edge cases', () => {
  it('multi-digit run counts and [n] runs expand exactly', () => {
    const g = parseGrid(['8*12 [60]*10 [7] 9*3']);
    expect(g.width).toBe(12 + 10 + 1 + 3);
    expect(g.rows[0]!.slice(12, 22).every((c) => c.kind === 'index' && c.index === 60)).toBe(true);
    expect(g.rows[0]![22]).toEqual({ kind: 'index', index: 7 });
  });

  it('an RLE run directly followed by an [n] cell, and [n] followed by digits, stay distinct', () => {
    const d = doc(12, 1);
    draw(d, { layer: L, ops: [{ op: 'grid', rows: ['2*3 [61]5[62]*2 3*2 [99]'] }] });
    const rb = readPixels(d, { layer: L, rle: 2, header: false });
    const d2 = doc(12, 1);
    draw(d2, { layer: L, ops: [{ op: 'grid', rows: rb.text, legend: rb.legendInput }] });
    expect(json(d2)).toBe(json(d));
    expect(JSON.parse(json(d))[0]).toEqual([2, 2, 2, 61, 5, 62, 62, 3, 3, 99, 0, 0]);
  });

  it('readback of a region starting at x ≥ 100 (three header lines) pastes back unchanged', () => {
    const d = doc(140, 3);
    draw(d, { layer: L, ops: [{ op: 'line', from: [100, 0], to: [139, 2], color: 9 }, { op: 'pixels', points: [[120, 1]], color: 70 }] });
    const region = { x: 100, y: 0, w: 40, h: 3 };
    const rb = readPixels(d, { layer: L, region, rle: 3 });
    const d2 = doc(140, 3);
    draw(d2, { layer: L, ops: [{ op: 'grid', x: 100, y: 0, rows: rb.text, legend: rb.legendInput }] });
    expect(json(d2, region)).toBe(json(d, region));
  });

  it('R5: a "|" legend symbol after leading digits and a space is silently eaten as a row-number prefix', () => {
    // legend keys may be "|" (only * [ ] ~ are reserved) and whitespace is documented as ignored,
    // so "11 | 11" means 5 pixels: 1 1 | 1 1. ROW_PREFIX strips "11 | " instead → every row loses 3 pixels
    const d = createDocument({ name: 'f', width: 5, height: 2, palette: 'pico-8' });
    draw(d, { layer: L, ops: [{ op: 'grid', rows: ['11 | 11', '22 | 22'], legend: { '|': 4 } }] });
    expect(JSON.parse(json(d))).toEqual([
      [1, 1, 4, 1, 1],
      [2, 2, 4, 2, 2],
    ]);
  });
});

describe('randomized readback → grid round trip (indexed and RGBA, rle 0/2/3/4)', () => {
  it('300 random sprites round-trip exactly and the fuzz exercised every token kind', () => {
    let s = 12345;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32);
    const seen = { index: 0, rle: 0, symbol: 0, cases: 0 };
    for (let iter = 0; iter < 300; iter++) {
      const mode = iter % 3 === 2 ? 'rgba' : 'indexed';
      const w = 1 + Math.floor(rnd() * 40);
      const h = 1 + Math.floor(rnd() * 6);
      const d = doc(w, h, mode);
      const npal = d.state.palette.colors.length - 1;
      const pts: Array<[number, number, number | string]> = [];
      const runLen = 1 + Math.floor(rnd() * 12);
      let offPalette = 0;
      for (let y = 0; y < h; y++) {
        let x = 0;
        while (x < w) {
          const k = rnd();
          let c: number | string;
          if (k < 0.25) c = 0;
          else if (k < 0.5) c = 1 + Math.floor(rnd() * 9);
          else if (k < 0.75) c = 58 + Math.floor(rnd() * (npal - 58));
          else if (mode === 'rgba' && k < 0.85 && offPalette < 20) {
            c = '#' + Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0');
            offPalette++;
          } else c = 10 + Math.floor(rnd() * 48);
          const n = Math.max(1, Math.floor(rnd() * runLen));
          for (let j = 0; j < n && x < w; j++, x++) if (c !== 0) pts.push([x, y, c]);
        }
      }
      if (pts.length) draw(d, { layer: L, ops: [{ op: 'pixels', points: pts }] });
      const rle = [0, 2, 3, 4][iter % 4]!;
      const rb = readPixels(d, { layer: L, rle: rle || undefined });
      if (rb.text.includes('[')) seen.index++;
      if (/\*\d/.test(rb.text)) seen.rle++;
      if (Object.values(rb.legend).some((v) => v.includes('not in palette'))) seen.symbol++;
      const d2 = doc(w, h, mode);
      draw(d2, { layer: L, ops: [{ op: 'grid', rows: rb.text, legend: rb.legendInput }] });
      expect(json(d2), `iter ${iter} rle ${rle}\n${rb.text}`).toBe(json(d));
      seen.cases++;
    }
    expect(seen.cases).toBe(300);
    expect(seen.index).toBeGreaterThan(100);
    expect(seen.rle).toBeGreaterThan(100);
    expect(seen.symbol).toBeGreaterThan(30);
  });
});
