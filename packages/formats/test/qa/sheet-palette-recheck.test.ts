/**
 * QA recheck (D10 + palette-file minors).
 * - Sprite sheets: every cell, cut out of the sheet with its JSON rect and placed at spriteSourceSize,
 *   must reproduce the original frame exactly — across layouts, trim, extrude, padding, scale, split layers
 *   and duplicate merging (a merged cell must never show another frame's pixels or size).
 * - Palette files: corrupt / odd inputs give clean errors or sane results.
 */
import { describe, expect, it } from 'vitest';
import {
  addLayer,
  compositeFrame,
  createDocument,
  draw,
  duplicateFrame,
  isPixelClausError,
  type SpriteDocument,
} from '@pixelclaus/core';
import { buildSpriteSheet, readPalette, writePalette, type SpriteSheetOptions } from '@pixelclaus/formats';

function sprite(): SpriteDocument {
  const doc = createDocument({ name: 'hero', width: 10, height: 8, palette: 'pico-8', layers: ['Body', 'Hat'], frames: 1 });
  // frame 0: 2x3 block; frame 1: 3x2 block with the same bytes; frame 2: duplicate of 0 shifted;
  // frame 3: exact duplicate of frame 0; frame 4: empty
  draw(doc, { layer: 'Body', ops: [{ op: 'rect', x: 1, y: 1, w: 2, h: 3, fill: 9 }] });
  duplicateFrame(doc, 0, { count: 4 });
  draw(doc, { layer: 'Body', frame: 1, ops: [{ op: 'clear' }, { op: 'rect', x: 1, y: 1, w: 3, h: 2, fill: 9 }] });
  draw(doc, { layer: 'Body', frame: 2, ops: [{ op: 'clear' }, { op: 'rect', x: 5, y: 4, w: 2, h: 3, fill: 9 }] });
  draw(doc, { layer: 'Body', frame: 4, ops: [{ op: 'clear' }] });
  draw(doc, { layer: 'Hat', frame: 0, ops: [{ op: 'pixels', points: [[1, 0], [2, 0]], color: 12 }] });
  draw(doc, { layer: 'Hat', frame: 3, ops: [{ op: 'pixels', points: [[1, 0], [2, 0]], color: 12 }] });
  addLayer(doc, { name: 'Empty' });
  return doc;
}

function checkSheet(doc: SpriteDocument, opts: SpriteSheetOptions): void {
  const label = JSON.stringify(opts);
  const sheet = buildSpriteSheet(doc, { ...opts, json: 'aseprite-array' });
  const s = opts.scale ?? 1;
  const frames = (sheet.json as { frames: Array<{ filename: string; frame: { x: number; y: number; w: number; h: number }; spriteSourceSize: { x: number; y: number; w: number; h: number }; sourceSize: { w: number; h: number } }> }).frames;
  expect(frames.length, label).toBe(sheet.cells.length);
  sheet.cells.forEach((cell, i) => {
    const f = frames[i]!;
    const where = `${label} cell ${cell.name}`;
    for (const v of [f.frame.x, f.frame.y, f.frame.w, f.frame.h]) expect(Number.isInteger(v), where).toBe(true);
    expect(f.frame.x + f.frame.w, where).toBeLessThanOrEqual(sheet.raster.width);
    expect(f.frame.y + f.frame.h, where).toBeLessThanOrEqual(sheet.raster.height);
    expect([f.frame.w, f.frame.h], where).toEqual([f.spriteSourceSize.w, f.spriteSourceSize.h]);
    let src = compositeFrame(doc, {
      frame: cell.frame,
      isolate: cell.layer ? [doc.state.layers.find((l) => l.name === cell.layer)!.id] : undefined,
      includeReference: false,
    });
    if (s > 1) src = src.scaled(s);
    expect([f.sourceSize.w, f.sourceSize.h], where).toEqual([src.width, src.height]);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const inside =
          x >= f.spriteSourceSize.x && y >= f.spriteSourceSize.y && x < f.spriteSourceSize.x + f.frame.w && y < f.spriteSourceSize.y + f.frame.h;
        const want = src.get(x, y);
        const got = inside ? sheet.raster.get(f.frame.x + x - f.spriteSourceSize.x, f.frame.y + y - f.spriteSourceSize.y) : 0;
        if (got !== want) throw new Error(`${where}: pixel (${x},${y}) is ${got.toString(16)} but the frame has ${want.toString(16)}`);
      }
    }
  });
}

describe('D10 recheck: sheets reproduce every frame exactly', () => {
  const layouts = ['horizontal', 'vertical', 'grid', 'rows', 'packed'] as const;
  for (const layout of layouts) {
    for (const trim of [false, true]) {
      it(`${layout}${trim ? ' trimmed' : ''}: merged, extruded, padded, scaled, split-layer variants`, () => {
        const doc = sprite();
        for (const opts of [
          { layout, trim },
          { layout, trim, mergeDuplicates: false },
          { layout, trim, extrude: 2, padding: 1, border: 3 },
          { layout, trim, scale: 3, padding: 2 },
          { layout, trim, splitLayers: true },
          { layout, trim, splitLayers: true, includeHidden: true, extrude: 1 },
          { layout, trim, powerOfTwo: true, columns: 2 },
        ] satisfies SpriteSheetOptions[])
          checkSheet(doc, opts);
      });
    }
  }

  it('merging actually happens for identical frames and never for same-bytes different-shape frames', () => {
    const doc = sprite();
    const sheet = buildSpriteSheet(doc, { trim: true, json: 'none' });
    const byFrame = new Map(sheet.cells.map((c) => [c.frame, c]));
    expect(byFrame.get(3)!.duplicateOf).toBeDefined(); // frame 3 == frame 0
    expect(byFrame.get(1)!.duplicateOf).toBeUndefined(); // 3x2 vs 2x3, same bytes
    expect(byFrame.get(2)!.duplicateOf).toBeUndefined(); // same trimmed pixels at another offset
  });
});

describe('palette files: odd inputs', () => {
  it('R6: a .act whose count field exceeds 256 yields a clean error or ≤256 colours (not a JS TypeError)', () => {
    const act = new Uint8Array(772);
    act.set([255, 0, 0, 0, 255, 0], 0);
    act[768] = 2; // count 512 — corrupt
    act[769] = 0;
    let colors: string[] | null = null;
    try {
      colors = readPalette(act, 'bad.act').colors;
    } catch (e) {
      expect(isPixelClausError(e), `threw ${String(e)}`).toBe(true);
    }
    if (colors) {
      expect(colors.length).toBeLessThanOrEqual(256);
      for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('round trip of every format keeps colours (regression guard)', () => {
    const colors = ['#000000', '#ff0000', '#00ff00', '#123456', '#abcdef'];
    for (const fmt of ['hex', 'gpl', 'pal', 'act'] as const) {
      const back = readPalette(writePalette({ name: 'x', colors }, fmt), `x.${fmt}`);
      expect(back.colors, fmt).toEqual(colors);
    }
  });
});
