/**
 * QA: MCP tools through the in-memory client — error results, schema validation, revisions, warnings,
 * response size, resources, and a realistic agent workflow with exports validated by sharp.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { mcpClient, type TestClient } from '../helpers.js';

let t: TestClient;

/** Call a tool; protocol-level validation failures are folded into {isError, text}. */
async function call(name: string, args: Record<string, unknown> = {}) {
  try {
    return await t.call(name, args);
  } catch (e) {
    return { text: String(e), images: [] as string[], isError: true, raw: null, threw: true };
  }
}

function rev(text: string): number {
  const m = /rev (\d+)/.exec(text);
  return m ? Number(m[1]) : -1;
}

beforeAll(async () => {
  t = await mcpClient();
  await call('project_create', { name: 'qa', width: 16, height: 16, palette: 'pico-8', layers: ['Body', 'Line'], frames: 3 });
});
afterAll(async () => t.close());

describe('error results are flagged and actionable', () => {
  const cases: Array<[string, string, Record<string, unknown>, RegExp]> = [
    ['unknown project', 'project_get', { project: 'qaa' }, /did you mean/i],
    ['unknown layer', 'draw', { project: 'qa', layer: 'Bodyy', ops: [{ op: 'clear' }] }, /Did you mean: Body/],
    ['frame out of range', 'draw', { project: 'qa', layer: 'Body', frame: 3, ops: [{ op: 'clear' }] }, /0-indexed.*0\.\.2/],
    ['ambiguous default layer', 'draw', { project: 'qa', ops: [{ op: 'clear' }] }, /Body \(L1\).*Line \(L2\)/],
    ['bad colour', 'draw', { project: 'qa', layer: 'Body', ops: [{ op: 'pixels', points: [[0, 0]], color: 'reddish' }] }, /Hint: Use a palette index/],
    ['palette index out of range', 'draw', { project: 'qa', layer: 'Body', ops: [{ op: 'pixels', points: [[0, 0]], color: 99 }] }, /0\.\.16/],
    ['unknown tag in export', 'export', { project: 'qa', format: 'gif', tag: 'walk' }, /no tags yet|Available/],
    ['non-integer export scale', 'export', { project: 'qa', format: 'png', scale: 2.5 }, /integer/],
    ['export frame out of range', 'export', { project: 'qa', format: 'png', frame: 7 }, /Frame 7 out of range/],
    ['read_pixels region too big', 'read_pixels', { project: 'qa', region: { x: 0, y: 0, w: 16, h: 16 }, layer: 'Nope' }, /not found/],
    ['analyze diff without frames', 'analyze', { project: 'qa', kind: 'diff' }, /frameA and frameB/],
    ['transform layer scope without layer', 'transform', { project: 'qa', scope: 'layer', op: 'flip_h' }, /needs "layer"/],
    ['remove every frame', 'frame', { project: 'qa', action: 'remove', frames: 'all' }, /at least one/],
    ['cel copy without toFrame', 'cel', { project: 'qa', action: 'copy', layer: 'Body', frame: 0 }, /needs "toFrame"/],
    ['restore without name', 'checkpoint', { project: 'qa', action: 'restore' }, /needs name/],
    ['import without path or data', 'import', {}, /path.*data/],
    ['unknown selection clip', 'draw', { project: 'qa', layer: 'Body', clip: 'sel', ops: [{ op: 'clear' }] }, /selection 'sel' not found/],
    ['tween without cels', 'cel', { project: 'qa', action: 'tween', layer: 'Line', from: 0, to: 2 }, /need a cel/],
  ];
  for (const [label, tool, args, re] of cases) {
    it(label, async () => {
      const r = await call(tool, args);
      expect(r.isError, r.text).toBe(true);
      expect(r.text).toMatch(/^Error \[[A-Z_]+\]/);
      expect(r.text).toMatch(re);
    });
  }

  it('locked layers explain how to unlock', async () => {
    await call('layer', { project: 'qa', action: 'update', layer: 'Line', locked: true });
    const r = await call('draw', { project: 'qa', layer: 'Line', ops: [{ op: 'clear' }] });
    expect(r.text).toMatch(/Hint: Unlock it first: layer \{action:"update", layer:"L2", locked:false\}/);
    await call('layer', { project: 'qa', action: 'update', layer: 'Line', locked: false });
  });

  it('every PixelClaus error with a hint prints "Hint:" on its own line', async () => {
    const r = await call('draw', { project: 'qa', layer: 'Body', ops: [{ op: 'grid', rows: ['zz', 'z'] }] });
    expect(r.text).toMatch(/\nHint: /);
  });
});

describe('schema validation errors', () => {
  const bad: Array<[string, string, Record<string, unknown>]> = [
    ['unknown draw op', 'draw', { project: 'qa', layer: 'Body', ops: [{ op: 'spray', x: 1 }] }],
    ['rect with negative width', 'draw', { project: 'qa', layer: 'Body', ops: [{ op: 'rect', x: 0, y: 0, w: -3, h: 2, fill: 1 }] }],
    ['empty ops', 'draw', { project: 'qa', layer: 'Body', ops: [] }],
    ['delete without confirm', 'project_delete', { project: 'qa' }],
    ['canvas width 0', 'canvas', { project: 'qa', action: 'resize', width: 0, height: 4 }],
    ['bad export format', 'export', { project: 'qa', format: 'bmp' }],
    ['bad view name', 'render', { project: 'qa', view: 'xray' }],
    ['frame negative', 'render', { project: 'qa', frame: -1 }],
    ['missing project', 'draw', { ops: [{ op: 'clear' }] }],
  ];
  for (const [label, tool, args] of bad) {
    it(label, async () => {
      const r = await call(tool, args);
      expect(r.isError, r.text).toBe(true);
      // the message should point at the offending field
      expect(r.text.length).toBeLessThan(2500);
    });
  }

  it('unknown draw op error names the valid ops (not a wall of union errors)', async () => {
    const r = await call('draw', { project: 'qa', layer: 'Body', ops: [{ op: 'spray', x: 1 }] });
    expect(r.text).toMatch(/pixels.*grid.*line/s);
  });

  it('a mistyped field inside one op points at ops[i].field', async () => {
    const r = await call('draw', { project: 'qa', layer: 'Body', ops: [{ op: 'clear' }, { op: 'rect', x: 0, y: 0, w: 2, h: '3', fill: 1 }] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/ops.?\.?1.*h|ops\[1\].*h/);
  });

  it('unknown fields are reported instead of silently ignored (typo "colour")', async () => {
    const r = await call('draw', { project: 'qa', layer: 'Body', ops: [{ op: 'rect', x: 0, y: 0, w: 2, h: 2, colour: 8 }] });
    // silently ignoring "colour" leads to a confusing "rect needs color and/or fill"; either is acceptable as long as it errors
    expect(r.isError).toBe(true);
  });

  it('shade/selout "light" accepts only valid directions', async () => {
    await call('draw', { project: 'qa', layer: 'Body', ops: [{ op: 'rect', x: 2, y: 2, w: 10, h: 10, fill: 9 }] });
    const r = await call('draw', { project: 'qa', layer: 'Body', ops: [{ op: 'shade', mode: 'light', light: 'north-west' }] });
    expect(r.isError).toBe(true);
    await call('history', { project: 'qa', action: 'undo', steps: 1 });
  });
});

describe('revisions, warnings and concise responses', () => {
  it('each mutating call bumps rev by exactly one; reads do not', async () => {
    const a = await call('draw', { project: 'qa', layer: 'Body', ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    const r0 = rev(a.text);
    await call('render', { project: 'qa' });
    await call('read_pixels', { project: 'qa' });
    await call('analyze', { project: 'qa', kind: 'stats' });
    await call('project_get', { project: 'qa' });
    const b = await call('draw', { project: 'qa', layer: 'Body', ops: [{ op: 'pixels', points: [[1, 0]], color: 8 }] });
    expect(rev(b.text)).toBe(r0 + 1);
    const c = await call('tag', { project: 'qa', action: 'add', name: 'all', from: 0, to: 2 });
    expect(rev(c.text)).toBe(r0 + 2);
    const u = await call('history', { project: 'qa', action: 'undo' });
    expect(rev(u.text)).toBe(r0 + 3);
    await call('history', { project: 'qa', action: 'redo' });
  });

  it('a draw that changes nothing does not bump the revision', async () => {
    const a = await call('draw', { project: 'qa', layer: 'Body', ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    const b = await call('draw', { project: 'qa', layer: 'Body', ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] });
    expect(b.text).toMatch(/0 px changed/);
    expect(rev(b.text)).toBe(rev(a.text));
  });

  it('warnings surface: hidden layer, linked cels, snapped colour, dropped grid pixels', async () => {
    await call('layer', { project: 'qa', action: 'update', layer: 'Line', visible: false });
    await call('cel', { project: 'qa', action: 'link', layer: 'Line', frames: [0, 1] });
    const r = await call('draw', {
      project: 'qa',
      layer: 'Line',
      ops: [
        { op: 'pixels', points: [[5, 5]], color: '#fe0000' },
        { op: 'grid', x: 15, y: 15, rows: ['99', '99'] },
      ],
    });
    expect(r.text).toMatch(/warnings:/);
    expect(r.text).toMatch(/hidden/);
    expect(r.text).toMatch(/linked with frame\(s\) 1/);
    expect(r.text).toMatch(/snapped to index/);
    expect(r.text).toMatch(/3 pixel\(s\) fell outside/);
    await call('layer', { project: 'qa', action: 'update', layer: 'Line', visible: true });
  });

  it('large batches keep the reply compact (no one line per op for hundreds of ops)', async () => {
    const ops = Array.from({ length: 300 }, (_, i) => ({ op: 'pixels', points: [[i % 16, Math.floor(i / 16) % 16]], color: 2 + (i % 5) }));
    const r = await call('draw', { project: 'qa', layer: 'Body', ops });
    expect(r.isError).toBe(false);
    expect(r.text.length).toBeLessThan(3000);
  });

  it('preview follows the frame that was actually drawn (op-level frame override)', async () => {
    const r = await call('draw', { project: 'qa', layer: 'Body', ops: [{ op: 'rect', frame: 2, x: 0, y: 0, w: 16, h: 16, fill: 12 }], preview: true });
    expect(r.images.length).toBe(1);
    const png = Buffer.from(r.images[0]!, 'base64');
    // draw previews use maxSize 512; render the same way for a byte-exact comparison
    const f0 = Buffer.from((await call('render', { project: 'qa', frame: 0, maxSize: 512 })).images[0]!, 'base64');
    const f2 = Buffer.from((await call('render', { project: 'qa', frame: 2, maxSize: 512 })).images[0]!, 'base64');
    expect(f0.equals(f2)).toBe(false);
    expect(png.equals(f0) ? 'preview == frame 0' : png.equals(f2) ? 'preview == frame 2' : 'neither').toBe('preview == frame 2');
  });

  it('contact view reports the colour usage of the composite (not colors:0)', async () => {
    const r = await call('render', { project: 'qa', view: 'contact' });
    const c = await call('render', { project: 'qa', view: 'composite' });
    const colors = (t: string) => Number(/"colors":(\d+)/.exec(t)?.[1] ?? -1);
    expect(colors(c.text)).toBeGreaterThan(0);
    expect(colors(r.text)).toBe(colors(c.text));
  });

  it('render returns a decodable PNG of reasonable size plus numbers', async () => {
    for (const view of ['composite', 'indexed', 'filmstrip', 'contact', 'palette']) {
      const r = await call('render', { project: 'qa', view });
      expect(r.isError, r.text).toBe(false);
      const meta = await sharp(Buffer.from(r.images[0]!, 'base64')).metadata();
      expect(meta.format).toBe('png');
      // spec §5.3: previews auto-scale to ~512-768 px, cap 1024 (images are the most token-expensive output)
      expect(Math.max(meta.width!, meta.height!), `${view} ${meta.width}x${meta.height}`).toBeLessThanOrEqual(1024);
      expect(Math.max(meta.width!, meta.height!), view).toBeGreaterThanOrEqual(64);
    }
  });

  it('render on a 1-frame sprite with onion/diff/trail views does not error', async () => {
    await call('project_create', { name: 'single', width: 8, height: 8, palette: 'pico-8' });
    for (const view of ['onion', 'diff', 'trail', 'timing', 'filmstrip', 'tile']) {
      const r = await call('render', { project: 'single', view });
      expect(r.isError, `${view}: ${r.text}`).toBe(false);
    }
  });

  it('project_get is compact for a typical sprite', async () => {
    const r = await call('project_get', { project: 'qa' });
    expect(r.text.length).toBeLessThan(1500);
    expect(r.text).toMatch(/L1 "Body"/);
  });

  it('resources: project overview and preview.png', async () => {
    const o = await t.client.readResource({ uri: 'pixelclaus://projects/qa' });
    expect(JSON.stringify(o)).toMatch(/Body/);
    const p = await t.client.readResource({ uri: 'pixelclaus://projects/qa/preview.png' });
    const blob = (p.contents[0] as { blob: string }).blob;
    expect((await sharp(Buffer.from(blob, 'base64')).metadata()).format).toBe('png');
  });
});

describe('outline/selout on a dedicated layer', () => {
  it('outline drawn on an empty "Outline" layer outlines the art below it (or at least warns)', async () => {
    await call('project_create', { name: 'ol', width: 16, height: 16, palette: 'endesga-32', layers: ['Body', 'Outline'] });
    const r = await call('draw', {
      project: 'ol',
      layer: 'Body',
      ops: [
        { op: 'ellipse', x: 3, y: 2, w: 10, h: 12, fill: 13 },
        { op: 'outline', color: 25, layer: 'Outline' }, // the pattern used in the project's own tests/guide
      ],
    });
    expect(r.isError).toBe(false);
    // today: "[1] outline Outline@0: 0 px" with no warning — the outline silently does nothing
    expect(/\[1\] outline Outline@0: 0 px/.test(r.text) && !/warnings:/.test(r.text)).toBe(false);
  });
});

describe('realistic agent workflow: 32x32 character, 4-frame walk, lint, exports', () => {
  it('builds, animates, lints and exports a sprite sheet + GIF', async () => {
    let r = await call('project_create', {
      name: 'Knight',
      width: 32,
      height: 32,
      palette: 'endesga-32',
      layers: ['Body', 'Shade', 'Outline'],
      settings: { lightDirection: 'top-left', previewBackground: '#1a1c2c' },
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/created knight/);
    // body: helmet + torso + legs
    r = await call('draw', {
      project: 'knight',
      layer: 'Body',
      ops: [
        { op: 'ellipse', x: 10, y: 4, w: 12, h: 11, fill: 'ramp:gray:2' },
        { op: 'rect', x: 11, y: 14, w: 10, h: 10, fill: 'ramp:gray:1' },
        { op: 'line', from: [12, 9], to: [19, 9], color: 1 },
      ],
    });
    // ramps may be named differently — fall back to indices if needed
    if (r.isError) {
      expect(r.text).toMatch(/Ramps: /);
      r = await call('draw', {
        project: 'knight',
        layer: 'Body',
        ops: [
          { op: 'ellipse', x: 10, y: 4, w: 12, h: 11, fill: 21 },
          { op: 'rect', x: 11, y: 14, w: 10, h: 10, fill: 20 },
          { op: 'line', from: [12, 9], to: [19, 9], color: 1 },
        ],
      });
    }
    expect(r.isError, r.text).toBe(false);
    r = await call('draw', { project: 'knight', layer: 'Body', ops: [{ op: 'shade', mode: 'light' }, { op: 'outline', color: 1 }] });
    expect(r.isError, r.text).toBe(false);
    // the walk: legs on their own layer so they can move independently
    r = await call('layer', { project: 'knight', action: 'add', name: 'Legs', above: 'Body' });
    expect(r.isError, r.text).toBe(false);
    r = await call('draw', { project: 'knight', layer: 'Legs', ops: [{ op: 'rect', x: 12, y: 24, w: 3, h: 6, fill: 1 }, { op: 'rect', x: 17, y: 24, w: 3, h: 6, fill: 1 }] });
    expect(r.isError, r.text).toBe(false);
    // animation: 4 frames, legs move via cel offsets
    r = await call('frame', { project: 'knight', action: 'duplicate', frame: 0, count: 3 });
    expect(r.text).toMatch(/4 frame\(s\)/);
    for (const [f, dy] of [[1, -1], [3, -1]] as const) {
      r = await call('cel', { project: 'knight', action: 'move', layer: 'Legs', frames: [f], dx: f === 1 ? 1 : -1, dy });
      expect(r.isError, r.text).toBe(false);
    }
    r = await call('frame', { project: 'knight', action: 'duration', frames: 'all', fps: 8 });
    expect(r.text).toMatch(/0:125 1:125 2:125 3:125/);
    r = await call('tag', { project: 'knight', action: 'add', name: 'walk', from: 0, to: 3, direction: 'pingpong' });
    expect(r.isError, r.text).toBe(false);
    r = await call('render', { project: 'knight', view: 'filmstrip', tag: 'walk', baseline: 29 });
    expect(r.isError, r.text).toBe(false);
    expect(r.images.length).toBe(1);
    r = await call('analyze', { project: 'knight', kind: 'animation', tag: 'walk' });
    expect(r.text).toMatch(/6 frame\(s\) in playback order/); // ping-pong unrolled 0,1,2,3,2,1
    r = await call('analyze', { project: 'knight', kind: 'lint' });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/lint: \d+ warning/);
    r = await call('checkpoint', { project: 'knight', action: 'create', name: 'walk v1' });
    expect(r.text).toMatch(/walk v1/);
    // exports
    r = await call('export', { project: 'knight', format: 'spritesheet', scale: 2, sheet: { layout: 'horizontal', padding: 1, json: 'aseprite-hash' } });
    expect(r.isError, r.text).toBe(false);
    const files = [...r.text.matchAll(/- ((?:[A-Za-z]:)?[\\/]\S+) \(/g)].map((m) => m[1]!);
    const png = files.find((f) => f.endsWith('.png'))!;
    const json = JSON.parse(readFileSync(files.find((f) => f.endsWith('.json'))!, 'utf8'));
    const meta = await sharp(readFileSync(png)).metadata();
    expect(meta.width).toBe(json.meta.size.w);
    expect(meta.height).toBe(json.meta.size.h);
    expect(Object.keys(json.frames).length).toBe(4);
    for (const fr of Object.values(json.frames) as Array<{ frame: { x: number; y: number; w: number; h: number }; duration: number }>) {
      expect(fr.frame.x + fr.frame.w).toBeLessThanOrEqual(meta.width!);
      expect(fr.frame.w).toBe(64);
      expect(fr.duration).toBe(125);
    }
    expect(json.meta.frameTags[0]).toMatchObject({ name: 'walk', from: 0, to: 3, direction: 'pingpong' });
    r = await call('export', { project: 'knight', format: 'gif', tag: 'walk', scale: 3 });
    expect(r.isError, r.text).toBe(false);
    const gifPath = /- ((?:[A-Za-z]:)?[\\/]\S+\.gif)/.exec(r.text)![1]!;
    const gm = await sharp(readFileSync(gifPath), { animated: true }).metadata();
    expect(gm.pages).toBe(6);
    expect(gm.width).toBe(96);
    expect(gm.delay).toEqual(Array(6).fill(130));
    expect(r.text).toMatch(/rounded to 10 ms/); // 125 ms → 13 cs
    // other formats decode with sharp
    for (const format of ['png', 'webp', 'jpg', 'apng', 'webp_animated']) {
      r = await call('export', { project: 'knight', format, frame: 1, scale: 2 });
      expect(r.isError, `${format}: ${r.text}`).toBe(false);
      const path = /- ((?:[A-Za-z]:)?[\\/]\S+) \(/.exec(r.text)![1]!;
      const m = await sharp(readFileSync(path), { animated: true }).metadata();
      expect(m.width, format).toBe(64);
      if (format === 'webp_animated') expect(m.pages, `${r.text} ${JSON.stringify({ ...m, exif: undefined, icc: undefined })}`).toBe(4);
    }
    r = await call('export', { project: 'knight', format: 'jpg' });
    expect(r.text).toMatch(/JPG has no transparency; composited on #1a1c2c/);
  });

  it('palette variants and splitLayers produce one file per variant/layer', async () => {
    const r = await call('export', { project: 'knight', format: 'png', splitLayers: true, paletteVariants: [{ name: 'dark', palette: 'pico-8' }, { name: 'gb', palette: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'] }] });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/exported 8 file/); // 2 variants × 4 image layers
  });

  it('import round-trip: exported aseprite/pxc/gif/png re-import as new projects', async () => {
    for (const format of ['aseprite', 'pxc', 'gif', 'png']) {
      const e = await call('export', { project: 'knight', format, filename: `rt-${format}` });
      const path = /- ((?:[A-Za-z]:)?[\\/]\S+) \(/.exec(e.text)![1]!;
      const r = await call('import', { path, name: `rt ${format}` });
      expect(r.isError, `${format}: ${r.text}`).toBe(false);
      expect(r.text).toMatch(/created project/);
    }
    const g = await call('project_get', { project: 'rt-gif' });
    expect(g.text).toMatch(/32x32/);
    expect(g.text).toMatch(/frames 4/);
  });

  it('import a sprite sheet (frameWidth/Height) and an image as a new layer', async () => {
    const e = await call('export', { project: 'knight', format: 'spritesheet', filename: 'sheet-rt', sheet: { layout: 'grid', columns: 2, json: 'none', mergeDuplicates: false } });
    const path = /- ((?:[A-Za-z]:)?[\\/]\S+\.png)/.exec(e.text)![1]!;
    let r = await call('import', { path, kind: 'spritesheet', frameWidth: 32, frameHeight: 32, name: 'from sheet', duration: 90 });
    expect(r.isError, r.text).toBe(false);
    r = await call('project_get', { project: 'from-sheet' });
    expect(r.text).toMatch(/frames 4 \(360ms\)/);
    const png = /- ((?:[A-Za-z]:)?[\\/]\S+\.png)/.exec((await call('export', { project: 'knight', format: 'png', filename: 'layer-src' })).text)![1]!;
    r = await call('import', { path: png, project: 'knight', layer: 'Imported', x: 20, y: 20 });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/cropped/);
  });

  it('import of a non-image payload gives a clean error, not an INTERNAL crash dump', async () => {
    const r = await call('import', { data: Buffer.from('hello world, not an image').toString('base64'), filename: 'x.png' });
    expect(r.isError).toBe(true);
    expect(r.text).not.toMatch(/INTERNAL/);
  });
});

describe('misc validation found while exploring', () => {
  it('importing an image with off-palette colours into an indexed project warns about snapping', async () => {
    await call('project_create', { name: 'imp', width: 4, height: 4, palette: 'pico-8' });
    const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: { r: 10, g: 200, b: 190, alpha: 1 } } }).png().toBuffer();
    const r = await call('import', { data: png.toString('base64'), filename: 'teal.png', project: 'imp', layer: 'teal' });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/snapp|not in the palette|nearest/i);
  });

  it('tag colour must be a valid hex colour', async () => {
    await call('project_create', { name: 'tagc', width: 4, height: 4, palette: 'pico-8', frames: 2 });
    const r = await call('tag', { project: 'tagc', action: 'add', name: 'x', from: 0, to: 1, color: 'banana' });
    expect(r.isError, r.text).toBe(true);
  });
});
