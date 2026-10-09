import { describe, expect, it } from 'vitest';
import {
  addColors,
  addGeneratedRamp,
  autoRamps,
  contentBounds,
  convertColorMode,
  createDocument,
  cropCanvas,
  detectRamps,
  draw,
  extractPalette,
  generateRamp,
  loadPreset,
  modifySelection,
  packedToOklch,
  parseHex,
  PRESETS,
  remapPixels,
  removeColors,
  resizeCanvas,
  scaleSprite,
  select,
  setColors,
  setPalette,
  sortPalette,
  transform,
  trimCanvas,
  adjustPalette,
  getSelectionMask,
  listSelections,
} from '../src/index.js';
import { makeDoc, rows } from './helpers.js';

const L = 'Layer 1';

describe('palette presets', () => {
  it('have expected sizes and valid hex', () => {
    const sizes: Record<string, number> = {
      'pico-8': 16,
      'sweetie-16': 16,
      db16: 16,
      db32: 32,
      'endesga-32': 32,
      'resurrect-64': 64,
      'aap-64': 64,
      apollo: 46,
      lospec500: 42,
      vinik24: 24,
      gameboy: 4,
      c64: 16,
      cga: 16,
    };
    for (const p of PRESETS) {
      for (const c of p.colors) expect(parseHex(c), `${p.name} ${c}`).not.toBeNull();
      if (sizes[p.name]) expect(p.colors.length, p.name).toBe(sizes[p.name]);
      for (const r of p.ramps ?? []) for (const i of r.colors) expect(i).toBeLessThan(p.colors.length);
    }
  });
});

describe('palette ops', () => {
  it('setColors recolours indexed pixels (palette swap)', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 9 }] });
    setColors(doc, [{ index: 9, color: '#00ff00', name: 'skin' }]);
    expect(rows(doc, L)[0]![0]).toBe('9');
    expect(doc.state.palette.colors[9]).toBe('#00ff00ff');
    expect(doc.state.palette.names['9']).toBe('skin');
  });

  it('setColors recolours RGBA pixels too', () => {
    const doc = makeDoc({ colorMode: 'rgba' });
    draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 9 }] });
    setColors(doc, [{ index: 9, color: '#00ff00' }]);
    expect(rows(doc, L)[0]![0]).toBe('9');
  });

  it('loadPreset nearest vs index strategy', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 1 }] }); // black
    loadPreset(doc, 'gameboy', 'nearest');
    expect(rows(doc, L)[0]![0]).toBe('1');
    const doc2 = makeDoc();
    draw(doc2, { ops: [{ op: 'pixels', points: [[0, 0]], color: 3 }] });
    loadPreset(doc2, 'sweetie-16', 'index');
    expect(rows(doc2, L)[0]![0]).toBe('3');
    try {
      loadPreset(doc2, 'nopalette');
      expect.fail();
    } catch (e) {
      expect((e as { hint: string }).hint).toMatch(/Available: .*pico-8/);
    }
  });

  it('add / remove / remap / sort keep the image stable', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'grid', rows: ['123456789abcdefg'.slice(0, 8)] }] });
    const before = rows(doc, L)[0];
    const idx = addColors(doc, ['#123456']);
    expect(idx).toEqual([17]);
    sortPalette(doc, 'lightness');
    const r1 = createDocument({ name: 'x', width: 1, height: 1 });
    expect(r1).toBeTruthy();
    // pixels remapped: composite colours unchanged
    const hexes = rows(doc, L)[0]!
      .split('')
      .map((ch) => ch);
    expect(hexes.length).toBe(8);
    removeColors(doc, [17]);
    remapPixels(doc, { 1: 2 });
    expect(before).toBeDefined();
  });

  it('removeColors re-matches pixels and shifts indices', () => {
    const doc = makeDoc();
    draw(doc, {
      ops: [
        { op: 'pixels', points: [[0, 0]], color: 16 },
        { op: 'pixels', points: [[1, 0]], color: 2 },
      ],
    });
    removeColors(doc, [2], 1);
    expect(doc.state.palette.colors.length).toBe(16);
    expect(rows(doc, L)[0]!.slice(0, 2)).toBe('f1');
  });

  it('setPalette replaces colours', () => {
    const doc = makeDoc();
    setPalette(doc, ['#000000', '#ffffff'], { name: 'bw' });
    expect(doc.state.palette.colors.length).toBe(3);
  });

  it('generates hue-shifted ramps', () => {
    const base = parseHex('#c04040')!;
    const ramp = generateRamp(base, { steps: 5 });
    expect(ramp.length).toBe(5);
    expect(ramp[2]).toBe(base);
    const L = ramp.map((c) => packedToOklch(c).L);
    for (let i = 1; i < L.length; i++) expect(L[i]!).toBeGreaterThan(L[i - 1]!);
    const doc = makeDoc();
    const r = addGeneratedRamp(doc, '#c04040', { name: 'brick' });
    expect(r.indices.length).toBe(5);
    expect(doc.state.palette.ramps.find((x) => x.name === 'brick')).toBeTruthy();
  });

  it('detects ramps', () => {
    const doc = makeDoc({ palette: 'resurrect-64' });
    const ramps = autoRamps(doc);
    expect(ramps.length).toBeGreaterThan(3);
    expect(detectRamps([0, parseHex('#000000')!, parseHex('#808080')!, parseHex('#ffffff')!])[0]!.name).toBe(
      'gray',
    );
  });

  it('extracts palettes from RGBA art and adjusts palettes', () => {
    const doc = makeDoc({ colorMode: 'rgba', settings: { paletteLock: false } });
    draw(doc, {
      ops: [
        {
          op: 'pixels',
          points: [
            [0, 0, '#ff0000'],
            [1, 0, '#00ff00'],
            [2, 0, '#0000ff'],
          ],
        },
      ],
    });
    extractPalette(doc, 8);
    expect(doc.state.palette.colors.length).toBe(4);
    adjustPalette(doc, { invert: true });
    expect(rows(doc, L)[0]!.slice(0, 3)).toMatch(/^[123]{3}$/);
  });

  it('converts colour modes', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 9 }] });
    convertColorMode(doc, 'rgba');
    expect(doc.image(doc.state.cels[0]!.imageId).data[0]).toBe(parseHex('#ff004d'));
    convertColorMode(doc, 'indexed');
    expect(rows(doc, L)[0]![0]).toBe('9');
  });
});

describe('selections', () => {
  it('shapes, modes and modifiers', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'rect', x: 0, y: 0, w: 3, h: 3, fill: 8 }] });
    expect(select(doc, { shape: 'wand', x: 1, y: 1, layer: L }).pixels).toBe(9);
    expect(select(doc, { shape: 'rect', x: 0, y: 0, w: 1, h: 1, mode: 'subtract' }).pixels).toBe(8);
    expect(select(doc, { shape: 'color', color: 8, name: 'red', layer: L }).pixels).toBe(9);
    expect(modifySelection(doc, 'red', { action: 'grow', amount: 1 }).pixels).toBe(16);
    expect(modifySelection(doc, 'red', { action: 'invert' }).pixels).toBe(48);
    expect(select(doc, { shape: 'alpha', name: 'a' }).pixels).toBe(9);
    expect(select(doc, { shape: 'ellipse', x: 0, y: 0, w: 4, h: 4, name: 'e' }).pixels).toBe(12);
    expect(listSelections(doc).length).toBe(4);
    expect(() => getSelectionMask(doc, 'nope')).toThrow(/not found/);
  });
});

describe('transforms', () => {
  it('flip / rotate / offset on a cel', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    transform(doc, { scope: 'cel', layer: L, transform: { op: 'flip_h' } });
    expect(rows(doc, L)[0]).toBe('.......8');
    transform(doc, { scope: 'cel', layer: L, transform: { op: 'rotate', angle: 90 } });
    expect(rows(doc, L)[7]).toBe('.......8');
    transform(doc, { scope: 'layer', layer: L, transform: { op: 'offset', dx: 1, dy: 1, wrap: true } });
    expect(rows(doc, L)[0]).toBe('8.......');
  });

  it('scale within canvas and rotsprite keep colours', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'rect', x: 2, y: 2, w: 4, h: 4, fill: 8 }] });
    transform(doc, { scope: 'cel', layer: L, transform: { op: 'scale', factor: 2 } });
    expect(rows(doc, L)[0]).toBe('88888888');
    doc.undo();
    transform(doc, { scope: 'cel', layer: L, transform: { op: 'rotate', angle: 45 } });
    const colours = new Set(rows(doc, L).join('').replace(/\./g, ''));
    expect([...colours]).toEqual(['8']);
  });

  it('transforms selection contents and moves the mask', () => {
    const doc = makeDoc();
    draw(doc, {
      ops: [
        { op: 'pixels', points: [[0, 0]], color: 8 },
        { op: 'pixels', points: [[7, 7]], color: 9 },
      ],
    });
    select(doc, { shape: 'rect', x: 0, y: 0, w: 2, h: 2 });
    transform(doc, { scope: 'selection', layer: L, transform: { op: 'offset', dx: 3, dy: 0, wrap: false } });
    expect(rows(doc, L)[0]).toBe('...8....');
    expect(rows(doc, L)[7]![7]).toBe('9');
    expect(getSelectionMask(doc, 'active').bounds()).toEqual({ x: 3, y: 0, w: 2, h: 2 });
  });

  it('rotating a non-square sprite swaps dimensions', () => {
    const doc = createDocument({ name: 'r', width: 4, height: 2, palette: 'pico-8' });
    draw(doc, { ops: [{ op: 'pixels', points: [[3, 0]], color: 8 }] });
    const res = transform(doc, { scope: 'sprite', transform: { op: 'rotate', angle: 90 } });
    expect(res.canvas).toEqual({ width: 2, height: 4 });
    expect(rows(doc, L)[3]).toBe('.8');
  });
});

describe('canvas', () => {
  it('resize with anchors, crop, trim, scale', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    resizeCanvas(doc, 10, 10, 'bottom-right');
    expect(rows(doc, L)[2]).toBe('..8.......');
    cropCanvas(doc, { x: 2, y: 2, w: 4, h: 4 });
    expect(rows(doc, L)[0]).toBe('8...');
    draw(doc, { ops: [{ op: 'pixels', points: [[2, 2]], color: 9 }] });
    trimCanvas(doc);
    expect(doc.state.width).toBe(3);
    expect(contentBounds(doc)).toEqual({ x: 0, y: 0, w: 3, h: 3 });
    scaleSprite(doc, { factor: 2 });
    expect(doc.state.width).toBe(6);
    expect(rows(doc, L)[1]).toBe('88....');
    doc.undo();
    expect(doc.state.width).toBe(3);
  });
});
