import { describe, expect, it } from 'vitest';
import {
  addFrames,
  addLayer,
  addTag,
  clearCels,
  compositeFrame,
  copyCel,
  draw,
  duplicateFrame,
  duplicateLayer,
  flatten,
  linkCels,
  mergeDown,
  moveCels,
  moveFrame,
  moveLayer,
  removeFrames,
  removeLayer,
  removeSlice,
  removeTag,
  reverseFrames,
  setCelOpacity,
  setDurations,
  setSlice,
  sliceKeyAt,
  tagPlaybackOrder,
  tweenOffsets,
  unlinkCels,
  updateLayer,
  updateTag,
  walkLayers,
} from '../src/index.js';
import { makeDoc, rows } from './helpers.js';

describe('layers', () => {
  it('adds with positions and unique names', () => {
    const doc = makeDoc();
    const a = addLayer(doc, { name: 'Top' });
    const b = addLayer(doc, { name: 'Mid', below: 'Top' });
    addLayer(doc, { name: 'Top' });
    expect(doc.state.layers.map((l) => l.name)).toEqual(['Layer 1', 'Mid', 'Top', 'Top 2']);
    expect(a.id).toBe('L2');
    expect(b.id).toBe('L3');
  });

  it('groups composite with group opacity', () => {
    const doc = makeDoc();
    const g = addLayer(doc, { type: 'group', name: 'G' });
    const child = addLayer(doc, { name: 'Child', parent: 'G' });
    draw(doc, { layer: child.id, ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    updateLayer(doc, g.id, { opacity: 128 });
    const r = compositeFrame(doc, { frame: 0 });
    expect(r.data[3]).toBe(128);
    const order: string[] = [];
    walkLayers(doc.state, (l, d) => order.push(`${d}:${l.name}`));
    expect(order).toEqual(['0:Layer 1', '0:G', '1:Child']);
  });

  it('hidden layers are skipped', () => {
    const doc = makeDoc();
    draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    updateLayer(doc, 'Layer 1', { visible: false });
    expect(compositeFrame(doc, { frame: 0 }).data[3]).toBe(0);
    expect(compositeFrame(doc, { frame: 0, includeHidden: true }).data[3]).toBe(255);
  });

  it('moves into and out of groups, rejects cycles', () => {
    const doc = makeDoc();
    const g = addLayer(doc, { type: 'group', name: 'G' });
    moveLayer(doc, 'Layer 1', { parent: 'G' });
    expect(doc.state.layers.find((l) => l.name === 'Layer 1')!.parentId).toBe(g.id);
    const g2 = addLayer(doc, { type: 'group', name: 'G2', parent: 'G' });
    expect(() => moveLayer(doc, 'G', { parent: g2.id })).toThrow(/itself/);
    moveLayer(doc, 'Layer 1', { parent: null });
    expect(doc.state.layers.find((l) => l.name === 'Layer 1')!.parentId).toBeNull();
  });

  it('background stays bottom-most', () => {
    const doc = makeDoc({ background: 1 });
    expect(() => moveLayer(doc, 'Background', { index: 1 })).toThrow(/Background/);
    moveLayer(doc, 'Layer 1', { index: 0 });
    expect(doc.state.layers[0]!.name).toBe('Background');
  });

  it('duplicates with cels and preserves links', () => {
    const doc = makeDoc({ frames: 2 });
    draw(doc, { ops: [{ op: 'pixels', points: [[1, 1]], color: 8 }] });
    linkCels(doc, 'Layer 1', [0, 1]);
    const copy = duplicateLayer(doc, 'Layer 1');
    expect(copy.name).toBe('Layer 1 copy');
    const cels = doc.state.cels.filter((c) => c.layerId === copy.id);
    expect(cels.length).toBe(2);
    expect(cels[0]!.imageId).toBe(cels[1]!.imageId);
    expect(cels[0]!.imageId).not.toBe(doc.state.cels[0]!.imageId);
  });

  it('removes groups recursively', () => {
    const doc = makeDoc();
    addLayer(doc, { type: 'group', name: 'G' });
    addLayer(doc, { name: 'C', parent: 'G' });
    expect(removeLayer(doc, 'G').length).toBe(2);
    expect(doc.state.layers.length).toBe(1);
  });

  it('merges down exactly for opaque normal layers', () => {
    const doc = makeDoc({ layers: ['Bottom', 'Top'] });
    draw(doc, { layer: 'Bottom', ops: [{ op: 'rect', x: 0, y: 0, w: 4, h: 1, fill: 1 }] });
    draw(doc, { layer: 'Top', ops: [{ op: 'pixels', points: [[1, 0]], color: 8 }] });
    mergeDown(doc, 'Top');
    expect(doc.state.layers.map((l) => l.name)).toEqual(['Bottom']);
    expect(rows(doc, 'Bottom')[0]).toBe('1811....');
  });

  it('flattens to one layer', () => {
    const doc = makeDoc({ layers: ['A', 'B'], frames: 2 });
    draw(doc, { layer: 'A', ops: [{ op: 'pixels', points: [[0, 0]], color: 1 }] });
    draw(doc, { layer: 'B', frame: 1, ops: [{ op: 'pixels', points: [[1, 0]], color: 2 }] });
    flatten(doc);
    expect(doc.state.layers.length).toBe(1);
    expect(rows(doc, 'Flattened', 1)[0]).toBe('.2......');
    doc.undo();
    expect(doc.state.layers.length).toBe(2);
  });
});

describe('frames', () => {
  it('adds, duplicates (copy/link) and shifts tags', () => {
    const doc = makeDoc({ frames: 3 });
    draw(doc, { frame: 1, ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    addTag(doc, { name: 'walk', from: 1, to: 2 });
    duplicateFrame(doc, 1);
    expect(doc.state.frames.length).toBe(4);
    expect(rows(doc, 'Layer 1', 2)[0]![0]).toBe('8');
    expect(doc.state.tags[0]).toMatchObject({ from: 1, to: 3 });
    duplicateFrame(doc, 1, { link: true });
    const c1 = doc.state.cels.find((c) => c.frame === 1)!;
    const c2 = doc.state.cels.find((c) => c.frame === 2)!;
    expect(c1.imageId).toBe(c2.imageId);
  });

  it('inserts at start', () => {
    const doc = makeDoc({ frames: 2 });
    draw(doc, { frame: 0, ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    addFrames(doc, { at: 0, count: 2, duration: 50 });
    expect(doc.state.frames.map((f) => f.duration)).toEqual([50, 50, 100, 100]);
    expect(rows(doc, 'Layer 1', 2)[0]![0]).toBe('8');
  });

  it('removes frames and fixes tags', () => {
    const doc = makeDoc({ frames: 5 });
    addTag(doc, { name: 'a', from: 1, to: 3 });
    addTag(doc, { name: 'b', from: 4, to: 4 });
    removeFrames(doc, [2, 4]);
    expect(doc.state.frames.length).toBe(3);
    expect(doc.state.tags.map((t) => [t.name, t.from, t.to])).toEqual([['a', 1, 2]]);
    expect(() => removeFrames(doc, [0, 1, 2])).toThrow(/at least one/);
  });

  it('moves and reverses frames', () => {
    const doc = makeDoc({ frames: 3 });
    for (let f = 0; f < 3; f++) draw(doc, { frame: f, ops: [{ op: 'pixels', points: [[f, 0]], color: 8 }] });
    moveFrame(doc, 0, 2);
    expect(rows(doc, 'Layer 1', 2)[0]).toBe('8.......');
    reverseFrames(doc, 0, 2);
    expect(rows(doc, 'Layer 1', 0)[0]).toBe('8.......');
  });

  it('sets durations by ms, fps and list', () => {
    const doc = makeDoc({ frames: 3 });
    setDurations(doc, [0, 1, 2], { fps: 12 });
    expect(doc.state.frames.map((f) => f.duration)).toEqual([83, 83, 83]);
    setDurations(doc, [0, 2], { durations: [200, 50] });
    expect(doc.state.frames.map((f) => f.duration)).toEqual([200, 83, 50]);
    expect(() => setDurations(doc, [0], { duration: 0 })).toThrow();
  });
});

describe('cels', () => {
  it('link / unlink / clear', () => {
    const doc = makeDoc({ frames: 3 });
    draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    linkCels(doc, 'Layer 1', [0, 1, 2]);
    expect(new Set(doc.state.cels.map((c) => c.imageId)).size).toBe(1);
    expect(unlinkCels(doc, 'Layer 1', [1])).toBe(1);
    draw(doc, { frame: 1, ops: [{ op: 'clear' }] });
    expect(rows(doc, 'Layer 1', 0)[0]![0]).toBe('8');
    expect(clearCels(doc, 'Layer 1', [2])).toBe(1);
  });

  it('moves offsets and tweens', () => {
    const doc = makeDoc({ frames: 5 });
    draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    copyCel(doc, { layer: 'Layer 1', frame: 0 }, { layer: 'Layer 1', frame: 4 }, true);
    moveCels(doc, 'Layer 1', [4], { x: 4, y: 0 });
    tweenOffsets(doc, 'Layer 1', 0, 4);
    expect(
      doc.state.cels
        .filter((c) => c.layerId === 'L1')
        .sort((a, b) => a.frame - b.frame)
        .map((c) => c.x),
    ).toEqual([0, 1, 2, 3, 4]);
    expect(rows(doc, 'Layer 1', 2)[0]).toBe('..8.....');
    setCelOpacity(doc, 'Layer 1', [0], 100);
    expect(doc.state.cels.find((c) => c.frame === 0)!.opacity).toBe(100);
  });
});

describe('tags & slices', () => {
  it('tag lifecycle and playback order', () => {
    const doc = makeDoc({ frames: 4 });
    const t = addTag(doc, { name: 'idle', from: 0, to: 3, direction: 'pingpong' });
    expect(tagPlaybackOrder(t)).toEqual([0, 1, 2, 3, 2, 1]);
    expect(() => addTag(doc, { name: 'idle', from: 0, to: 1 })).toThrow(/exists/);
    updateTag(doc, 'idle', { newName: 'breathe', to: 2 });
    expect(doc.state.tags[0]).toMatchObject({ name: 'breathe', to: 2 });
    removeTag(doc, 'breathe');
    expect(doc.state.tags.length).toBe(0);
    expect(() => addTag(doc, { name: 'x', from: 2, to: 1 })).toThrow(/reversed/);
  });

  it('slice keys per frame', () => {
    const doc = makeDoc({ frames: 3 });
    setSlice(doc, { name: 'hit', bounds: { x: 0, y: 0, w: 4, h: 4 }, pivot: { x: 2, y: 3 } });
    setSlice(doc, { name: 'hit', frame: 2, bounds: { x: 1, y: 0, w: 4, h: 4 } });
    const s = doc.state.slices[0]!;
    expect(sliceKeyAt(s, 1)!.bounds.x).toBe(0);
    expect(sliceKeyAt(s, 2)!.bounds.x).toBe(1);
    expect(() =>
      setSlice(doc, { name: 'p', bounds: { x: 0, y: 0, w: 4, h: 4 }, center: { x: 1, y: 1, w: 9, h: 1 } }),
    ).toThrow(/9-patch/);
    removeSlice(doc, 'hit');
    expect(doc.state.slices.length).toBe(0);
  });
});
