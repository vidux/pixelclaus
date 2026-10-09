/**
 * QA: undo/redo after structural changes and rollback of failing batches (state AND pixels unchanged).
 */
import { describe, expect, it } from 'vitest';
import {
  addFrames,
  addLayer,
  addTag,
  clearCels,
  convertColorMode,
  copyCel,
  cropCanvas,
  createDocument,
  draw,
  duplicateFrame,
  duplicateLayer,
  flatten,
  linkCels,
  loadPreset,
  mergeDown,
  moveCels,
  moveFrame,
  moveLayer,
  removeColors,
  removeFrames,
  removeLayer,
  resizeCanvas,
  reverseFrames,
  scaleSprite,
  select,
  setSlice,
  sortPalette,
  transform,
  trimCanvas,
  tweenOffsets,
  unlinkCels,
  updateLayer,
  type SpriteDocument,
} from '@pixelclaus/core';

/** Deterministic fingerprint of everything a user can observe (metadata + pixels of every cel/mask). */
function fingerprint(doc: SpriteDocument): string {
  const { modified: _m, ...meta } = doc.state;
  const cels = doc.state.cels
    .map((c) => {
      const img = doc.image(c.imageId);
      return `${c.layerId}@${c.frame}:${c.x},${c.y} ${img.width}x${img.height} ${Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength).toString('base64')}`;
    })
    .sort();
  // link structure: which cels share an image (ids themselves may legitimately differ)
  const sorted = [...doc.state.cels].sort((a, b) => a.layerId.localeCompare(b.layerId) || a.frame - b.frame);
  const firstUse = new Map<string, string>();
  for (const c of sorted) if (!firstUse.has(c.imageId)) firstUse.set(c.imageId, `${c.layerId}@${c.frame}`);
  cels.push('links:' + sorted.map((c) => `${c.layerId}@${c.frame}->${firstUse.get(c.imageId)}`).join(','));
  const masks = Object.entries(doc.state.selections).map(([n, id]) => `${n}:${Buffer.from(doc.mask(id).data).toString('base64')}`);
  const clip = Object.entries(doc.state.clipboards).map(([n, c]) => `${n}:${Buffer.from(doc.image(c.imageId).data.buffer).toString('base64')}`);
  // image ids are allowed to differ only if content is identical, so strip them from the metadata
  const metaJson = JSON.stringify(meta, (k, v) => (k === 'imageId' ? undefined : k === 'selections' ? Object.keys(v as object) : k === 'clipboards' ? Object.keys(v as object) : v));
  return [metaJson, ...cels, ...masks, ...clip].join('\n');
}

function seeded(): SpriteDocument {
  const doc = createDocument({ name: 'h', width: 12, height: 8, palette: 'pico-8', layers: ['A', 'B'], frames: 3 });
  draw(doc, {
    layer: 'A',
    ops: [
      { op: 'rect', x: 1, y: 1, w: 6, h: 5, fill: 9, color: 1 },
      { op: 'pixels', points: [[10, 7]], color: 12 },
    ],
  });
  draw(doc, { layer: 'B', frame: 1, ops: [{ op: 'ellipse', x: 4, y: 2, w: 6, h: 5, fill: 12 }] });
  draw(doc, { layer: 'B', frame: 2, ops: [{ op: 'line', from: [0, 0], to: [11, 7], color: 8 }] });
  addTag(doc, { name: 'walk', from: 0, to: 2 });
  setSlice(doc, { name: 'hit', bounds: { x: 1, y: 1, w: 4, h: 4 } });
  select(doc, { shape: 'rect', x: 2, y: 2, w: 3, h: 3 });
  doc.history.clear();
  return doc;
}

const STRUCTURAL: Array<[string, (d: SpriteDocument) => unknown, ((d: SpriteDocument) => unknown)?]> = [
  ['addLayer', (d) => addLayer(d, { name: 'C', below: 'A' })],
  ['removeLayer', (d) => removeLayer(d, 'A')],
  ['duplicateLayer', (d) => duplicateLayer(d, 'B')],
  ['moveLayer', (d) => moveLayer(d, 'A', { above: 'B' })],
  ['updateLayer', (d) => updateLayer(d, 'A', { opacity: 100, blendMode: 'multiply', visible: false })],
  ['mergeDown', (d) => mergeDown(d, 'B')],
  ['flatten', (d) => flatten(d)],
  ['addFrames copy', (d) => addFrames(d, { at: 1, count: 2, cels: 'copy' })],
  ['duplicateFrame link', (d) => duplicateFrame(d, 0, { link: true })],
  ['removeFrames', (d) => removeFrames(d, [0, 2])],
  ['moveFrame', (d) => moveFrame(d, 0, 2)],
  ['reverseFrames', (d) => reverseFrames(d, 0, 2)],
  ['resizeCanvas', (d) => resizeCanvas(d, 20, 5, 'bottom-right')],
  ['cropCanvas', (d) => cropCanvas(d, { x: 2, y: 1, w: 5, h: 5 })],
  ['trimCanvas', (d) => trimCanvas(d, 1)],
  ['scaleSprite 2x', (d) => scaleSprite(d, { factor: 2 })],
  ['scaleSprite scale3x', (d) => scaleSprite(d, { factor: 3, method: 'scale3x' })],
  ['rotate sprite 90 (non-square)', (d) => transform(d, { scope: 'sprite', transform: { op: 'rotate', angle: 90 } })],
  ['rotate layer 30 rotsprite', (d) => transform(d, { scope: 'layer', layer: 'A', transform: { op: 'rotate', angle: 30 } })],
  ['flip selection', (d) => transform(d, { scope: 'selection', layer: 'A', transform: { op: 'flip_v' } }), (d) => select(d, { shape: 'rect', x: 0, y: 0, w: 4, h: 4 })],
  ['scale cel 2x', (d) => transform(d, { scope: 'cel', layer: 'A', transform: { op: 'scale', factor: 2 } })],
  ['offset layer wrap', (d) => transform(d, { scope: 'layer', layer: 'A', transform: { op: 'offset', dx: 5, dy: 3 } })],
  ['linkCels', (d) => linkCels(d, 'B', [0, 1, 2])],
  ['unlinkCels', (d) => unlinkCels(d, 'A', [1]), (d) => linkCels(d, 'A', [0, 1])],
  ['clearCels', (d) => clearCels(d, 'B', [1, 2])],
  ['moveCels', (d) => moveCels(d, 'A', [0], { dx: -3, dy: 2 })],
  ['copyCel', (d) => copyCel(d, { layer: 'A', frame: 0 }, { layer: 'B', frame: 0 })],
  ['tweenOffsets', (d) => tweenOffsets(d, 'A', 0, 2), (d) => {
    copyCel(d, { layer: 'A', frame: 0 }, { layer: 'A', frame: 2 });
    moveCels(d, 'A', [2], { dx: 4 });
  }],
  ['convert to rgba', (d) => convertColorMode(d, 'rgba')],
  ['loadPreset nearest', (d) => loadPreset(d, 'endesga-32', 'nearest')],
  ['sortPalette', (d) => sortPalette(d, 'hue')],
  ['removeColors', (d) => removeColors(d, [9], 1)],
];

describe('undo/redo restores exact state after structural changes', () => {
  for (const [name, op, setup] of STRUCTURAL) {
    it(name, () => {
      const doc = seeded();
      if (setup) {
        setup(doc);
        doc.history.clear();
      }
      const before = fingerprint(doc);
      op(doc);
      const after = fingerprint(doc);
      expect(after, 'op changed something').not.toBe(before);
      const undoSteps = doc.history.undoCount;
      expect(undoSteps).toBeGreaterThan(0);
      doc.undo(undoSteps);
      expect(fingerprint(doc)).toBe(before);
      doc.redo(undoSteps);
      expect(fingerprint(doc)).toBe(after);
      doc.undo(undoSteps);
      expect(fingerprint(doc)).toBe(before);
      // and drawing after undo still works and is undoable
      draw(doc, { layer: doc.state.layers.find((l) => l.type === 'image')!.id, ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
      doc.undo();
      expect(fingerprint(doc)).toBe(before);
    });
  }

  it('long mixed sequence: undo all then redo all', () => {
    const doc = seeded();
    const states = [fingerprint(doc)];
    const seq: Array<(d: SpriteDocument) => unknown> = [
      (d) => addLayer(d, { name: 'C' }),
      (d) => draw(d, { layer: 'C', ops: [{ op: 'rect', x: 0, y: 0, w: 12, h: 8, fill: 3 }] }),
      (d) => resizeCanvas(d, 16, 16, 'center'),
      (d) => draw(d, { layer: 'C', ops: [{ op: 'pixels', points: [[15, 15]], color: 8 }] }),
      (d) => duplicateFrame(d, 1),
      (d) => scaleSprite(d, { factor: 2 }),
      (d) => transform(d, { scope: 'sprite', transform: { op: 'flip_h' } }),
      (d) => mergeDown(d, 'C'),
      (d) => cropCanvas(d, { x: 4, y: 4, w: 20, h: 20 }),
      (d) => removeLayer(d, 'A'),
    ];
    for (const s of seq) {
      s(doc);
      states.push(fingerprint(doc));
    }
    for (let i = seq.length - 1; i >= 0; i--) {
      doc.undo();
      expect(fingerprint(doc), `after undoing step ${i}`).toBe(states[i]);
    }
    for (let i = 1; i <= seq.length; i++) {
      doc.redo();
      expect(fingerprint(doc), `after redoing step ${i}`).toBe(states[i]);
    }
  });
});

describe('replace patches (resize/scale/transform) must not alias the live buffer', () => {
  it('redo of a resize does not resurrect pixels drawn after it (minimal repro)', () => {
    const doc = createDocument({ name: 'r', width: 4, height: 4, palette: 'pico-8' });
    draw(doc, { layer: 'Layer 1', ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] }); // cel exists
    resizeCanvas(doc, 6, 6, 'top-left'); // history stores {before: clone, after: LIVE buffer A}
    const afterResize = fingerprint(doc);
    draw(doc, { layer: 'Layer 1', ops: [{ op: 'pixels', points: [[5, 5]], color: 9 }] }); // mutates A in place
    scaleSprite(doc, { factor: 2 }); // backs up a CLONE of A
    doc.undo(3); // undoing the draw now patches the clone, A keeps the (5,5) pixel
    doc.redo(1); // redo resize → images[id] = A
    expect(fingerprint(doc)).toBe(afterResize);
    const rows = doc.image(doc.state.cels[0]!.imageId);
    expect(rows.get(5, 5)).toBe(0);
  });
});

describe('failing batches roll back completely', () => {
  it('pixels, cel growth, clipboard, palette additions and new cels are all reverted', () => {
    const doc = seeded();
    updateLayer(doc, 'A', {}); // no-op
    doc.history.clear();
    moveCels(doc, 'A', [0], { dx: 2, dy: 2 }); // so drawing at 0,0 must grow the image
    doc.history.clear();
    doc.state.settings.missingColor = 'add';
    const before = fingerprint(doc);
    const rev = doc.revision;
    const imageCount = doc.images.size;
    expect(() =>
      draw(doc, {
        layer: 'A',
        ops: [
          { op: 'pixels', points: [[0, 0]], color: '#123456' }, // adds palette colour + grows cel
          { op: 'copy', name: 'tmp' }, // creates a clipboard image
          { op: 'rect', layer: 'B', frame: 0, x: 0, y: 0, w: 3, h: 3, fill: 2 }, // creates a cel on B@0
          { op: 'fill', x: 5, y: 5, color: 'no-such-colour' }, // fails
        ],
      }),
    ).toThrow(/ops\[3\] \(fill\)/);
    expect(fingerprint(doc)).toBe(before);
    expect(doc.revision).toBe(rev);
    expect(doc.history.undoCount).toBe(0);
    expect(doc.images.size).toBe(imageCount);
    expect(doc.state.palette.colors.length).toBe(17);
  });

  it('failing structural command leaves no trace', () => {
    const doc = seeded();
    const before = fingerprint(doc);
    expect(() => moveLayer(doc, 'A', { parent: 'B' })).toThrow(/not a group/);
    expect(() => removeFrames(doc, [0, 1, 2])).toThrow(/at least one/);
    expect(() => reverseFrames(doc, 2, 1)).toThrow();
    expect(() => scaleSprite(doc, { factor: 1000 })).toThrow(/limit/);
    expect(() => transform(doc, { scope: 'selection', layer: 'A', selection: 'nope', transform: { op: 'flip_h' } })).toThrow(/not found/);
    expect(fingerprint(doc)).toBe(before);
    expect(doc.history.undoCount).toBe(0);
  });

  it('a failing draw on a locked layer mid-batch rolls back earlier ops on other layers', () => {
    const doc = seeded();
    updateLayer(doc, 'B', { locked: true });
    const before = fingerprint(doc);
    expect(() => draw(doc, { ops: [{ op: 'clear', layer: 'A' }, { op: 'clear', layer: 'B' }] })).toThrow(/locked/);
    expect(fingerprint(doc)).toBe(before);
  });
});

describe('history limits', () => {
  it('maxEntries prunes the oldest steps but undo of the remaining ones is exact', () => {
    const doc = createDocument({ name: 'h', width: 4, height: 4, palette: 'pico-8' });
    const small = new (doc.constructor as new (...a: unknown[]) => SpriteDocument)(doc.snapshot(), { maxEntries: 3 });
    const states: string[] = [fingerprint(small)];
    for (let i = 0; i < 6; i++) {
      draw(small, { layer: 'Layer 1', ops: [{ op: 'pixels', points: [[i % 4, Math.floor(i / 4)]], color: i + 2 }] });
      states.push(fingerprint(small));
    }
    expect(small.history.undoCount).toBe(3);
    expect(small.undo(10).length).toBe(3);
    expect(fingerprint(small)).toBe(states[3]);
  });
});
