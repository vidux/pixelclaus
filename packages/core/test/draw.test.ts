import { describe, expect, it } from 'vitest';
import {
  addLayer,
  createDocument,
  draw,
  PixelClausError,
  select,
  updateLayer,
  updateProject,
  linkCels,
  addFrames,
} from '../src/index.js';
import { makeDoc, rows } from './helpers.js';

const L = 'Layer 1';

describe('draw primitives', () => {
  it('rect outline and fill', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'rect', x: 1, y: 1, w: 4, h: 3, color: 1, fill: 8 }] });
    expect(rows(doc, L).slice(0, 5)).toEqual(['........', '.1111...', '.1881...', '.1111...', '........']);
  });

  it('line endpoints are inclusive', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'line', from: [0, 0], to: [7, 7], color: 7 }] });
    const r = rows(doc, L);
    for (let i = 0; i < 8; i++) expect(r[i]![i]).toBe('7');
  });

  it('thick line uses brush', () => {
    const doc = makeDoc();
    const res = draw(doc, {
      ops: [{ op: 'line', from: [1, 4], to: [6, 4], color: 7, width: 3, brush: 'square' }],
    });
    expect(res.written).toBe(8 * 3); // square brush extends 1px past each end
  });

  it('path with pixel-perfect removes L corners', () => {
    const doc = makeDoc();
    draw(doc, {
      ops: [
        {
          op: 'path',
          points: [
            [0, 0],
            [1, 0],
            [1, 1],
            [2, 1],
            [2, 2],
          ],
          color: 7,
        },
      ],
    });
    expect(rows(doc, L).slice(0, 3)).toEqual(['7.......', '.7......', '..7.....']);
    const doc2 = makeDoc();
    draw(doc2, {
      ops: [
        {
          op: 'path',
          points: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
          color: 7,
          pixelPerfect: false,
        },
      ],
    });
    expect(rows(doc2, L).slice(0, 2)).toEqual(['77......', '.7......']);
  });

  it('ellipse is symmetric and filled', () => {
    const doc = createDocument({ name: 't', width: 9, height: 9, palette: 'pico-8' });
    draw(doc, { ops: [{ op: 'circle', cx: 4, cy: 4, r: 3, fill: 8, color: 1 }] });
    const r = rows(doc, L);
    for (const row of r) expect(row).toBe([...row].reverse().join(''));
    expect(r[4]).toBe('.1888881.');
    expect(r[0]).toBe('.........');
  });

  it('small ellipses look right', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'ellipse', x: 0, y: 0, w: 4, h: 4, color: 7 }] });
    expect(rows(doc, L).slice(0, 4)).toEqual(['.77.....', '7..7....', '7..7....', '.77.....']);
  });

  it('polygon fill', () => {
    const doc = makeDoc();
    const res = draw(doc, {
      ops: [
        {
          op: 'polygon',
          points: [
            [0, 0],
            [7, 0],
            [0, 7],
          ],
          fill: 3,
        },
      ],
    });
    expect(res.written).toBeGreaterThan(28);
    expect(rows(doc, L)[0]).toBe('33333333');
    expect(rows(doc, L)[7]![0]).toBe('3');
  });

  it('pixels op with per-point colours', () => {
    const doc = makeDoc();
    draw(doc, {
      ops: [{ op: 'pixels', points: [[0, 0, 8], { x: 1, y: 0, color: '#29adff' }, [2, 0]], color: 11 }],
    });
    expect(rows(doc, L)[0]).toBe('8db.....'); // #29adff = pico-8 blue = index 13 ('d')
  });

  it('pixels without colour fail with hint', () => {
    const doc = makeDoc();
    expect(() => draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]] }] })).toThrow(/no colour/);
  });
});

describe('grid op', () => {
  it('writes ascii with default legend, RLE and brackets', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'grid', x: 0, y: 0, rows: ['.1*3[8]', '~~~~.'] }] });
    expect(rows(doc, L).slice(0, 2)).toEqual(['.1118...', '........']);
  });

  it('custom legend and overlay mode', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'rect', x: 0, y: 0, w: 8, h: 1, fill: 1 }] });
    draw(doc, { ops: [{ op: 'grid', rows: ['k.k'], legend: { k: 8 }, mode: 'overlay' }] });
    expect(rows(doc, L)[0]).toBe('81811111');
    draw(doc, { ops: [{ op: 'grid', rows: ['k.k'], legend: { k: 8 } }] });
    expect(rows(doc, L)[0]).toBe('8.811111');
  });

  it('accepts read_pixels output verbatim (row prefixes, header lines)', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'grid', rows: '  | 0123\n0| .12.\n1| 3..4' }] });
    expect(rows(doc, L).slice(0, 2)).toEqual(['.12.....', '3..4....']);
  });

  it('rejects ragged rows with exact row numbers', () => {
    const doc = makeDoc();
    try {
      draw(doc, { ops: [{ op: 'grid', rows: ['111', '11', '111'] }] });
      expect.fail('should throw');
    } catch (e) {
      expect((e as PixelClausError).message).toMatch(/row 1 has 2/);
    }
  });

  it('rejects unknown legend characters', () => {
    const doc = makeDoc();
    expect(() => draw(doc, { ops: [{ op: 'grid', rows: ['#'] }] })).toThrow(/not in the legend/);
  });

  it('warns when pixels fall outside the canvas', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'grid', x: 6, y: 0, rows: ['1111'] }] });
    expect(doc.drainWarnings().join()).toMatch(/outside/);
  });
});

describe('fill & colour ops', () => {
  it('contiguous flood fill stops at borders', () => {
    const doc = makeDoc();
    draw(doc, {
      ops: [
        { op: 'rect', x: 0, y: 0, w: 5, h: 5, color: 1 },
        { op: 'fill', x: 2, y: 2, color: 8 },
      ],
    });
    const r = rows(doc, L);
    expect(r[2]).toBe('18881...');
    expect(r[6]).toBe('........');
  });

  it('global fill replaces all matching pixels', () => {
    const doc = makeDoc();
    draw(doc, {
      ops: [
        {
          op: 'pixels',
          points: [
            [0, 0],
            [7, 7],
          ],
          color: 2,
        },
        { op: 'fill', x: 0, y: 0, color: 9, contiguous: false },
      ],
    });
    expect(rows(doc, L)[7]![7]).toBe('9');
  });

  it('composite reference fills under an outline layer', () => {
    const doc = makeDoc({ layers: ['Fill', 'Line'] });
    draw(doc, { layer: 'Line', ops: [{ op: 'rect', x: 0, y: 0, w: 5, h: 5, color: 1 }] });
    draw(doc, { layer: 'Fill', ops: [{ op: 'fill', x: 2, y: 2, color: 8, reference: 'composite' }] });
    expect(rows(doc, 'Fill')[2]).toBe('.888....');
  });

  it('replace_color with scopes', () => {
    const doc = makeDoc({ frames: 2 });
    draw(doc, { frame: 0, ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    draw(doc, { frame: 1, ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    draw(doc, { ops: [{ op: 'replace_color', from: 8, to: 12, scope: 'layer' }] });
    expect(rows(doc, L, 0)[0]![0]).toBe('c');
    expect(rows(doc, L, 1)[0]![0]).toBe('c');
  });

  it('gradient with dithering uses all stops', () => {
    const doc = createDocument({ name: 'g', width: 16, height: 4, palette: 'pico-8' });
    draw(doc, { ops: [{ op: 'gradient', from: [0, 0], to: [15, 0], colors: [1, 12, 7], dither: 'bayer4' }] });
    const r = rows(doc, L)[0]!;
    expect(r[0]).toBe('1');
    expect(r[15]).toBe('7');
    expect(r).toContain('c');
  });

  it('pattern fill', () => {
    const doc = makeDoc();
    draw(doc, {
      ops: [{ op: 'pattern', pattern: 'checker', colors: [7, 1], area: { x: 0, y: 0, w: 4, h: 2 } }],
    });
    expect(rows(doc, L).slice(0, 2)).toEqual(['7171....', '1717....']);
  });

  it('text renders with 3x5 font', () => {
    const doc = createDocument({ name: 't', width: 12, height: 6, palette: 'pico-8' });
    const res = draw(doc, { ops: [{ op: 'text', x: 0, y: 0, text: 'HI', color: 7, font: '3x5' }] });
    expect(res.written).toBeGreaterThan(10);
    expect(rows(doc, L)[2]!.slice(0, 7)).toBe('777..7.');
  });

  it('adjust snaps to palette in indexed mode with a warning', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    draw(doc, { ops: [{ op: 'adjust', invert: true }] });
    expect(rows(doc, L)[0]![0]).not.toBe('8');
    expect(doc.drainWarnings().join()).toMatch(/snaps/);
  });

  it('quantize snaps RGBA pixels to the palette', () => {
    const doc = makeDoc({ colorMode: 'rgba', settings: { paletteLock: false } });
    draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: '#fe0150' }] });
    expect(rows(doc, L)[0]![0]).toBe('#');
    draw(doc, { ops: [{ op: 'quantize' }] });
    expect(rows(doc, L)[0]![0]).toBe('9'); // pico-8 red #ff004d is index 9 (0 = transparent)
  });

  it('snaps off-palette hex in indexed mode with warning', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: '#fe0150' }] });
    expect(rows(doc, L)[0]![0]).toBe('9');
    expect(doc.drainWarnings()[0]).toMatch(/snapped to index 9/);
  });

  it('missingColor=add appends colours', () => {
    const doc = makeDoc({ settings: { missingColor: 'add' } });
    draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: '#123456' }] });
    expect(doc.state.palette.colors.length).toBe(18);
    expect(doc.state.palette.colors[17]).toBe('#123456ff');
  });

  it('colour names and ramp references resolve', () => {
    const doc = makeDoc();
    doc.state.palette.names['8'] = 'red';
    draw(doc, {
      ops: [
        { op: 'pixels', points: [[0, 0]], color: 'red' },
        { op: 'pixels', points: [[1, 0]], color: 'ramp:gray:0' },
      ],
    });
    expect(rows(doc, L)[0]!.slice(0, 2)).toBe('81');
  });
});

describe('effects', () => {
  it('outline outside and inside', () => {
    const doc = makeDoc();
    draw(doc, {
      ops: [
        { op: 'rect', x: 2, y: 2, w: 3, h: 3, fill: 8 },
        { op: 'outline', color: 1 },
      ],
    });
    const r = rows(doc, L);
    expect(r[1]).toBe('..111...');
    expect(r[2]).toBe('.18881..');
    const doc2 = makeDoc();
    draw(doc2, {
      ops: [
        { op: 'rect', x: 2, y: 2, w: 3, h: 3, fill: 8 },
        { op: 'outline', color: 1, side: 'inside' },
      ],
    });
    expect(rows(doc2, L)[3]).toBe('..181...');
  });

  it('shade shift moves along ramps', () => {
    const doc = makeDoc();
    // pico-8 gray ramp = indices 1,6,7,8
    draw(doc, {
      ops: [
        { op: 'pixels', points: [[0, 0]], color: 7 },
        { op: 'shade', amount: -1 },
      ],
    });
    expect(rows(doc, L)[0]![0]).toBe('6');
    draw(doc, { ops: [{ op: 'shade', amount: 2 }] });
    expect(rows(doc, L)[0]![0]).toBe('8');
  });

  it('light shading highlights the light-facing edge', () => {
    const doc = makeDoc();
    draw(doc, {
      ops: [
        { op: 'rect', x: 2, y: 2, w: 4, h: 4, fill: 7 },
        { op: 'shade', mode: 'light', light: 'top-left' },
      ],
    });
    const r = rows(doc, L);
    expect(r[2]![2]).toBe('8');
    expect(r[5]![5]).toBe('6');
    expect(r[3]![3]).toBe('7');
  });

  it('selout recolours light-side outline', () => {
    const doc = makeDoc();
    draw(doc, {
      ops: [
        { op: 'rect', x: 1, y: 1, w: 6, h: 6, color: 1, fill: 7 },
        { op: 'selout', light: 'top' },
      ],
    });
    const r = rows(doc, L);
    expect(r[1]![3]).toBe('6'); // light side: one step darker than the interior (7 → 6)
    expect(r[6]![3]).toBe('1'); // shadow side keeps the dark outline
  });
});

describe('writer features', () => {
  it('symmetry mirrors across the centre', () => {
    const doc = makeDoc();
    draw(doc, { symmetry: { x: true }, ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    expect(rows(doc, L)[0]).toBe('8......8');
    const doc2 = makeDoc();
    draw(doc2, { symmetry: { x: true, y: true }, ops: [{ op: 'pixels', points: [[1, 1]], color: 8 }] });
    expect(rows(doc2, L)[6]).toBe('.8....8.');
  });

  it('ink behind and inside', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    draw(doc, { ink: 'behind', ops: [{ op: 'rect', x: 0, y: 0, w: 2, h: 1, fill: 1 }] });
    expect(rows(doc, L)[0]!.slice(0, 2)).toBe('81');
    draw(doc, { ink: 'inside', ops: [{ op: 'rect', x: 0, y: 0, w: 3, h: 1, fill: 12 }] });
    expect(rows(doc, L)[0]!.slice(0, 3)).toBe('cc.');
  });

  it('clip restricts to a selection', () => {
    const doc = makeDoc();
    select(doc, { shape: 'rect', x: 0, y: 0, w: 2, h: 2, name: 'corner' });
    const res = draw(doc, { clip: 'corner', ops: [{ op: 'rect', x: 0, y: 0, w: 8, h: 8, fill: 8 }] });
    expect(res.written).toBe(4);
    expect(res.results[0]!.clipped).toBe(60);
  });

  it('erase and clear', () => {
    const doc = makeDoc();
    draw(doc, {
      ops: [
        { op: 'rect', x: 0, y: 0, w: 8, h: 8, fill: 8 },
        { op: 'erase', area: { x: 0, y: 0, w: 4, h: 1 } },
      ],
    });
    expect(rows(doc, L)[0]).toBe('....8888');
    draw(doc, { ops: [{ op: 'clear' }] });
    expect(rows(doc, L)[1]).toBe('........');
    expect(() => draw(doc, { ops: [{ op: 'erase' }] })).toThrow(/area/);
  });

  it('copy / paste / stamp', () => {
    const doc = makeDoc({ frames: 2 });
    draw(doc, {
      ops: [
        { op: 'grid', rows: ['12', '34'] },
        { op: 'copy', area: { x: 0, y: 0, w: 2, h: 2 }, name: 'tile' },
        { op: 'paste', name: 'tile', x: 4, y: 4 },
      ],
    });
    expect(rows(doc, L)[5]!.slice(4, 6)).toBe('34');
    draw(doc, {
      frame: 1,
      ops: [{ op: 'stamp', from: { frame: 0, area: { x: 0, y: 0, w: 2, h: 2 } }, dx: 1, flipX: true }],
    });
    expect(rows(doc, L, 1)[0]!.slice(1, 3)).toBe('21');
  });

  it('refuses locked layers and group layers', () => {
    const doc = makeDoc();
    updateLayer(doc, L, { locked: true });
    expect(() => draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 1 }] })).toThrow(/locked/);
    const g = addLayer(doc, { type: 'group', name: 'G' });
    expect(() => draw(doc, { layer: g.id, ops: [{ op: 'pixels', points: [[0, 0]], color: 1 }] })).toThrow(
      /group/,
    );
  });

  it('warns when editing linked cels and hidden layers', () => {
    const doc = makeDoc({ frames: 3 });
    linkCels(doc, L, [0, 1, 2]);
    updateLayer(doc, L, { visible: false });
    doc.drainWarnings();
    draw(doc, { frame: 1, ops: [{ op: 'pixels', points: [[0, 0]], color: 1 }] });
    const w = doc.drainWarnings().join(' ');
    expect(w).toMatch(/linked with frame\(s\) 0,2/);
    expect(w).toMatch(/hidden/);
    expect(rows(doc, L, 2)[0]![0]).toBe('1');
  });

  it('requires a layer when ambiguous', () => {
    const doc = makeDoc({ layers: ['A', 'B'] });
    expect(() => draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 1 }] })).toThrow(
      /No layer specified/,
    );
  });

  it('cel grows when offset content is drawn outside', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    doc.state.cels[0]!.x = 4; // simulate moved cel
    draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 9 }] });
    const r = rows(doc, L);
    expect(r[0]).toBe('9...8...');
  });

  it('continuous layers and frame helpers interplay', () => {
    const doc = makeDoc();
    updateLayer(doc, L, { continuous: true });
    draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    addFrames(doc, { count: 2 });
    expect(new Set(doc.state.cels.map((c) => c.imageId)).size).toBe(1);
    updateProject(doc, { settings: { lightDirection: 'top' } });
    expect(doc.state.settings.lightDirection).toBe('top');
  });
});
