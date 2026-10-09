/**
 * QA recheck (D2): randomized model-based undo/redo. A random mix of in-place pixel edits and
 * buffer-replacing ops (resize, scale, crop, trim, rotate, merge, flatten…) interleaved with partial
 * undo/redo; after every step the document must equal the state recorded for that history position.
 */
import { describe, expect, it } from 'vitest';
import {
  addLayer,
  createDocument,
  cropCanvas,
  draw,
  duplicateFrame,
  flatten,
  isPixelClausError,
  linkCels,
  loadPreset,
  mergeDown,
  moveCels,
  removeFrames,
  removeLayer,
  resizeCanvas,
  scaleSprite,
  select,
  sortPalette,
  SpriteDocument,
  transform,
  trimCanvas,
  unlinkCels,
} from '@pixelclaus/core';

function fingerprint(doc: SpriteDocument): string {
  const { modified: _m, ...meta } = doc.state;
  const sorted = [...doc.state.cels].sort((a, b) => a.layerId.localeCompare(b.layerId) || a.frame - b.frame);
  const firstUse = new Map<string, string>();
  for (const c of sorted) if (!firstUse.has(c.imageId)) firstUse.set(c.imageId, `${c.layerId}@${c.frame}`);
  const cels = sorted.map((c) => {
    const img = doc.image(c.imageId);
    return `${c.layerId}@${c.frame}:${c.x},${c.y} ${img.width}x${img.height} ${Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength).toString('base64')} ->${firstUse.get(c.imageId)}`;
  });
  const masks = Object.entries(doc.state.selections).map(([n, id]) => `${n}:${Buffer.from(doc.mask(id).data).toString('base64')}`);
  const clips = Object.entries(doc.state.clipboards).map(([n, c]) => {
    const img = doc.image(c.imageId);
    return `${n}:${img.width}x${img.height}:${Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength).toString('base64')}`;
  });
  const metaJson = JSON.stringify(meta, (k, v) =>
    k === 'imageId' ? undefined : k === 'selections' || k === 'clipboards' ? Object.keys(v as object) : v,
  );
  return [metaJson, ...cels, ...masks, ...clips].join('\n');
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

type Op = (d: SpriteDocument, r: () => number) => unknown;

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const imageLayers = (d: SpriteDocument) => d.state.layers.filter((l) => l.type === 'image');

const OPS: Array<[string, Op]> = [
  ['draw rect', (d, r) => {
    const l = pick(r, imageLayers(d));
    const W = d.state.width;
    const H = d.state.height;
    draw(d, {
      layer: l.id,
      frame: Math.floor(r() * d.state.frames.length),
      ops: [{ op: 'rect', x: Math.floor(r() * W) - 2, y: Math.floor(r() * H) - 2, w: 1 + Math.floor(r() * 6), h: 1 + Math.floor(r() * 6), fill: 1 + Math.floor(r() * 15) }],
    });
  }],
  ['draw pixels', (d, r) => {
    const l = pick(r, imageLayers(d));
    draw(d, {
      layer: l.id,
      ops: [{ op: 'pixels', points: Array.from({ length: 5 }, () => [Math.floor(r() * d.state.width), Math.floor(r() * d.state.height)] as [number, number]), color: 1 + Math.floor(r() * 15) }],
    });
  }],
  ['copy+paste', (d, r) => {
    const l = pick(r, imageLayers(d));
    draw(d, { layer: l.id, ops: [{ op: 'copy', name: 'c', area: { x: 0, y: 0, w: 3, h: 3 } }, { op: 'paste', name: 'c', x: 2, y: 2 }] });
  }],
  ['resize', (d, r) => resizeCanvas(d, 4 + Math.floor(r() * 14), 4 + Math.floor(r() * 14), pick(r, ['center', 'top-left', 'bottom-right'] as const))],
  ['scale 2x', (d) => (d.state.width <= 12 && d.state.height <= 12 ? scaleSprite(d, { factor: 2 }) : cropCanvas(d, { x: 1, y: 1, w: d.state.width - 2, h: d.state.height - 2 }))],
  ['scale2x', (d) => (d.state.width <= 10 && d.state.height <= 10 ? scaleSprite(d, { factor: 2, method: 'scale2x' }) : undefined)],
  ['crop', (d, r) => cropCanvas(d, { x: Math.floor(r() * 3) - 1, y: Math.floor(r() * 3) - 1, w: Math.max(2, d.state.width - 2), h: Math.max(2, d.state.height - 1) })],
  ['trim', (d) => trimCanvas(d, 1)],
  ['rotate sprite 90', (d) => transform(d, { scope: 'sprite', transform: { op: 'rotate', angle: 90 } })],
  ['flip sprite', (d) => transform(d, { scope: 'sprite', transform: { op: 'flip_h' } })],
  ['rotate layer 45', (d, r) => transform(d, { scope: 'layer', layer: pick(r, imageLayers(d)).id, transform: { op: 'rotate', angle: 45 } })],
  ['offset layer', (d, r) => transform(d, { scope: 'layer', layer: pick(r, imageLayers(d)).id, transform: { op: 'offset', dx: 3, dy: -2 } })],
  ['select + flip selection', (d, r) => {
    select(d, { shape: 'rect', x: 0, y: 0, w: 4, h: 4 });
    transform(d, { scope: 'selection', layer: pick(r, imageLayers(d)).id, transform: { op: 'flip_v' } });
  }],
  ['duplicate frame', (d, r) => (d.state.frames.length < 5 ? duplicateFrame(d, Math.floor(r() * d.state.frames.length), { link: r() < 0.5 }) : undefined)],
  ['remove frame', (d) => (d.state.frames.length > 1 ? removeFrames(d, [d.state.frames.length - 1]) : undefined)],
  ['move cel', (d, r) => moveCels(d, pick(r, imageLayers(d)).id, [0], { dx: 2, dy: -1 })],
  ['link cels', (d, r) => (d.state.frames.length > 1 ? linkCels(d, pick(r, imageLayers(d)).id, [0, 1]) : undefined)],
  ['unlink cels', (d, r) => (d.state.frames.length > 1 ? unlinkCels(d, pick(r, imageLayers(d)).id, [1]) : undefined)],
  ['add layer', (d) => (d.state.layers.length < 5 ? addLayer(d, { name: `L${d.state.layers.length}` }) : undefined)],
  ['remove layer', (d, r) => (imageLayers(d).length > 1 ? removeLayer(d, pick(r, imageLayers(d)).id) : undefined)],
  ['merge down', (d) => (imageLayers(d).length > 1 ? mergeDown(d, imageLayers(d).at(-1)!.id) : undefined)],
  ['flatten', (d) => (imageLayers(d).length > 1 ? flatten(d) : undefined)],
  ['sort palette', (d) => sortPalette(d, 'hue')],
  ['palette swap', (d) => loadPreset(d, 'sweetie-16', 'index')],
];

function runModel(seed: number, steps: number): void {
  const r = rng(seed);
  const doc = createDocument({ name: 'm', width: 10, height: 8, palette: 'pico-8', layers: ['A', 'B'], frames: 2 });
  draw(doc, { layer: 'A', ops: [{ op: 'rect', x: 1, y: 1, w: 6, h: 5, fill: 9, color: 1 }] });
  draw(doc, { layer: 'B', frame: 1, ops: [{ op: 'ellipse', x: 3, y: 2, w: 6, h: 5, fill: 12 }] });
  doc.history.clear();
  // states[i] = document after i undoable steps; pos = current position
  const states: string[] = [fingerprint(doc)];
  let pos = 0;
  const log: string[] = [];
  for (let step = 0; step < steps; step++) {
    const roll = r();
    if (roll < 0.2 && pos > 0) {
      const k = 1 + Math.floor(r() * Math.min(3, pos));
      expect(doc.undo(k).length).toBe(k);
      pos -= k;
      log.push(`undo ${k}`);
    } else if (roll < 0.35 && pos < states.length - 1) {
      const k = 1 + Math.floor(r() * Math.min(3, states.length - 1 - pos));
      expect(doc.redo(k).length).toBe(k);
      pos += k;
      log.push(`redo ${k}`);
    } else {
      const [name, op] = pick(r, OPS);
      const before = doc.history.undoCount;
      try {
        op(doc, r);
      } catch (e) {
        if (!isPixelClausError(e)) throw e;
        expect(fingerprint(doc), `failed ${name} left traces (seed ${seed}, ${log.join(' · ')})`).toBe(states[pos]);
        log.push(`${name} (rejected)`);
        continue;
      }
      const added = doc.history.undoCount - before;
      if (added === 0) {
        log.push(`${name} (no-op)`);
        continue;
      }
      // compound ops (select + transform) add several steps: capture each intermediate state
      const finalFp = fingerprint(doc);
      const inter: string[] = [];
      for (let j = 1; j < added; j++) {
        doc.undo(1);
        inter.unshift(fingerprint(doc));
      }
      if (added > 1) doc.redo(added - 1);
      expect(fingerprint(doc), `${name}: redo after capturing intermediate states`).toBe(finalFp);
      states.length = pos + 1;
      states.push(...inter, finalFp);
      pos += added;
      log.push(name);
    }
    expect(fingerprint(doc), `seed ${seed} step ${step}: ${log.slice(-6).join(' · ')}`).toBe(states[pos]);
  }
  // the walk must actually have exercised the ops (not just rejected them)
  expect(log.filter((l) => !/rejected|no-op|undo|redo/.test(l)).length, log.join(' · ')).toBeGreaterThan(60);
  expect(log.filter((l) => /^undo/.test(l)).length).toBeGreaterThan(10);
  // full unwind and replay
  doc.undo(pos);
  expect(fingerprint(doc), `seed ${seed}: undo to the start`).toBe(states[0]);
  doc.redo(states.length - 1);
  expect(fingerprint(doc), `seed ${seed}: redo to the end`).toBe(states.at(-1));
}

describe('D2 recheck: randomized undo/redo model', () => {
  for (const seed of [1, 7, 42, 1234, 99991, 31337]) {
    it(`seed ${seed}: 150 random steps keep undo/redo exact`, () => runModel(seed, 150));
  }
});

describe('D2 recheck: replace patches survive memory-limit pruning and snapshots', () => {
  it('pruned history (maxBytes) still undoes the remaining replace patches exactly', () => {
    const base = createDocument({ name: 'p', width: 16, height: 16, palette: 'pico-8' });
    draw(base, { layer: 'Layer 1', ops: [{ op: 'rect', x: 0, y: 0, w: 16, h: 16, fill: 8 }] });
    const doc = new SpriteDocument(base.snapshot(), { maxBytes: 20000 });
    const states = [fingerprint(doc)];
    for (let i = 0; i < 8; i++) {
      resizeCanvas(doc, 16 + (i % 2 ? -1 : 1), 16 + (i % 2 ? -1 : 1), 'top-left');
      states.push(fingerprint(doc));
      draw(doc, { layer: 'Layer 1', ops: [{ op: 'pixels', points: [[i, i]], color: i % 2 ? 2 : 3 }] });
      states.push(fingerprint(doc));
    }
    const n = doc.history.undoCount;
    expect(n).toBeLessThan(16); // pruning happened
    doc.undo(n);
    // every remaining step undid cleanly to exactly the state recorded n steps back
    expect(fingerprint(doc)).toBe(states[states.length - 1 - n]);
    doc.redo(n);
    expect(fingerprint(doc)).toBe(states.at(-1));
  });

  it('snapshot() taken mid-history is not mutated by later undo/redo', () => {
    const doc = createDocument({ name: 's', width: 6, height: 6, palette: 'pico-8' });
    draw(doc, { layer: 'Layer 1', ops: [{ op: 'pixels', points: [[1, 1]], color: 8 }] });
    resizeCanvas(doc, 8, 8, 'top-left');
    const snap = doc.snapshot();
    const copy = new SpriteDocument(snap);
    const fp = fingerprint(copy);
    draw(doc, { layer: 'Layer 1', ops: [{ op: 'pixels', points: [[7, 7]], color: 9 }] });
    doc.undo(3);
    doc.redo(2);
    expect(fingerprint(copy)).toBe(fp);
  });
});
