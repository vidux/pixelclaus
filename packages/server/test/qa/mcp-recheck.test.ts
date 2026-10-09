/**
 * QA recheck: the MCP server end-to-end through the SDK in-memory client, used the way an agent would.
 * Builds a 32x32 character with layers, a 4-frame walk with tags, looks at every view, analyses, exports
 * every format and re-imports .aseprite/.pxc. Every call is held to the agent budget:
 * < 1 s on a small sprite, text reply ≤ 3 KB, images ≤ 1024 px.
 * Then: D8/D9 sweeps and the defects found in this pass (R13, R16–R19).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import sharp from 'sharp';
import { mcpClient, type TestClient } from '../helpers.js';

let t: TestClient;
const P = 'hero';
const budget: string[] = [];

interface Res {
  text: string;
  images: string[];
  isError: boolean;
  ms: number;
}

function pngSize(b64: string): { w: number; h: number } {
  const buf = Buffer.from(b64, 'base64');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

async function call(name: string, args: Record<string, unknown> = {}, check = true): Promise<Res> {
  const t0 = performance.now();
  let r: Res;
  try {
    const x = await t.call(name, args);
    r = { text: x.text, images: x.images, isError: x.isError, ms: performance.now() - t0 };
  } catch (e) {
    r = { text: String(e), images: [], isError: true, ms: performance.now() - t0 };
  }
  if (check) {
    const tag = `${name} ${JSON.stringify(args).slice(0, 90)}`;
    if (r.ms > 1000) budget.push(`${tag}: ${Math.round(r.ms)} ms`);
    if (r.text.length > 3072) budget.push(`${tag}: ${r.text.length} B of text`);
    for (const img of r.images) {
      const { w, h } = pngSize(img);
      if (w > 1024 || h > 1024) budget.push(`${tag}: image ${w}x${h}`);
    }
  }
  return r;
}

const exported: Record<string, string[]> = {};
async function exportFormat(format: string, extra: Record<string, unknown> = {}): Promise<string[]> {
  const r = await call('export', { project: P, format, ...extra });
  expect(r.isError, r.text).toBe(false);
  const paths = [...r.text.matchAll(/^- (\S+) \(/gm)].map((m) => m[1]!);
  expect(paths.length, r.text).toBeGreaterThan(0);
  for (const p of paths) expect(existsSync(p), p).toBe(true);
  exported[format] = paths;
  return paths;
}

beforeAll(async () => {
  t = await mcpClient();
});
afterAll(async () => t.close());

describe('agent workflow: 32x32 character, 4-frame walk', () => {
  it('creates the project with layers', async () => {
    const r = await call('project_create', { name: 'Hero', width: 32, height: 32, palette: 'endesga-32', layers: ['Body', 'Outline', 'Shade'] });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/id=hero 32x32/);
  });

  it('blocks in flats with ellipse, rect, grid and fill', async () => {
    const r = await call('draw', {
      project: P,
      layer: 'Body',
      ops: [
        { op: 'ellipse', x: 10, y: 3, w: 12, h: 11, fill: 'ramp:skin:2' },
        { op: 'rect', x: 11, y: 14, w: 10, h: 10, fill: 8 },
        { op: 'rect', x: 11, y: 24, w: 4, h: 6, fill: 9 },
        { op: 'rect', x: 17, y: 24, w: 4, h: 6, fill: 9 },
        { op: 'grid', x: 13, y: 7, rows: ['1..1', '....', '.11.'], mode: 'overlay' },
        { op: 'fill', x: 15, y: 18, color: 10 },
      ],
      preview: true,
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/6 op\(s\) · \d+ px changed/);
    expect(r.images).toHaveLength(1);
  });

  it('outline outside from the composite on its own layer, inner edge, selout and light shading', async () => {
    const o = await call('draw', { project: P, layer: 'Outline', ops: [{ op: 'outline', color: 26, source: 'composite' }] });
    expect(o.text).toMatch(/traced composite/);
    expect(Number(/(\d+) px changed/.exec(o.text)![1])).toBeGreaterThan(60);
    const inside = await call('draw', { project: P, layer: 'Body', ops: [{ op: 'outline', color: 2, side: 'inside', connectivity: 8 }] });
    expect(Number(/(\d+) px changed/.exec(inside.text)![1])).toBeGreaterThan(0);
    const sel = await call('draw', { project: P, layer: 'Outline', ops: [{ op: 'selout', source: 'composite', light: 'top-left' }] });
    expect(sel.isError, sel.text).toBe(false);
    const sh = await call('draw', { project: P, layer: 'Body', ops: [{ op: 'shade', mode: 'light', light: 'top-left' }] });
    expect(Number(/(\d+) px changed/.exec(sh.text)![1])).toBeGreaterThan(0);
    // shading an empty layer explains itself instead of reporting a bare success
    const empty = await call('draw', { project: P, layer: 'Shade', ops: [{ op: 'shade', mode: 'light' }] });
    expect(empty.text).toMatch(/no pixels changed/);
  });

  it('reads pixels back exactly (composite with RLE, layer region)', async () => {
    const a = await call('read_pixels', { project: P, rle: 3 });
    expect(a.text).toMatch(/composite · frame 0 · region 0,0 32x32/);
    const b = await call('read_pixels', { project: P, layer: 'Body', region: { x: 8, y: 0, w: 16, h: 16 } });
    expect(b.text).toMatch(/layer Body \(L1\)/);
  });

  it('builds a 4-frame walk with bobbing and tags', async () => {
    expect((await call('frame', { project: P, action: 'duplicate', frame: 0, count: 3 })).text).toMatch(/4 frame\(s\)/);
    expect((await call('cel', { project: P, action: 'move', layer: 'Body', frames: [1, 3], dy: -1 })).text).toMatch(/moved 2 cel/);
    expect((await call('cel', { project: P, action: 'move', layer: 'Outline', frames: [1, 3], dy: -1 })).text).toMatch(/moved 2 cel/);
    expect((await call('draw', { project: P, layer: 'Body', frame: 1, ops: [{ op: 'rect', x: 11, y: 23, w: 4, h: 6, fill: 9 }] })).isError).toBe(false);
    expect((await call('tag', { project: P, action: 'add', name: 'walk', from: 0, to: 3 })).text).toMatch(/added tag walk 0-3/);
    expect((await call('tag', { project: P, action: 'add', name: 'idle', from: 0, to: 1, direction: 'pingpong' })).text).toMatch(/pingpong/);
    expect((await call('frame', { project: P, action: 'duration', frames: { tag: 'walk' }, fps: 8 })).text).toMatch(/0:125/);
  });

  it('renders every view within the image budget', async () => {
    const views: Array<Record<string, unknown>> = [
      { view: 'composite' },
      { view: 'indexed' },
      { view: 'value' },
      { view: 'silhouette' },
      { view: 'onion', frame: 1, onion: { prev: 1, next: 1 } },
      { view: 'diff', frame: 1, compareFrame: 0 },
      { view: 'tile' },
      { view: 'filmstrip', tag: 'walk', baseline: 30 },
      { view: 'trail', tag: 'walk' },
      { view: 'timing' },
      { view: 'contact' },
      { view: 'palette' },
      { view: 'composite', region: { x: 8, y: 0, w: 16, h: 16 } },
    ];
    for (const v of views) {
      const r = await call('render', { project: P, ...v });
      expect(r.isError, `${JSON.stringify(v)}: ${r.text}`).toBe(false);
      expect(r.images, JSON.stringify(v)).toHaveLength(1);
    }
    const onion = await call('render', { project: P, view: 'onion', frame: 1, onion: { prev: 1, next: 1 } });
    expect(onion.text).toMatch(/"mode":"outline"/);
    const diff = await call('render', { project: P, view: 'diff', frame: 1, compareFrame: 0 });
    expect(diff.text).toMatch(/"total":\d+/);
    const film = await call('render', { project: P, view: 'filmstrip', tag: 'walk' });
    expect(film.text.split('\n').filter((l) => l.startsWith('{"frame"'))).toHaveLength(4);
  });

  it('analyzes lint, animation, diff, stats and colours', async () => {
    const lint = await call('analyze', { project: P, kind: 'lint' });
    expect(lint.text).toMatch(/^lint: \d+ warning/);
    const anim = await call('analyze', { project: P, kind: 'animation', tag: 'walk' });
    expect(anim.text).toMatch(/4 frame\(s\) in playback order · total 500ms/);
    const diff = await call('analyze', { project: P, kind: 'diff', frameA: 0, frameB: 1 });
    expect(diff.text).toMatch(/best fit: B ≈ A shifted by \(0,-1\)/);
    for (const kind of ['stats', 'colors']) expect((await call('analyze', { project: P, kind })).isError).toBe(false);
  });

  it('exports still formats (png, jpg, webp) that decode to 32x32', async () => {
    for (const f of ['png', 'jpg', 'webp']) {
      const [p] = await exportFormat(f);
      const m = await sharp(readFileSync(p!)).metadata();
      expect([m.width, m.height], f).toEqual([32, 32]);
    }
  });

  it('exports animations (gif, apng, webp_animated) with 4 frames', async () => {
    for (const f of ['gif', 'webp_animated']) {
      const [p] = await exportFormat(f);
      const m = await sharp(readFileSync(p!), { animated: true }).metadata();
      expect(m.pages ?? 1, f).toBe(4);
      expect(m.width, f).toBe(32);
    }
    // libvips reads APNG as a still: check the acTL chunk (num_frames) directly
    const [apng] = await exportFormat('apng');
    const bytes = readFileSync(apng!);
    const at = bytes.indexOf(Buffer.from('acTL'));
    expect(at).toBeGreaterThan(0);
    expect(bytes.readUInt32BE(at + 4)).toBe(4);
    expect((await sharp(bytes).metadata()).width).toBe(32);
    const idle = await exportFormat('gif', { tag: 'idle', filename: 'idle' });
    const m = await sharp(readFileSync(idle[0]!), { animated: true }).metadata();
    expect(m.pages).toBe(2); // pingpong over 2 frames plays 0,1
  });

  it('exports frames, a sprite sheet with JSON, and a palette file', async () => {
    expect(await exportFormat('frames')).toHaveLength(4);
    const sheet = await exportFormat('spritesheet', { sheet: { layout: 'grid', json: 'aseprite-hash', mergeDuplicates: false } });
    const json = JSON.parse(readFileSync(sheet.find((p) => p.endsWith('.json'))!, 'utf8'));
    expect(Object.keys(json.frames)).toHaveLength(4);
    expect(json.meta.frameTags.map((x: { name: string }) => x.name)).toEqual(['walk', 'idle']);
    const img = await sharp(readFileSync(sheet.find((p) => p.endsWith('.png'))!)).metadata();
    expect([img.width, img.height]).toEqual([64, 64]);
    const [pal] = await exportFormat('palette', { paletteFormat: 'gpl' });
    expect(readFileSync(pal!, 'utf8')).toMatch(/^GIMP Palette/);
  });

  it('exports .aseprite and .pxc and re-imports them with identical pixels on every layer and frame', async () => {
    const [ase] = await exportFormat('aseprite');
    const [pxc] = await exportFormat('pxc');
    const a = await call('import', { path: ase, name: 'hero-ase' });
    expect(a.text, a.text).toMatch(/created project hero-ase: Imported \.aseprite: 32x32, 3 layers, 4 frames, 2 tags/);
    const b = await call('import', { path: pxc, name: 'hero-pxc' });
    expect(b.isError, b.text).toBe(false);
    for (const copy of ['hero-ase', 'hero-pxc']) {
      for (let f = 0; f < 4; f++) {
        for (const layer of [undefined, 'Body', 'Outline', 'Shade']) {
          // ASCII readback carries palette indices + hex legend: identical text = identical pixels
          const want = await call('read_pixels', { project: P, frame: f, ...(layer ? { layer } : {}) });
          const got = await call('read_pixels', { project: copy, frame: f, ...(layer ? { layer } : {}) });
          expect(got.text, `${copy} ${layer ?? 'composite'} f${f}`).toBe(want.text);
        }
      }
      const g = await call('project_get', { project: copy });
      expect(g.text).toMatch(/tags: walk 0-3 forward · idle 0-1 pingpong/);
      expect(g.text).toMatch(/durations: 4 × 125ms/);
    }
  });

  it('every call above stayed inside the agent budget (< 1 s, ≤ 3 KB text, images ≤ 1024 px)', () => {
    expect(budget, budget.join("\n")).toEqual([]);
  });
});

describe('D8 recheck: outline/selout sources', () => {
  beforeAll(async () => {
    await call('project_create', { name: 'src', width: 16, height: 16, palette: 'pico-8', layers: ['Art', 'Line', 'Hidden'] });
    await call('layer', { project: 'src', action: 'add', name: 'Grp', type: 'group' });
    await call('layer', { project: 'src', action: 'update', layer: 'Hidden', visible: false });
    await call('draw', { project: 'src', layer: 'Art', ops: [{ op: 'rect', x: 4, y: 4, w: 6, h: 6, fill: 9 }] });
    await call('draw', { project: 'src', layer: 'Hidden', ops: [{ op: 'rect', x: 0, y: 0, w: 3, h: 3, fill: 12 }] });
  });

  it('a named layer, a hidden layer and the composite can be traced; groups and typos are clear errors', async () => {
    expect((await call('draw', { project: 'src', layer: 'Line', ops: [{ op: 'outline', color: 1, source: 'Art' }] })).text).toMatch(/24 px changed.*traced layer Art/s);
    expect((await call('draw', { project: 'src', layer: 'Line', ops: [{ op: 'outline', color: 1, source: 'Hidden' }] })).text).toMatch(/traced layer Hidden/);
    const grp = await call('draw', { project: 'src', layer: 'Line', ops: [{ op: 'outline', color: 1, source: 'Grp' }] });
    expect(grp.text).toMatch(/^Error \[INVALID_ARGUMENT\].*group/);
    const typo = await call('draw', { project: 'src', layer: 'Line', ops: [{ op: 'outline', color: 1, source: 'Artt' }] });
    expect(typo.text).toMatch(/^Error \[NOT_FOUND\].*Available: Art/s);
    await call('history', { project: 'src', action: 'undo', steps: 2 });
    // empty target + no source → falls back to the composite (the D8 fix)
    expect((await call('draw', { project: 'src', layer: 'Line', ops: [{ op: 'outline', color: 1 }] })).text).toMatch(/traced composite/);
    expect((await call('draw', { project: 'src', layer: 'Line', ops: [{ op: 'selout', source: 'composite' }] })).isError).toBe(false);
  });
});

describe('D9 recheck: frame arguments in every tool', () => {
  beforeAll(async () => {
    await call('project_create', { name: 'fr', width: 8, height: 8, palette: 'pico-8', layers: ['A', 'B'], frames: 2 });
    await call('draw', { project: 'fr', layer: 'A', ops: [{ op: 'rect', x: 1, y: 1, w: 4, h: 4, fill: 8 }] });
  });

  const F = 5;
  const cases: Array<[string, Record<string, unknown>]> = [
    ['draw frame', { project: 'fr', layer: 'A', frame: F, ops: [{ op: 'clear' }] }],
    ['draw op frame', { project: 'fr', layer: 'A', ops: [{ op: 'clear', frame: F }] }],
    ['read_pixels', { project: 'fr', frame: F }],
    ['render frame', { project: 'fr', frame: F }],
    ['render compareFrame', { project: 'fr', view: 'diff', frame: 0, compareFrame: F }],
    ['render frames', { project: 'fr', view: 'filmstrip', frames: [0, F] }],
    ['analyze lint frames', { project: 'fr', kind: 'lint', frames: [F] }],
    ['analyze animation', { project: 'fr', kind: 'animation', frames: { from: 0, to: F } }],
    ['analyze diff', { project: 'fr', kind: 'diff', frameA: 0, frameB: F }],
    ['export frame', { project: 'fr', format: 'png', frame: F }],
    ['export frames', { project: 'fr', format: 'gif', frames: [0, F] }],
    ['cel copy toFrame', { project: 'fr', action: 'copy', layer: 'A', frame: 0, toFrame: F }],
    ['cel tween', { project: 'fr', action: 'tween', layer: 'A', from: 0, to: F }],
    ['tag add', { project: 'fr', action: 'add', name: 't', from: 0, to: F }],
    ['slice frame', { project: 'fr', action: 'set', name: 's', bounds: { x: 0, y: 0, w: 2, h: 2 }, frame: F }],
    ['frame move', { project: 'fr', action: 'move', frame: 0, to: F }],
    ['frame duplicate', { project: 'fr', action: 'duplicate', frame: F }],
    ['select wand frame', { project: 'fr', action: 'wand', x: 1, y: 1, layer: 'A', frame: F }],
    ['transform frames', { project: 'fr', scope: 'cel', layer: 'A', frames: [F], op: 'flip_h' }],
  ];
  const toolOf: Record<string, string> = { draw: 'draw', read_pixels: 'read_pixels', render: 'render', analyze: 'analyze', export: 'export', cel: 'cel', tag: 'tag', slice: 'slice', frame: 'frame', select: 'select', transform: 'transform' };
  for (const [label, args] of cases) {
    it(`${label} ${F} → actionable out-of-range error (regression guard)`, async () => {
      const r = await call(toolOf[label.split(' ')[0]!]!, args, false);
      expect(r.isError, r.text).toBe(true);
      expect(r.text).toMatch(/Frame 5 out of range[\s\S]*0\.\.1/);
    });
  }

  it('R18: stamp from a frame that does not exist is an error, not a silent "stamped A@5" no-op', async () => {
    const r = await call('draw', { project: 'fr', layer: 'A', ops: [{ op: 'stamp', from: { frame: F }, dx: 1 }] }, false);
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toMatch(/Frame 5 out of range/);
  });
});

describe('R13 (MCP side): non-integer quality is a validation error, not INTERNAL', () => {
  it('export jpg quality 50.5', async () => {
    const r = await call('export', { project: P, format: 'jpg', quality: 50.5 }, false);
    expect(r.isError).toBe(true);
    expect(r.text).not.toMatch(/INTERNAL/);
  });
});

describe('R16: explicit render scale bypasses the image budget', () => {
  beforeAll(async () => {
    await call('project_create', { name: 'big', width: 128, height: 128, palette: 'pico-8' });
  });
  for (const args of [{ scale: 64 }, { view: 'tile', scale: 16 }, { view: 'filmstrip', scale: 32 }, { view: 'indexed', scale: 40, region: { x: 0, y: 0, w: 64, h: 64 } }]) {
    it(`render ${JSON.stringify(args)} on 128x128 returns an image ≤ 1600 px (schema maxSize) in < 1 s`, async () => {
      const r = await call('render', { project: 'big', ...args }, false);
      expect(r.isError, r.text).toBe(false);
      const { w, h } = pngSize(r.images[0]!);
      expect(Math.max(w, h), `${w}x${h} in ${Math.round(r.ms)} ms`).toBeLessThanOrEqual(1600);
      expect(r.ms).toBeLessThan(1000);
    }, 30000);
  }
});

describe('R17: integer arguments accept fractions and misbehave (zod schemas dropped .int())', () => {
  beforeAll(async () => {
    await call('project_create', { name: 'frac', width: 8, height: 8, palette: 'pico-8' });
    await call('draw', { project: 'frac', ops: [{ op: 'rect', x: 0, y: 0, w: 4, h: 4, fill: 8 }] });
    await call('draw', { project: 'frac', ops: [{ op: 'pixels', points: [[7, 7]], color: 9 }] });
  });

  it('select rect {x:0.5, y:0.5, w:3.5, h:3.5} selects pixels near the origin (not "bounds 4,0 4x4")', async () => {
    const r = await call('select', { project: 'frac', action: 'rect', x: 0.5, y: 0.5, w: 3.5, h: 3.5 }, false);
    if (r.isError) return; // rejecting fractions is fine too
    const m = /bounds (\d+),(\d+) (\d+)x(\d+)/.exec(r.text)!;
    expect(Number(m[1]), r.text).toBeLessThanOrEqual(1);
    expect(Number(m[2]), r.text).toBeLessThanOrEqual(1);
  });

  it('canvas crop at {x:0.5, y:0.5} must not erase every pixel', async () => {
    const r = await call('canvas', { project: 'frac', action: 'crop', rect: { x: 0.5, y: 0.5, w: 6, h: 6 } }, false);
    if (r.isError) return;
    const px = await call('read_pixels', { project: 'frac' }, false);
    expect(px.text, px.text).not.toMatch(/· 0 opaque px/);
    await call('history', { project: 'frac', action: 'undo' }, false);
  });

  it('history undo steps:1.5 undoes one step (or is rejected), not two', async () => {
    const r = await call('history', { project: 'frac', action: 'undo', steps: 1.5 }, false);
    if (r.isError) return;
    expect(r.text.split('|').length, r.text).toBe(1);
  });

  it('sheet padding 1.5 yields integer frame rects (or is rejected)', async () => {
    const r = await call('export', { project: P, format: 'spritesheet', sheet: { padding: 1.5, mergeDuplicates: false }, filename: 'frac' }, false);
    if (r.isError) return;
    const json = JSON.parse(readFileSync(/- (\S+\.json)/.exec(r.text)![1]!, 'utf8'));
    for (const f of Object.values(json.frames) as Array<{ frame: { x: number } }>) expect(Number.isInteger(f.frame.x), JSON.stringify(f.frame)).toBe(true);
  });
});

describe('R19: lint flags the built-in default palette', () => {
  it('a fresh endesga-32 sprite (the default palette) gets no ramp-contrast finding about its own preset ramps', async () => {
    await call('project_create', { name: 'lintdef', width: 16, height: 16 });
    await call('draw', { project: 'lintdef', ops: [{ op: 'rect', x: 4, y: 4, w: 6, h: 6, fill: 9, color: 1 }] });
    const r = await call('analyze', { project: 'lintdef', kind: 'lint' });
    expect(r.text).not.toMatch(/ramp-contrast/);
  });
});
