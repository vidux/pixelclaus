import { describe, expect, it } from 'vitest';
import { addFrames, diffFrames, draw, runLint, updateProject } from '../src/index.js';
import { makeDoc } from './helpers.js';

describe('diffFrames', () => {
  it('counts added/removed/recoloured pixels and finds the whole-image shift', () => {
    const doc = makeDoc({ width: 16, height: 16, frames: 2 });
    draw(doc, { ops: [{ op: 'rect', x: 2, y: 2, w: 5, h: 5, fill: 9, color: 1 }] });
    draw(doc, { frame: 1, ops: [{ op: 'rect', x: 4, y: 3, w: 5, h: 5, fill: 9, color: 1 }] });
    const d = diffFrames(doc, 0, 1);
    expect(d.changed).toBeGreaterThan(0);
    expect(d.added).toBeGreaterThan(0);
    expect(d.removed).toBeGreaterThan(0);
    expect(d.bestShift).toMatchObject({ dx: 2, dy: 1, residual: 0 });
    expect(d.unshiftedResidual).toBeGreaterThan(0);
    expect(d.bbox).not.toBeNull();
    expect(d.map).toMatch(/\+/);
    expect(d.map).toMatch(/-/);
  });

  it('identical frames report no change and no map', () => {
    const doc = makeDoc({ width: 8, height: 8 });
    draw(doc, { ops: [{ op: 'pixels', points: [[3, 3]], color: 8 }] });
    addFrames(doc, { count: 1, cels: 'copy' });
    const d = diffFrames(doc, 0, 1);
    expect(d.changed).toBe(0);
    expect(d.bbox).toBeNull();
    expect(d.map).toBeNull();
  });

  it('rejects frames that do not exist', () => {
    const doc = makeDoc();
    expect(() => diffFrames(doc, 0, 5)).toThrow(/frame/i);
  });
});

describe('newer lint rules', () => {
  it('background-contrast flags a sprite edge that matches the preview background', () => {
    const doc = makeDoc({ width: 16, height: 16 });
    // pico-8 index 1 = #000000 (PixelClaus 1 = preset 0); dark sprite on a near-black background
    draw(doc, { ops: [{ op: 'ellipse', x: 2, y: 2, w: 12, h: 12, fill: 2, color: 1 }] });
    updateProject(doc, { settings: { previewBackground: '#050505' } });
    const r = runLint(doc, { rules: ['background-contrast'] });
    expect(r.findings.map((f) => f.rule)).toContain('background-contrast');
    updateProject(doc, { settings: { previewBackground: '#fff1e8' } });
    expect(runLint(doc, { rules: ['background-contrast'] }).findings).toHaveLength(0);
  });

  it('detail-density flags noisy interiors but not flat clusters', () => {
    const doc = makeDoc({ width: 16, height: 16 });
    draw(doc, { ops: [{ op: 'rect', x: 0, y: 0, w: 16, h: 16, fill: 9 }] });
    expect(runLint(doc, { rules: ['detail-density'] }).findings).toHaveLength(0);
    draw(doc, { ops: [{ op: 'pattern', pattern: 'checker', colors: [9, 12] }] });
    expect(runLint(doc, { rules: ['detail-density'] }).findings.map((f) => f.rule)).toContain(
      'detail-density',
    );
  });

  it('identical findings on several frames are merged with a frames list', () => {
    const doc = makeDoc({ width: 8, height: 8 });
    draw(doc, { ops: [{ op: 'pixels', points: [[3, 3]], color: 8 }] });
    addFrames(doc, { count: 2, cels: 'copy' });
    const stray = runLint(doc, { rules: ['stray-pixels'] }).findings.filter((f) => f.rule === 'stray-pixels');
    expect(stray).toHaveLength(1);
    expect(stray[0]!.frames).toEqual([0, 1, 2]);
  });
});
