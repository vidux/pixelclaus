import { describe, expect, it } from 'vitest';
import { draw, PixelClausError, summarizeDocument } from '../src/index.js';
import { makeDoc, rows } from './helpers.js';

describe('document & history', () => {
  it('creates with defaults', () => {
    const doc = makeDoc();
    expect(doc.state.colorMode).toBe('indexed');
    expect(doc.state.palette.colors[0]).toBe('#00000000');
    expect(doc.state.palette.colors.length).toBe(17);
    expect(doc.state.layers.map((l) => l.name)).toEqual(['Layer 1']);
    expect(summarizeDocument(doc).frameCount).toBe(1);
  });

  it('creates a background layer', () => {
    const doc = makeDoc({ background: 7 });
    expect(doc.state.layers[0]!.isBackground).toBe(true);
    expect(rows(doc, 'Background')[0]).toBe('77777777');
  });

  it('undo / redo pixel edits', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'pixels', points: [[1, 1]], color: 8 }] });
    expect(rows(doc, 'Layer 1')[1]).toBe('.8......');
    expect(doc.history.undoCount).toBe(1);
    doc.undo();
    expect(rows(doc, 'Layer 1')[1]).toBe('........');
    doc.redo();
    expect(rows(doc, 'Layer 1')[1]).toBe('.8......');
  });

  it('batch is one undo step', () => {
    const doc = makeDoc();
    draw(doc, {
      ops: [
        { op: 'pixels', points: [[0, 0]], color: 8 },
        { op: 'pixels', points: [[1, 0]], color: 9 },
      ],
    });
    expect(doc.history.undoCount).toBe(1);
    doc.undo();
    expect(rows(doc, 'Layer 1')[0]).toBe('........');
  });

  it('rolls back the whole batch on error', () => {
    const doc = makeDoc();
    expect(() =>
      draw(doc, {
        ops: [
          { op: 'pixels', points: [[0, 0]], color: 8 },
          { op: 'pixels', points: [[1, 0]], color: 99 },
        ],
      }),
    ).toThrow(PixelClausError);
    expect(rows(doc, 'Layer 1')[0]).toBe('........');
    expect(doc.history.undoCount).toBe(0);
    expect(doc.state.cels.length).toBe(0);
  });

  it('error messages carry op index and hints', () => {
    const doc = makeDoc();
    try {
      draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 99 }] });
    } catch (e) {
      expect((e as PixelClausError).message).toMatch(/ops\[0\]/);
      expect((e as PixelClausError).hint).toMatch(/0\.\.16/);
    }
  });

  it('tracks dirty images and meta', () => {
    const doc = makeDoc();
    doc.takeDirty();
    draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    const d = doc.takeDirty();
    expect(d.meta).toBe(true);
    expect(d.images.size).toBe(1);
  });

  it('no-op transaction does not create history', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    expect(doc.history.undoCount).toBe(1);
  });

  it('snapshot / replaceWith restores content', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    const snap = doc.snapshot();
    draw(doc, { ops: [{ op: 'clear' }] });
    doc.replaceWith(snap);
    expect(rows(doc, 'Layer 1')[0]).toBe('8.......');
    expect(doc.history.undoCount).toBe(0);
  });

  it('change events fire', () => {
    const doc = makeDoc();
    const seen: string[] = [];
    doc.onChange((e) => seen.push(e.kind));
    draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    doc.undo();
    doc.redo();
    expect(seen).toEqual(['commit', 'undo', 'redo']);
  });
});
