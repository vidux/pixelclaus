import { describe, expect, it } from 'vitest';
import {
  addFrames,
  createDocument,
  draw,
  makePalette,
  MAX_VIEW_SIZE,
  parseGrid,
  Raster,
  renderView,
  runLint,
  select,
  setPalette,
} from '../src/index.js';
import { makeDoc, rows } from './helpers.js';

describe('input robustness', () => {
  it('fractional fill and wand seeds are rounded instead of looping', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'fill', x: 1.4, y: 2.6, color: 3 }] });
    expect(rows(doc)[0]).toBe('33333333');
    const m = select(doc, { shape: 'wand', x: 2.5, y: 3, name: 'w' });
    expect(m.pixels).toBe(64);
  });

  it('every point of a long path is range-checked', () => {
    const doc = makeDoc();
    const points = Array.from({ length: 5000 }, (_, i) => [i % 8, 0] as [number, number]);
    points.push([1e9, 1e9]);
    expect(() => draw(doc, { ops: [{ op: 'path', color: 2, points }] })).toThrow(/out of range/);
  });

  it('huge in-range paths and wide strokes finish quickly and draw the visible part', () => {
    const doc = makeDoc({ width: 32, height: 32 });
    const t0 = Date.now();
    draw(doc, {
      ops: [
        {
          op: 'path',
          color: 2,
          points: [
            [-65536, -65536],
            [65536, 65536],
          ],
        },
        { op: 'line', from: [-65536, -65536], to: [65536, 65536], color: 3, width: 32 },
      ],
    });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(rows(doc)[16]).toMatch(/3/);
  });

  it('wide strokes still reach the canvas through an off-centre symmetry axis', () => {
    const doc = makeDoc({ width: 16, height: 4 });
    // axis at x=2: a stroke at x=-6..-4 mirrors to x=8..10
    draw(doc, { symmetry: { x: 2 }, ops: [{ op: 'line', from: [-5, 1], to: [-5, 2], color: 3, width: 3 }] });
    expect(rows(doc)[1]!.slice(8, 11)).toMatch(/3/);
  });

  it('stamp from a missing frame is an error; an empty source carries a note', () => {
    const doc = makeDoc();
    expect(() => draw(doc, { ops: [{ op: 'stamp', from: { frame: 5 }, dx: 1 }] })).toThrow(/frame/i);
    addFrames(doc, { count: 1 });
    const r = draw(doc, { frame: 1, ops: [{ op: 'stamp', from: { frame: 0 }, dx: 1 }] });
    expect(r.results[0]!.note).toMatch(/source area is empty/);
  });

  it('a "|" legend key is a pixel, not a row prefix', () => {
    const doc = makeDoc({ width: 5, height: 1 });
    draw(doc, { ops: [{ op: 'grid', rows: ['11 | 11'], legend: { '|': 4 } }] });
    expect(rows(doc)[0]).toBe('11411');
    expect(parseGrid(['07| 11']).width).toBe(2);
  });

  it('emoji legends work with or without the variation selector', () => {
    const doc = makeDoc({ width: 3, height: 1 });
    draw(doc, { ops: [{ op: 'grid', rows: ['❤️❤.'], legend: { '❤️': 9 } }] });
    expect(rows(doc)[0]).toBe('99.');
  });

  it('explicit render scale is reduced to stay inside the image budget', () => {
    const doc = makeDoc({ width: 128, height: 128 });
    const out = renderView(doc, { scale: 64 });
    expect(Math.max(out.raster.width, out.raster.height)).toBeLessThanOrEqual(MAX_VIEW_SIZE);
    expect(String(out.info.scaleReduced)).toMatch(/64 →/);
    const tile = renderView(doc, { view: 'tile', scale: 16 });
    expect(Math.max(tile.raster.width, tile.raster.height)).toBeLessThanOrEqual(MAX_VIEW_SIZE);
  });

  it('refuses to allocate absurd rasters', () => {
    expect(() => new Raster(70000, 70000)).toThrow(/too large/);
  });
});

describe('palettes', () => {
  it('setPalette and createDocument keep colour names', () => {
    const doc = makeDoc();
    setPalette(doc, ['#ff0000', '#00ff00'], { names: ['Fire Red', undefined] });
    expect(doc.state.palette.names).toEqual({ '1': 'Fire Red' });
    const d2 = createDocument({
      name: 'n',
      width: 4,
      height: 4,
      palette: ['#112233'],
      paletteNames: ['Ink'],
    });
    expect(d2.state.palette.names).toEqual({ '1': 'Ink' });
    expect(makePalette('x', ['#000000']).names).toEqual({});
  });

  it('the default endesga-32 preset ramps pass ramp-contrast', () => {
    const doc = createDocument({ name: 'e', width: 16, height: 16, palette: 'endesga-32' });
    draw(doc, { ops: [{ op: 'rect', x: 2, y: 2, w: 8, h: 8, fill: 9 }] });
    const f = runLint(doc, { rules: ['ramp-contrast'] }).findings;
    expect(f.map((x) => x.message).join('\n')).not.toMatch(/rust/);
  });
});

describe('per-project pixel budget', () => {
  it('refuses a background that would allocate more than the budget, before allocating', () => {
    expect(() =>
      createDocument({
        name: 'huge',
        width: 4096,
        height: 4096,
        frames: 200,
        background: 1,
        palette: 'pico-8',
      }),
    ).toThrow(/Mpx/);
  });

  it('refuses copying frames past the budget but allows linked frames', () => {
    const doc = createDocument({
      name: 'big',
      width: 4096,
      height: 4096,
      frames: 1,
      background: 1,
      palette: 'pico-8',
    });
    expect(() => addFrames(doc, { count: 40, cels: 'copy' })).toThrow(/Mpx/);
    expect(doc.state.frames).toHaveLength(1);
    addFrames(doc, { count: 40, cels: 'link' });
    expect(doc.state.frames).toHaveLength(41);
  });
});
