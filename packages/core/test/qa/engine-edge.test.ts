/**
 * QA: core engine edge cases — sizes, out-of-canvas coordinates, palettes, colour modes, draw ops with
 * unusual parameters, selections/clip, symmetry and linked cels.
 */
import { describe, expect, it } from 'vitest';
import {
  addColors,
  addFrames,
  addLayer,
  compositeFrame,
  createDocument,
  draw,
  linkCels,
  moveCels,
  modifySelection,
  readPixels,
  renderView,
  resizeCanvas,
  runLint,
  scaleSprite,
  select,
  transform,
  unlinkCels,
  updateProject,
  VIEW_MODES,
  type DrawOp,
  type SpriteDocument,
} from '@pixelclaus/core';

const L = 'Layer 1';

function doc8(opts: Record<string, unknown> = {}): SpriteDocument {
  return createDocument({ name: 't', width: 8, height: 8, palette: 'pico-8', ...opts });
}

function rowsOf(doc: SpriteDocument, layer: string | undefined = L, frame = 0): string[] {
  return readPixels(doc, { layer, frame, rowNumbers: false, header: false }).text.split('\n');
}

function compositeHex(doc: SpriteDocument, frame = 0): string {
  const r = compositeFrame(doc, { frame });
  return Buffer.from(r.data).toString('hex');
}

describe('canvas sizes', () => {
  it('rejects zero, negative, fractional and oversized canvases', () => {
    for (const [w, h] of [
      [0, 8],
      [8, 0],
      [-1, 8],
      [1.5, 8],
      [4097, 1],
      [1, 4097],
    ]) {
      expect(() => createDocument({ name: 'x', width: w!, height: h! }), `${w}x${h}`).toThrow(/Canvas/);
    }
  });

  it('accepts extreme but valid sizes (1x1, 4096x1)', () => {
    expect(createDocument({ name: 'a', width: 1, height: 1 }).state.width).toBe(1);
    expect(createDocument({ name: 'b', width: 4096, height: 1 }).state.width).toBe(4096);
  });

  it('every draw op works on a 1x1 canvas', () => {
    const doc = createDocument({ name: 'one', width: 1, height: 1, palette: 'pico-8' });
    const ops: DrawOp[] = [
      { op: 'pixels', points: [[0, 0]], color: 8 },
      { op: 'rect', x: 0, y: 0, w: 1, h: 1, color: 7, fill: 8 },
      { op: 'ellipse', x: 0, y: 0, w: 1, h: 1, fill: 9 },
      { op: 'circle', cx: 0, cy: 0, r: 0, color: 10 },
      { op: 'line', from: [0, 0], to: [0, 0], color: 11 },
      { op: 'path', points: [[0, 0]], color: 12 },
      { op: 'polygon', points: [[0, 0], [0, 0], [0, 0]], fill: 3 },
      { op: 'fill', x: 0, y: 0, color: 4 },
      { op: 'gradient', from: [0, 0], to: [0, 0], colors: [1, 2] },
      { op: 'pattern', pattern: 'checker', colors: [5, 6] },
      { op: 'outline', color: 1 },
      { op: 'shade', mode: 'shift', amount: 1 },
      { op: 'shade', mode: 'light' },
      { op: 'selout' },
      { op: 'copy' },
      { op: 'paste', x: 0, y: 0 },
      { op: 'stamp', from: {}, dx: 0, dy: 0 },
      { op: 'text', x: 0, y: 0, text: 'A', color: 7 },
      { op: 'adjust', hue: 30 },
      { op: 'replace_color', from: 7, to: 8 },
      { op: 'erase', points: [[0, 0]] },
      { op: 'clear' },
    ];
    expect(() => draw(doc, { layer: L, ops })).not.toThrow();
    expect(rowsOf(doc)).toEqual(['.']);
  });

  it('renders every view and lints a 1x1 canvas', () => {
    const doc = createDocument({ name: 'one', width: 1, height: 1, palette: 'pico-8' });
    draw(doc, { layer: L, ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    for (const view of VIEW_MODES) {
      const out = renderView(doc, { view });
      expect(out.raster.width, view).toBeGreaterThan(0);
    }
    expect(() => runLint(doc)).not.toThrow();
  });
});

describe('coordinates outside the canvas', () => {
  it('pixels / line / rect partially outside only write in-canvas pixels', () => {
    const doc = doc8();
    const r = draw(doc, {
      layer: L,
      ops: [
        { op: 'pixels', points: [[-1, -1], [100, 100], [8, 0], [0, 8]], color: 8 },
        { op: 'line', from: [-10, 3], to: [20, 3], color: 9 },
        { op: 'rect', x: -2, y: -2, w: 4, h: 4, fill: 10 },
      ],
    });
    expect(r.results[0]!.written).toBe(0);
    expect(r.results[1]!.written).toBe(8);
    expect(r.results[2]!.written).toBe(4);
    expect(r.dirty).toEqual({ x: 0, y: 0, w: 8, h: 4 });
  });

  it('fill seeded outside the canvas changes nothing and warns', () => {
    const doc = doc8();
    const r = draw(doc, { layer: L, ops: [{ op: 'fill', x: 20, y: 20, color: 8 }] });
    expect(r.written).toBe(0);
    // an agent should be told the seed was off-canvas instead of silently getting "0 px"
    expect(doc.drainWarnings().join(' ')).toMatch(/outside|off.?canvas/i);
  });

  it('grid placed at negative offsets drops outside pixels with a warning', () => {
    const doc = doc8();
    const r = draw(doc, { layer: L, ops: [{ op: 'grid', x: -1, y: -1, rows: ['888', '888', '888'] }] });
    expect(r.written).toBe(4);
    expect(doc.drainWarnings().join(' ')).toMatch(/5 pixel\(s\) fell outside/);
  });

  it('oversized shapes on a tiny canvas cost canvas-sized work, not shape-sized work', () => {
    const doc = doc8();
    const t0 = performance.now();
    draw(doc, { layer: L, ops: [{ op: 'rect', x: 0, y: 0, w: 2500, h: 2500, fill: 1 }] });
    const dt = performance.now() - t0;
    // a 2500x2500 rect on an 8x8 canvas should be clipped before rasterising; a typo like w:100000
    // otherwise freezes / OOMs the single-process MCP server
    expect(dt).toBeLessThan(400);
  });

  it('drawing on an offset cel grows the cel image and keeps old pixels in place', () => {
    const doc = doc8();
    draw(doc, { layer: L, ops: [{ op: 'pixels', points: [[1, 1]], color: 8 }] });
    moveCels(doc, L, [0], { dx: 3, dy: 3 }); // pixel now at 4,4; cel at 3,3
    draw(doc, { layer: L, ops: [{ op: 'pixels', points: [[0, 0]], color: 9 }] });
    const rows = rowsOf(doc);
    expect(rows[0]![0]).toBe('9');
    expect(rows[4]![4]).toBe('8');
  });
});

describe('palettes and colour modes', () => {
  it('255 user colours (256 entries) is the maximum', () => {
    const colors = Array.from({ length: 255 }, (_, i) => `#${(i + 1).toString(16).padStart(2, '0')}0000`);
    const doc = createDocument({ name: 'p', width: 4, height: 4, palette: colors });
    expect(doc.state.palette.colors.length).toBe(256);
    expect(() => createDocument({ name: 'p', width: 4, height: 4, palette: [...colors, '#00ff00'] })).toThrow(/max is 255/);
    expect(() => addColors(doc, ['#00ff00'])).toThrow(/exceed 256/);
    draw(doc, { layer: L, ops: [{ op: 'grid', rows: ['[255][1][58][0]'] }] });
    const rp = readPixels(doc, { layer: L, region: { x: 0, y: 0, w: 4, h: 1 }, format: 'json' });
    expect(rp.rows![0]).toEqual([255, 1, 58, 0]);
    expect(() => draw(doc, { layer: L, ops: [{ op: 'grid', rows: ['[256]'] }] })).toThrow(/out of range/);
  });

  it('indexed: off-palette hex snaps to nearest with a warning', () => {
    const doc = doc8();
    draw(doc, { layer: L, ops: [{ op: 'pixels', points: [[0, 0]], color: '#fe0000' }] });
    // pico-8 red #ff004d is index 9 (index 0 is transparent, so preset colours start at 1)
    expect(doc.drainWarnings().join(' ')).toMatch(/snapped to index 9/);
    expect(rowsOf(doc)[0]![0]).toBe('9');
  });

  it('rgba without palette lock stores exact colours; with lock snaps', () => {
    const doc = doc8({ colorMode: 'rgba', settings: { paletteLock: false } });
    draw(doc, { layer: L, ops: [{ op: 'pixels', points: [[0, 0]], color: '#123456' }] });
    expect(readPixels(doc, { layer: L, format: 'json' }).rows![0]![0]).toBe('#123456');
    updateProject(doc, { settings: { paletteLock: true } });
    draw(doc, { layer: L, ops: [{ op: 'pixels', points: [[1, 0]], color: '#fe0000' }] });
    expect(readPixels(doc, { layer: L, format: 'json' }).rows![0]![1]).toBe(9);
  });

  it('missingColor "add" grows the palette; "error" rolls the batch back', () => {
    const doc = doc8({ settings: { missingColor: 'add' } });
    draw(doc, { layer: L, ops: [{ op: 'pixels', points: [[0, 0]], color: '#123456' }] });
    expect(doc.state.palette.colors.length).toBe(18);
    const errDoc = doc8({ settings: { missingColor: 'error' } });
    const before = JSON.stringify(errDoc.state);
    expect(() =>
      draw(errDoc, { layer: L, ops: [{ op: 'rect', x: 0, y: 0, w: 4, h: 4, fill: 8 }, { op: 'pixels', points: [[0, 0]], color: '#123456' }] }),
    ).toThrow(/ops\[1\].*not in the palette/);
    expect(JSON.stringify(errDoc.state)).toBe(before);
    expect(rowsOf(errDoc)[0]).toBe('........');
  });

  it('hex colours without "#" that look like numbers are treated as indices (ambiguity)', () => {
    const doc = doc8();
    expect(() => draw(doc, { layer: L, ops: [{ op: 'pixels', points: [[0, 0]], color: '112233' }] })).toThrow(/out of range/);
  });
});

describe('draw ops with unusual parameters', () => {
  it('rect thickness larger than half the size fills the rect', () => {
    const doc = doc8();
    const r = draw(doc, { layer: L, ops: [{ op: 'rect', x: 0, y: 0, w: 4, h: 4, color: 8, thickness: 10 }] });
    expect(r.written).toBe(16);
  });

  it('degenerate ellipses (1xN, 2x1) and circle r=0 write pixels', () => {
    const doc = doc8();
    const r = draw(doc, {
      layer: L,
      ops: [
        { op: 'ellipse', x: 0, y: 0, w: 1, h: 5, color: 8 },
        { op: 'ellipse', x: 2, y: 0, w: 2, h: 1, color: 9 },
        { op: 'circle', cx: 6, cy: 6, r: 0, fill: 10 },
      ],
    });
    expect(r.results.map((x) => x.written)).toEqual([5, 2, 1]);
  });

  it('zero-size rect/ellipse is rejected with a clear message', () => {
    const doc = doc8();
    expect(() => draw(doc, { layer: L, ops: [{ op: 'rect', x: 0, y: 0, w: 0, h: 3, fill: 1 }] })).toThrow(/empty size/);
  });

  it('gradient with identical endpoints does not produce NaN / garbage', () => {
    const doc = doc8();
    draw(doc, { layer: L, ops: [{ op: 'gradient', from: [3, 3], to: [3, 3], colors: [8, 9], area: { x: 0, y: 0, w: 8, h: 1 } }] });
    const row = rowsOf(doc)[0]!;
    expect(row).toMatch(/^[89]{8}$/);
  });

  it('custom pattern with empty rows does not crash', () => {
    const doc = doc8();
    expect(() => draw(doc, { layer: L, ops: [{ op: 'pattern', pattern: ['', '1'], colors: [8] }] })).not.toThrow();
  });

  it('shade/selout/outline on an empty layer are no-ops', () => {
    const doc = doc8();
    const r = draw(doc, { layer: L, ops: [{ op: 'shade', mode: 'light' }, { op: 'selout' }, { op: 'outline', color: 1 }, { op: 'shade', amount: -1 }] });
    expect(r.written).toBe(0);
  });

  it('shade with an unknown light direction is rejected (not silently ignored)', () => {
    const doc = doc8();
    draw(doc, { layer: L, ops: [{ op: 'rect', x: 1, y: 1, w: 6, h: 6, fill: 8 }] });
    expect(() => draw(doc, { layer: L, ops: [{ op: 'shade', mode: 'light', light: 'upwards' as never }] })).toThrow(/light/i);
  });

  it('text with unknown glyphs and newlines', () => {
    const doc = createDocument({ name: 't', width: 32, height: 16, palette: 'pico-8' });
    const r = draw(doc, { layer: L, ops: [{ op: 'text', x: 0, y: 0, text: 'é€\nab', color: 7, font: '3x5' }] });
    expect(r.written).toBeGreaterThan(0);
    const empty = draw(doc, { layer: L, ops: [{ op: 'text', x: 0, y: 0, text: '', color: 7 }] });
    expect(empty.written).toBe(0);
  });

  it('replace_color from transparent is rejected or explained (not a silent 0)', () => {
    const doc = doc8();
    const r = draw(doc, { layer: L, ops: [{ op: 'replace_color', from: 0, to: 8 }] });
    // silently writing 0 px is confusing; either fill transparent pixels or warn
    expect(r.written > 0 || doc.drainWarnings().length > 0).toBe(true);
  });

  it('erase honours the clip but ignores ink "behind" (erasing is always a replace)', () => {
    const doc = doc8();
    draw(doc, { layer: L, ops: [{ op: 'rect', x: 0, y: 0, w: 8, h: 8, fill: 8 }] });
    const r = draw(doc, { layer: L, ink: 'behind', ops: [{ op: 'erase', area: { x: 0, y: 0, w: 2, h: 2 } }] });
    expect(r.written).toBe(4);
  });

  it('copy/paste of an area partly outside the canvas', () => {
    const doc = doc8();
    draw(doc, { layer: L, ops: [{ op: 'rect', x: 0, y: 0, w: 2, h: 2, fill: 8 }] });
    const r = draw(doc, { layer: L, ops: [{ op: 'copy', area: { x: -4, y: -4, w: 6, h: 6 } }, { op: 'paste', x: 5, y: 5 }] });
    expect(r.results[0]!.note).toMatch(/2x2 from 0,0/);
    expect(rowsOf(doc)[5]!.slice(5)).toBe('88.');
  });

  it('stamp with flipX mirrors the source', () => {
    const doc = doc8();
    draw(doc, { layer: L, ops: [{ op: 'grid', rows: ['89..'] }] });
    draw(doc, { layer: L, ops: [{ op: 'stamp', from: { area: { x: 0, y: 0, w: 2, h: 1 } }, x: 4, y: 0, flipX: true }] });
    expect(rowsOf(doc)[0]).toBe('89..98..');
  });

  it('fill with tolerance in indexed mode and composite reference', () => {
    const doc = doc8();
    addLayer(doc, { name: 'ink' });
    draw(doc, { layer: 'ink', ops: [{ op: 'rect', x: 0, y: 0, w: 8, h: 8, color: 1 }] });
    const r = draw(doc, { layer: L, ops: [{ op: 'fill', x: 3, y: 3, color: 8, reference: 'composite' }] });
    expect(r.written).toBe(36);
  });

  it('quantize in RGBA snaps to palette', () => {
    const doc = doc8({ colorMode: 'rgba', settings: { paletteLock: false } });
    draw(doc, { layer: L, ops: [{ op: 'pixels', points: [[0, 0]], color: '#fe0101' }, { op: 'quantize' }] });
    expect(readPixels(doc, { layer: L, format: 'json' }).rows![0]![0]).toBe(9);
  });
});

describe('selections and clip', () => {
  it('clip restricts every op, including mirrored symmetry pixels', () => {
    const doc = doc8();
    select(doc, { shape: 'rect', x: 0, y: 0, w: 4, h: 8 });
    const r = draw(doc, { layer: L, clip: 'active', symmetry: { x: true }, ops: [{ op: 'pixels', points: [[1, 1]], color: 8 }] });
    expect(r.written).toBe(1);
    expect(r.results[0]!.clipped).toBe(1);
    expect(rowsOf(doc)[1]).toBe('.8......');
  });

  it('selection moved fully off-canvas becomes empty and clipped draws write nothing', () => {
    const doc = doc8();
    select(doc, { shape: 'rect', x: 0, y: 0, w: 2, h: 2 });
    const info = modifySelection(doc, 'active', { action: 'move', dx: 20, dy: 0 });
    expect(info.pixels).toBe(0);
    const r = draw(doc, { layer: L, clip: 'active', ops: [{ op: 'rect', x: 0, y: 0, w: 8, h: 8, fill: 8 }] });
    expect(r.written).toBe(0);
  });

  it('selection survives canvas resize (mask is re-homed)', () => {
    const doc = doc8();
    select(doc, { shape: 'rect', x: 0, y: 0, w: 2, h: 2 });
    resizeCanvas(doc, 12, 12, 'center');
    draw(doc, { layer: L, clip: 'active', ops: [{ op: 'rect', x: 0, y: 0, w: 12, h: 12, fill: 8 }] });
    const rows = rowsOf(doc);
    expect(rows[2]).toBe('..88........');
  });

  it('grow/shrink/border/invert counts', () => {
    const doc = doc8();
    select(doc, { shape: 'rect', x: 2, y: 2, w: 4, h: 4 });
    expect(modifySelection(doc, 'active', { action: 'grow', amount: 1 }).pixels).toBe(36);
    expect(modifySelection(doc, 'active', { action: 'shrink', amount: 1 }).pixels).toBe(16);
    expect(modifySelection(doc, 'active', { action: 'invert' }).pixels).toBe(48);
  });

  it('transform scope selection: flip_h mirrors only the selected pixels', () => {
    const doc = doc8();
    draw(doc, { layer: L, ops: [{ op: 'grid', rows: ['89......', '89......'] }] });
    select(doc, { shape: 'rect', x: 0, y: 0, w: 2, h: 1 });
    transform(doc, { scope: 'selection', layer: L, transform: { op: 'flip_h' } });
    expect(rowsOf(doc).slice(0, 2)).toEqual(['98......', '89......']);
  });

  it('transform scope selection: offset moves contents and the mask', () => {
    const doc = doc8();
    draw(doc, { layer: L, ops: [{ op: 'grid', rows: ['8.......'] }] });
    select(doc, { shape: 'rect', x: 0, y: 0, w: 1, h: 1 });
    transform(doc, { scope: 'selection', layer: L, transform: { op: 'offset', dx: 3, dy: 0 } });
    expect(rowsOf(doc)[0]).toBe('...8....');
    expect(doc.mask(doc.state.selections.active!).bounds()).toEqual({ x: 3, y: 0, w: 1, h: 1 });
  });
});

describe('symmetry', () => {
  it('x:true on an even width mirrors across the centre line', () => {
    const doc = doc8();
    draw(doc, { layer: L, symmetry: { x: true }, ops: [{ op: 'pixels', points: [[0, 0], [3, 1]], color: 8 }] });
    expect(rowsOf(doc).slice(0, 2)).toEqual(['8......8', '...88...']);
  });

  it('x and y symmetry produce four copies; pixels on the axis are not doubled', () => {
    const doc = createDocument({ name: 's', width: 7, height: 7, palette: 'pico-8' });
    const r = draw(doc, { layer: L, symmetry: { x: true, y: true }, ops: [{ op: 'pixels', points: [[0, 0], [3, 3]], color: 8 }] });
    expect(r.written).toBe(5);
  });

  it('numeric axis mirrors around that pixel', () => {
    const doc = doc8();
    draw(doc, { layer: L, symmetry: { x: 2 }, ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    expect(rowsOf(doc)[0]).toBe('8...8...');
  });

  it('grid op honours symmetry', () => {
    const doc = doc8();
    draw(doc, { layer: L, symmetry: { x: true }, ops: [{ op: 'grid', rows: ['89'] }] });
    expect(rowsOf(doc)[0]).toBe('89....98');
  });
});

describe('linked cels', () => {
  it('editing a linked cel changes every linked frame and warns', () => {
    const doc = doc8({ frames: 3 });
    linkCels(doc, L, [0, 1, 2]);
    draw(doc, { layer: L, frame: 1, ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    expect(doc.drainWarnings().join(' ')).toMatch(/linked with frame\(s\) 0,2/);
    for (const f of [0, 1, 2]) expect(rowsOf(doc, L, f)[0]![0]).toBe('8');
    unlinkCels(doc, L, [1]);
    draw(doc, { layer: L, frame: 1, ops: [{ op: 'pixels', points: [[1, 0]], color: 9 }] });
    expect(rowsOf(doc, L, 0)[0]).toBe('8.......');
    expect(rowsOf(doc, L, 1)[0]).toBe('89......');
    expect(rowsOf(doc, L, 2)[0]).toBe('8.......');
  });

  it('linked cels with different offsets stay consistent when one of them grows', () => {
    const doc = doc8({ frames: 2 });
    draw(doc, { layer: L, ops: [{ op: 'pixels', points: [[2, 2]], color: 8 }] });
    linkCels(doc, L, [0, 1]);
    moveCels(doc, L, [0], { x: 3, y: 0 }); // frame0 pixel → 5,2 ; frame1 pixel stays 2,2
    draw(doc, { layer: L, frame: 0, ops: [{ op: 'pixels', points: [[0, 0]], color: 9 }] }); // grows image to the left
    expect(rowsOf(doc, L, 0)[2]![5]).toBe('8');
    expect(rowsOf(doc, L, 1)[2]![2]).toBe('8');
  });

  it('new frames on continuous layers are linked', () => {
    const doc = doc8();
    addLayer(doc, { name: 'cont', continuous: true });
    draw(doc, { layer: 'cont', ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    addFrames(doc, { count: 2 });
    const cels = doc.state.cels.filter((c) => c.layerId === 'L2');
    expect(new Set(cels.map((c) => c.imageId)).size).toBe(1);
    expect(cels.length).toBe(3);
  });
});

describe('scale / resize keep content aligned', () => {
  it('scaleSprite 2x then render contains the same colour layout', () => {
    const doc = doc8();
    draw(doc, { layer: L, ops: [{ op: 'pixels', points: [[1, 0]], color: 8 }] });
    scaleSprite(doc, { factor: 2 });
    const rows = rowsOf(doc);
    expect(rows[0]).toBe('..88............');
    expect(rows[1]).toBe('..88............');
  });

  it('compositeHex helper sanity', () => {
    expect(compositeHex(doc8()).length).toBe(8 * 8 * 4 * 2);
  });
});
