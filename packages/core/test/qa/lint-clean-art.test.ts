/**
 * QA: lint should not raise warnings on clean art, especially art produced by PixelClaus's own ops.
 */
import { describe, expect, it } from 'vitest';
import { addFrames, addTag, createDocument, draw, runLint, type LintRule } from '@pixelclaus/core';

const L = 'Layer 1';

function warnings(doc: ReturnType<typeof createDocument>, rules?: LintRule[]) {
  return runLint(doc, rules ? { rules } : {}).findings.filter((f) => f.severity !== 'info');
}

describe('lint on clean art', () => {
  it('outlined rectangle: no warnings', () => {
    const doc = createDocument({ name: 'a', width: 16, height: 16, palette: 'pico-8' });
    draw(doc, { layer: L, ops: [{ op: 'rect', x: 2, y: 2, w: 12, h: 12, color: 1, fill: 9 }] });
    expect(warnings(doc)).toEqual([]);
  });

  it('checkerboard dither inside an outline: no orphan/doubles warnings', () => {
    const doc = createDocument({ name: 'a', width: 16, height: 16, palette: 'pico-8' });
    draw(doc, { layer: L, ops: [{ op: 'rect', x: 0, y: 0, w: 16, h: 16, color: 1 }, { op: 'pattern', pattern: 'checker', colors: [9, 10], area: { x: 1, y: 1, w: 14, h: 14 } }] });
    expect(warnings(doc)).toEqual([]);
  });

  it('perfect 1:1 and 2:1 lines: no doubles/jaggies', () => {
    const doc = createDocument({ name: 'a', width: 16, height: 16, palette: 'pico-8' });
    draw(doc, { layer: L, ops: [{ op: 'line', from: [0, 0], to: [15, 15], color: 8 }, { op: 'line', from: [0, 15], to: [15, 8], color: 12 }] });
    expect(runLint(doc, { rules: ['doubles', 'jaggies'] }).findings).toEqual([]);
  });

  it('seamless brick tile has no tile-seams finding; symmetric sprite has no symmetry finding', () => {
    const tile = createDocument({ name: 'a', width: 8, height: 8, palette: 'pico-8' });
    draw(tile, { layer: L, ops: [{ op: 'pattern', pattern: 'bricks', colors: [5, 6] }] });
    expect(runLint(tile, { rules: ['tile-seams'] }).findings).toEqual([]);
    const sym = createDocument({ name: 'a', width: 16, height: 16, palette: 'pico-8' });
    draw(sym, { layer: L, symmetry: { x: true }, ops: [{ op: 'rect', x: 2, y: 2, w: 4, h: 10, fill: 9 }, { op: 'pixels', points: [[1, 1]], color: 8 }] });
    expect(runLint(sym, { rules: ['symmetry'] }).findings).toEqual([]);
  });

  it('idle animation with identical frames: no animation warnings', () => {
    const doc = createDocument({ name: 'a', width: 16, height: 16, palette: 'pico-8' });
    draw(doc, { layer: L, ops: [{ op: 'rect', x: 4, y: 4, w: 8, h: 12, fill: 9, color: 1 }] });
    addFrames(doc, { count: 3, cels: 'copy' });
    addTag(doc, { name: 'idle', from: 0, to: 3 });
    expect(warnings(doc, ['baseline-drift', 'frame-jitter', 'size-drift'])).toEqual([]);
  });

  it('a circle drawn by the circle op is not reported as jaggy', () => {
    const doc = createDocument({ name: 'a', width: 32, height: 32, palette: 'endesga-32' });
    draw(doc, { layer: L, ops: [{ op: 'circle', cx: 15, cy: 15, r: 12, fill: 'ramp:red:2', color: 1 }] });
    // the engine's own rasteriser output is flagged ("irregular step(s) … 3-1-3"), which teaches agents to distrust lint
    expect(runLint(doc, { rules: ['jaggies'] }).findings).toEqual([]);
  });

  it('shade mode "light" output is not flagged as "doubles" (warning)', () => {
    const doc = createDocument({ name: 'a', width: 32, height: 32, palette: 'endesga-32' });
    draw(doc, { layer: L, ops: [{ op: 'circle', cx: 15, cy: 15, r: 12, fill: 'ramp:red:2' }, { op: 'shade', mode: 'light' }] });
    // shading bands are not 1-px line art; flagging the recommended workflow's output as a warning is a false positive
    expect(warnings(doc, ['doubles'])).toEqual([]);
  });

  it('identical frames do not repeat the same per-frame info finding N times', () => {
    const doc = createDocument({ name: 'a', width: 16, height: 16, palette: 'pico-8' });
    draw(doc, { layer: L, ops: [{ op: 'rect', x: 4, y: 4, w: 8, h: 12, fill: 9, color: 1 }] });
    addFrames(doc, { count: 7, cels: 'link' });
    const f = runLint(doc).findings.filter((x) => x.rule === 'black-outline');
    expect(f.length).toBeLessThanOrEqual(1);
  });
});
