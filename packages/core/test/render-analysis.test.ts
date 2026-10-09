import { describe, expect, it } from 'vitest';
import {
  addFrames,
  addTag,
  animationMetrics,
  buildPreview,
  createDocument,
  draw,
  FONT_3X5,
  FONT_5X7,
  generateRamp,
  hueDelta,
  measureText,
  moveCels,
  packedToOklch,
  parseHex,
  Raster,
  pack,
  readPixels,
  renderView,
  runLint,
  setPalette,
  VIEW_MODES,
  spriteStats,
  paletteReport,
  summarizeDocument,
} from '../src/index.js';
import { makeDoc, rows } from './helpers.js';

describe('render views', () => {
  it('every view renders a sane raster with info', () => {
    const doc = makeDoc({ width: 12, height: 10, frames: 3 });
    draw(doc, { ops: [{ op: 'rect', x: 2, y: 2, w: 6, h: 6, fill: 9, color: 1 }] });
    addTag(doc, { name: 'loop', from: 0, to: 2, direction: 'pingpong' });
    for (const view of VIEW_MODES) {
      const { raster, info } = renderView(doc, {
        view,
        frame: 1,
        tag: view === 'filmstrip' ? 'loop' : undefined,
      });
      expect(raster.width, view).toBeGreaterThan(40);
      expect(raster.width, view).toBeLessThanOrEqual(2200);
      expect(info.view ?? info.frameA, view).toBeDefined();
    }
    const fs = renderView(doc, { view: 'filmstrip', tag: 'loop' });
    expect(fs.info.order).toEqual([0, 1, 2, 1]);
  });

  it('auto scale targets ~640px and region keeps absolute rulers', () => {
    const doc = makeDoc({ width: 32, height: 32 });
    const full = renderView(doc, {});
    expect(full.info.scale).toBe(20);
    const zoom = renderView(doc, { region: { x: 8, y: 8, w: 8, h: 8 } });
    expect(zoom.info.scale).toBe(64); // capped at 64x
  });

  it('preview with labels draws index text', () => {
    const r = Raster.filled(2, 2, pack(255, 0, 0));
    const plain = buildPreview(r, { scale: 30, inset: false, rulers: false });
    const labelled = buildPreview(r, { scale: 30, inset: false, rulers: false, label: () => '7' });
    expect([...plain.data]).not.toEqual([...labelled.data]);
  });

  it('fonts measure correctly', () => {
    expect(measureText(FONT_3X5, 'AB')).toEqual({ width: 7, height: 5 });
    expect(measureText(FONT_5X7, 'a\nbc')).toEqual({ width: 11, height: 15 });
  });
});

describe('ascii readback', () => {
  it('round-trips a sprite through read_pixels and the grid op', () => {
    const doc = makeDoc({ width: 6, height: 3 });
    draw(doc, { ops: [{ op: 'grid', rows: ['.1234.', '5*6', 'abcdef'] }] });
    const text = readPixels(doc, { layer: 'Layer 1' }).text;
    const doc2 = makeDoc({ width: 6, height: 3 });
    draw(doc2, { ops: [{ op: 'grid', rows: text }] });
    expect(rows(doc2, 'Layer 1')).toEqual(rows(doc, 'Layer 1'));
  });

  it('uses [n] tokens for indices beyond the alphabet and unambiguous RLE', () => {
    const doc = createDocument({ name: 'big', width: 70, height: 1, palette: 'resurrect-64' });
    draw(doc, {
      ops: [
        {
          op: 'pixels',
          points: Array.from({ length: 64 }, (_, i) => [i, 0, i + 1] as [number, number, number]),
        },
      ],
    });
    const r = readPixels(doc, { layer: 'Layer 1', rowNumbers: false, header: false });
    expect(r.legend['[58]']).toMatch(/index 58/);
    expect(r.text).toContain('[63]');
    const doc2 = createDocument({ name: 'big2', width: 70, height: 1, palette: 'resurrect-64' });
    draw(doc2, { ops: [{ op: 'grid', rows: [r.text], legend: r.legendInput }] });
    expect(readPixels(doc2, { layer: 'Layer 1' }).text).toBe(readPixels(doc, { layer: 'Layer 1' }).text);
    const rle = readPixels(makeDoc(), { rle: 4, rowNumbers: false, header: false });
    expect(rle.text.split('\n')[0]).toBe('.*8');
    const mixed = makeDoc({ width: 4, height: 1 });
    draw(mixed, { ops: [{ op: 'grid', rows: ['2223'] }] });
    expect(readPixels(mixed, { rle: 3, rowNumbers: false, header: false }).text).toBe('2*3 3');
  });

  it('refuses huge regions with a hint', () => {
    const doc = createDocument({ name: 'huge', width: 256, height: 256 });
    expect(() => readPixels(doc)).toThrow(/too large/);
  });
});

describe('lint', () => {
  it('flags stray pixels, doubles, budget and semi-transparency', () => {
    const doc = makeDoc({ width: 16, height: 16, colorMode: 'rgba', settings: { paletteLock: false } });
    draw(doc, {
      ops: [
        { op: 'pixels', points: [[0, 0]], color: '#ffffff' },
        {
          op: 'path',
          points: [
            [4, 4],
            [5, 4],
            [5, 5],
            [6, 5],
            [6, 6],
          ],
          color: '#000000',
          pixelPerfect: false,
        },
        { op: 'pixels', points: [[10, 10]], color: '#12345680' },
      ],
    });
    const rep = runLint(doc);
    const rules = rep.findings.map((f) => f.rule);
    expect(rules).toContain('stray-pixels');
    expect(rules).toContain('doubles');
    expect(rules).toContain('semi-transparent');
    expect(rules).toContain('off-palette');
    expect(rep.findings.find((f) => f.rule === 'stray-pixels')!.pixels).toContainEqual({ x: 0, y: 0 });
  });

  it('detects pillow shading and accepts directional shading', () => {
    const doc = createDocument({ name: 'p', width: 20, height: 20, palette: 'grayscale-8' });
    draw(doc, {
      ops: [
        { op: 'circle', cx: 10, cy: 10, r: 9, fill: 2 },
        { op: 'circle', cx: 10, cy: 10, r: 6, fill: 4 },
        { op: 'circle', cx: 10, cy: 10, r: 3, fill: 7 },
      ],
    });
    expect(runLint(doc, { rules: ['pillow-shading'] }).findings.length).toBe(1);
    const ok = createDocument({ name: 'q', width: 20, height: 20, palette: 'grayscale-8' });
    draw(ok, {
      ops: [
        { op: 'circle', cx: 10, cy: 10, r: 9, fill: 4 },
        { op: 'circle', cx: 7, cy: 7, r: 3, fill: 7 },
      ],
    });
    expect(runLint(ok, { rules: ['pillow-shading'] }).findings.length).toBe(0);
  });

  it('animation rules: baseline drift and size drift', () => {
    const doc = makeDoc({ width: 16, height: 16 });
    draw(doc, { ops: [{ op: 'rect', x: 4, y: 4, w: 6, h: 8, fill: 9 }] });
    addFrames(doc, { count: 3, cels: 'copy' });
    moveCels(doc, 'Layer 1', [2], { dy: -2 });
    addTag(doc, { name: 'walk', from: 0, to: 3 });
    const rep = runLint(doc, { rules: ['baseline-drift'] });
    expect(rep.findings[0]?.message).toMatch(/9\.\.11/);
    const m = animationMetrics(doc, { tag: 'walk' });
    expect(m.frames.map((f) => f.bottom)).toEqual([11, 11, 9, 11]);
    expect(m.frames[2]!.changed).toBeGreaterThan(0);
  });

  it('opt-in rules: tile seams and symmetry', () => {
    const doc = makeDoc({ width: 8, height: 8 });
    draw(doc, {
      ops: [
        { op: 'rect', x: 0, y: 0, w: 4, h: 8, fill: 1 },
        { op: 'rect', x: 4, y: 0, w: 4, h: 8, fill: 8 },
      ],
    });
    const rep = runLint(doc, { rules: ['tile-seams', 'symmetry'] });
    expect(rep.findings.map((f) => f.rule).sort()).toEqual(['symmetry', 'tile-seams']);
  });

  it('palette rules: near duplicates, unused, ramp contrast', () => {
    const doc = makeDoc();
    setPalette(doc, ['#808080', '#818181', '#000000', '#ffffff'], { strategy: 'nearest' });
    draw(doc, {
      ops: [
        {
          op: 'pixels',
          points: [
            [0, 0, 1],
            [1, 0, 2],
          ],
        },
      ],
    });
    doc.state.palette.ramps = [{ name: 'flat', indices: [1, 2] }];
    const rep = runLint(doc, { rules: ['near-duplicate-colors', 'unused-palette', 'ramp-contrast'] });
    expect(rep.findings.map((f) => f.rule).sort()).toEqual([
      'near-duplicate-colors',
      'ramp-contrast',
      'unused-palette',
    ]);
  });
});

describe('ramps & stats', () => {
  it('generated ramps shift hue toward cool shadows and warm highlights', () => {
    const base = parseHex('#3a9d5c')!;
    const ramp = generateRamp(base, { steps: 5 });
    const h = ramp.map((c) => packedToOklch(c).h);
    const baseH = h[2]!;
    expect(Math.abs(hueDelta(h[0]!, 260))).toBeLessThan(Math.abs(hueDelta(baseH, 260)));
    expect(Math.abs(hueDelta(h[4]!, 70))).toBeLessThan(Math.abs(hueDelta(baseH, 70)));
  });

  it('stats, palette report and summary', () => {
    const doc = makeDoc({ frames: 2 });
    draw(doc, { ops: [{ op: 'rect', x: 0, y: 0, w: 2, h: 2, fill: 9 }] });
    const s = spriteStats(doc);
    expect(s.usage[0]).toMatchObject({ index: 9, count: 4 });
    expect(paletteReport(doc).unused).not.toContain(9);
    expect(summarizeDocument(doc).layers[0]!.celFrames).toEqual([0]);
  });
});
