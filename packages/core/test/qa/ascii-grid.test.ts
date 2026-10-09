/**
 * QA: ASCII grid parsing edge cases and read_pixels → grid round-trips on random content.
 */
import { describe, expect, it } from 'vitest';
import { createDocument, draw, parseGrid, readPixels, type SpriteDocument } from '@pixelclaus/core';

const L = 'Layer 1';

function rowsOf(doc: SpriteDocument): string[] {
  return readPixels(doc, { layer: L, rowNumbers: false, header: false }).text.split('\n');
}

/** Small deterministic PRNG. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function indicesOf(doc: SpriteDocument): number[] {
  const img = doc.image(doc.state.cels[0]!.imageId);
  return [...img.data];
}

function randomIndexed(paletteSize: number, w: number, h: number, seed: number, density = 0.7): SpriteDocument {
  const colors = Array.from({ length: paletteSize }, (_, i) => `#${((i * 2654435761) >>> 8).toString(16).padStart(6, '0').slice(0, 6)}`);
  const doc = createDocument({ name: 'r', width: w, height: h, palette: colors });
  const rand = rng(seed);
  const pts: Array<[number, number, number]> = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (rand() < density) pts.push([x, y, 1 + Math.floor(rand() * paletteSize)]);
  draw(doc, { layer: L, ops: [{ op: 'pixels', points: pts }] });
  return doc;
}

describe('parseGrid edge cases', () => {
  it('strips row prefixes (incl. negative and spaced), header lines, tabs and CRLF', () => {
    const g = parseGrid('   | 0123\r\n07| 1.2.\r\n-1 |\t3~45\r\n');
    expect(g.width).toBe(4);
    expect(g.height).toBe(2);
    expect(g.rows[1]![1]!.kind).toBe('keep');
  });

  it('RLE: c*n, ~*n, [n]*n and *0', () => {
    const g = parseGrid(['a*3~*2[60]*2.*0b']);
    expect(g.width).toBe(8);
    expect(g.rows[0]![5]).toEqual({ kind: 'index', index: 60 });
  });

  it('rejects malformed syntax with row numbers', () => {
    expect(() => parseGrid(['ab', '*3'])).toThrow(/Row 1: '\*' must follow/);
    expect(() => parseGrid(['a*'])).toThrow(/followed by a count/);
    expect(() => parseGrid(['[12'])).toThrow(/unterminated/);
    expect(() => parseGrid(['[x]'])).toThrow(/not a palette index/);
    expect(() => parseGrid(['ab', 'abc'])).toThrow(/row 1 has 3/);
    expect(() => parseGrid(['', '  '])).toThrow(/empty/);
  });

  it('BMP unicode legend characters work', () => {
    const doc = createDocument({ name: 'u', width: 4, height: 1, palette: 'pico-8' });
    draw(doc, { layer: L, ops: [{ op: 'grid', rows: ['█░é.'], legend: { '█': 1, '░': 7, é: 9 } }] });
    expect(rowsOf(doc)[0]).toBe('179.');
  });

  it('astral-plane (emoji) legend characters count as ONE pixel', () => {
    const doc = createDocument({ name: 'u', width: 4, height: 1, palette: 'pico-8' });
    // agents like emoji legends ("🟥" for red); a surrogate pair must not be split into two cells
    const r = () => draw(doc, { layer: L, ops: [{ op: 'grid', rows: ['🟥🟦..'], legend: { '🟥': 9, '🟦': 13 } }] });
    expect(r).not.toThrow();
    expect(rowsOf(doc)[0]).toBe('9d..');
  });

  it('a legend symbol "|" at the start of an un-numbered row is not mistaken for a header line', () => {
    const doc = createDocument({ name: 'u', width: 3, height: 2, palette: 'pico-8' });
    draw(doc, { layer: L, ops: [{ op: 'grid', rows: ['|.|', '.|.'], legend: { '|': 8 } }] });
    expect(rowsOf(doc)).toEqual(['8.8', '.8.']);
  });

  it('a row of digits followed by a "|" legend symbol is not mistaken for a row-number prefix', () => {
    const doc = createDocument({ name: 'u', width: 3, height: 1, palette: 'pico-8' });
    draw(doc, { layer: L, ops: [{ op: 'grid', rows: ['12|'], legend: { '|': 8 } }] });
    expect(rowsOf(doc)[0]).toBe('128');
  });

  it('ambiguous l/o/I/O are rejected with a helpful hint', () => {
    const doc = createDocument({ name: 'u', width: 2, height: 1, palette: 'pico-8' });
    expect(() => draw(doc, { layer: L, ops: [{ op: 'grid', rows: ['lo'] }] })).toThrow(/not in the legend/);
  });
});

describe('read_pixels → grid round-trips', () => {
  for (const seed of [1, 2, 3]) {
    it(`indexed 32-colour random content, default rows (seed ${seed})`, () => {
      const doc = randomIndexed(32, 23, 17, seed);
      const before = indicesOf(doc);
      const rp = readPixels(doc, { layer: L });
      const copy = createDocument({ name: 'c', width: 23, height: 17, palette: doc.state.palette.colors.slice(1) });
      draw(copy, { layer: L, ops: [{ op: 'grid', rows: rp.text.split('\n') }] });
      expect(indicesOf(copy)).toEqual(before);
    });
  }

  it('indexed sprite using 8+ distinct indices >= 58 can be read at all', () => {
    // the 8th extra symbol is '?', which readPixels also uses as its "out of symbols" sentinel
    const colors = Array.from({ length: 80 }, (_, i) => `#${(0x010203 * (i + 1)).toString(16).padStart(6, '0').slice(-6)}`);
    const doc = createDocument({ name: 'q', width: 8, height: 1, palette: colors });
    draw(doc, { layer: L, ops: [{ op: 'grid', rows: ['[58][59][60][61][62][63][64][65]'] }] });
    expect(() => readPixels(doc, { layer: L })).not.toThrow();
  });

  it('indexed 120-colour palette: round-trip using the returned legendInput', () => {
    const doc = randomIndexed(120, 20, 12, 7, 0.9);
    const before = indicesOf(doc);
    const rp = readPixels(doc, { layer: L });
    draw(doc, { layer: L, ops: [{ op: 'clear' }] });
    draw(doc, { layer: L, ops: [{ op: 'grid', rows: rp.text.split('\n'), legend: rp.legendInput }] });
    expect(indicesOf(doc)).toEqual(before);
  });

  it('indexed 64-colour palette: rows alone round-trip ("paste rows back unchanged")', () => {
    // indices >= 58 are printed as self-describing [n] tokens (was: extra symbols the grid op did not know)
    const doc = randomIndexed(64, 16, 8, 11, 0.9);
    const before = indicesOf(doc);
    const rp = readPixels(doc, { layer: L });
    expect(Object.keys(rp.legend).some((k) => /^\[\d+\]$/.test(k))).toBe(true);
    draw(doc, { layer: L, ops: [{ op: 'clear' }] });
    expect(() => draw(doc, { layer: L, ops: [{ op: 'grid', rows: rp.text.split('\n') }] })).not.toThrow();
    expect(indicesOf(doc)).toEqual(before);
  });

  it('rgba off-palette colours round-trip with legendInput', () => {
    const doc = createDocument({ name: 'c', width: 10, height: 6, colorMode: 'rgba', palette: 'pico-8', settings: { paletteLock: false } });
    const rand = rng(5);
    const cols = Array.from({ length: 12 }, (_, i) => `#${(0x102030 + i * 0x0a0b0c).toString(16).padStart(6, '0')}`);
    const pts: Array<[number, number, string]> = [];
    for (let y = 0; y < 6; y++) for (let x = 0; x < 10; x++) if (rand() < 0.8) pts.push([x, y, cols[Math.floor(rand() * cols.length)]!]);
    draw(doc, { layer: L, ops: [{ op: 'pixels', points: pts }] });
    const before = indicesOf(doc);
    const rp = readPixels(doc, { layer: L });
    draw(doc, { layer: L, ops: [{ op: 'clear' }] });
    draw(doc, { layer: L, ops: [{ op: 'grid', rows: rp.text.split('\n'), legend: rp.legendInput }] });
    expect(indicesOf(doc)).toEqual(before);
  });

  it('RLE readback round-trips when a run is followed by a digit character', () => {
    // pixels 2,2,2,3 → "2*3" + "3" = "2*33" which parses back as 33 twos
    const doc = createDocument({ name: 'c', width: 4, height: 1, palette: 'pico-8' });
    draw(doc, { layer: L, ops: [{ op: 'grid', rows: ['2223'] }] });
    const rp = readPixels(doc, { layer: L, rle: 3 });
    const rows = rp.text.split('\n');
    draw(doc, { layer: L, ops: [{ op: 'clear' }] });
    expect(() => draw(doc, { layer: L, ops: [{ op: 'grid', rows }] })).not.toThrow();
    expect(rowsOf(doc)[0]).toBe('2223');
  });

  for (const seed of [21, 22]) {
    it(`RLE readback round-trips random run-heavy content (seed ${seed})`, () => {
      const doc = createDocument({ name: 'c', width: 32, height: 8, palette: 'pico-8' });
      const rand = rng(seed);
      const rows: string[] = [];
      const alpha = '.123456789abcdefg';
      for (let y = 0; y < 8; y++) {
        let row = '';
        while (row.length < 32) {
          const ch = alpha[Math.floor(rand() * alpha.length)]!;
          row += ch.repeat(1 + Math.floor(rand() * 5));
        }
        rows.push(row.slice(0, 32));
      }
      draw(doc, { layer: L, ops: [{ op: 'grid', rows }] });
      const rp = readPixels(doc, { layer: L, rle: 3 });
      draw(doc, { layer: L, ops: [{ op: 'clear' }] });
      expect(() => draw(doc, { layer: L, ops: [{ op: 'grid', rows: rp.text.split('\n') }] })).not.toThrow();
      expect(rowsOf(doc)).toEqual(rows);
    });
  }

  it('composite readback of a region keeps absolute coordinates in header/row numbers', () => {
    const doc = createDocument({ name: 'c', width: 120, height: 120, palette: 'pico-8' });
    draw(doc, { layer: L, ops: [{ op: 'pixels', points: [[105, 101]], color: 8 }] });
    const rp = readPixels(doc, { region: { x: 100, y: 100, w: 10, h: 3 } });
    const lines = rp.text.split('\n');
    expect(lines[0]).toMatch(/\| 1111111111$/); // hundreds, tens, ones header lines
    expect(lines[2]).toMatch(/\| 0123456789$/);
    expect(lines[4]).toBe('101| .....8....');
    // and the numbered rows can be written back at the same offset
    draw(doc, { layer: L, ops: [{ op: 'clear' }] });
    draw(doc, { layer: L, ops: [{ op: 'grid', x: 100, y: 100, rows: lines }] });
    expect(readPixels(doc, { layer: L, region: { x: 105, y: 101, w: 1, h: 1 }, format: 'json' }).rows![0]![0]).toBe(8);
  });

  it('read_pixels rejects regions larger than the 16384-cell budget with a hint', () => {
    const doc = createDocument({ name: 'c', width: 200, height: 200, palette: 'pico-8' });
    expect(() => readPixels(doc, {})).toThrow(/too large/);
    expect(() => readPixels(doc, { region: { x: 500, y: 500, w: 4, h: 4 } })).toThrow(/outside/);
  });
});
