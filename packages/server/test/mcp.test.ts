import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mcpClient, type TestClient } from './helpers.js';

let t: TestClient;
beforeAll(async () => {
  t = await mcpClient();
});
afterAll(async () => {
  await t.close();
});

describe('MCP surface', () => {
  it('exposes 24 tools with schemas, instructions, resources and prompts', async () => {
    const tools = (await t.client.listTools()).tools;
    expect(tools.map((x) => x.name).sort()).toEqual(
      [
        'analyze',
        'canvas',
        'cel',
        'checkpoint',
        'draw',
        'export',
        'frame',
        'guide',
        'history',
        'import',
        'layer',
        'palette',
        'project_create',
        'project_delete',
        'project_duplicate',
        'project_get',
        'project_list',
        'project_update',
        'read_pixels',
        'render',
        'select',
        'slice',
        'tag',
        'transform',
      ].sort(),
    );
    for (const tool of tools) expect(tool.description!.length).toBeGreaterThan(20);
    expect(JSON.stringify(tools).length).toBeLessThan(60000); // keep the tool list affordable
    expect(t.client.getInstructions()).toMatch(/0-indexed/);
    const res = await t.client.listResources();
    expect(res.resources.some((r) => r.uri === 'pixelclaus://guide/ascii')).toBe(true);
    const guide = await t.client.readResource({ uri: 'pixelclaus://guide/animation' });
    expect(JSON.stringify(guide)).toMatch(/filmstrip/);
    const prompts = await t.client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toEqual([
      'sprite_workflow',
      'animation_workflow',
      'tileset_workflow',
    ]);
    const p = await t.client.getPrompt({ name: 'sprite_workflow', arguments: { subject: 'a cat' } });
    expect(JSON.stringify(p)).toMatch(/a cat/);
  });

  it('guide topics', async () => {
    for (const topic of [
      'overview',
      'ascii',
      'sprite',
      'animation',
      'tileset',
      'palettes',
      'lint',
      'export',
      'ops',
    ]) {
      const r = await t.call('guide', { topic });
      expect(r.isError).toBe(false);
      expect(r.text.length).toBeGreaterThan(200);
    }
  });
});

describe('full workflow through tools', () => {
  it('creates and draws a sprite with feedback', async () => {
    let r = await t.call('project_create', {
      name: 'Hero',
      width: 16,
      height: 16,
      palette: 'endesga-32',
      layers: ['Body', 'Outline'],
      settings: { lightDirection: 'top-left' },
    });
    expect(r.text).toMatch(/created hero/);
    expect(r.text).toMatch(/L2 "Outline"/);
    r = await t.call('draw', {
      project: 'hero',
      layer: 'Body',
      ops: [
        { op: 'ellipse', x: 3, y: 2, w: 10, h: 12, fill: 13 },
        { op: 'shade', mode: 'light' },
        { op: 'outline', color: 25, layer: 'Outline' },
      ],
      preview: true,
    });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/3 op\(s\)/);
    expect(r.images.length).toBe(1);
    r = await t.call('read_pixels', { project: 'hero', layer: 'Body', region: { x: 0, y: 0, w: 16, h: 4 } });
    expect(r.text).toMatch(/legend: .*'\.' transparent/);
    expect(r.text).toMatch(/\n0\| /);
    // round-trip: write back the rows we read
    const rows = r.text.split('\n').filter((l) => /^\d+\| /.test(l));
    r = await t.call('draw', { project: 'hero', layer: 'Body', ops: [{ op: 'grid', rows }] });
    expect(r.text).toMatch(/0 px changed/);
  });

  it('renders every view', async () => {
    await t.call('frame', { project: 'hero', action: 'duplicate', frame: 0, count: 2 });
    for (const view of [
      'composite',
      'indexed',
      'value',
      'silhouette',
      'onion',
      'diff',
      'tile',
      'filmstrip',
      'trail',
      'timing',
      'contact',
      'palette',
    ]) {
      const r = await t.call('render', { project: 'hero', view, frame: 1 });
      expect(r.isError, `${view}: ${r.text}`).toBe(false);
      expect(r.images.length, view).toBe(1);
      expect(r.text).toMatch(/view/);
    }
  });

  it('structure tools', async () => {
    let r = await t.call('layer', { project: 'hero', action: 'add', name: 'FX', type: 'group' });
    expect(r.text).toMatch(/added group layer L3/);
    r = await t.call('layer', { project: 'hero', action: 'add', name: 'Spark', parent: 'FX' });
    expect(r.text).toMatch(/ {2}- L4 "Spark"/);
    r = await t.call('layer', {
      project: 'hero',
      action: 'update',
      layer: 'Spark',
      opacity: 128,
      blendMode: 'screen',
    });
    expect(r.text).toMatch(/opacity 128, screen/);
    r = await t.call('tag', {
      project: 'hero',
      action: 'add',
      name: 'idle',
      from: 0,
      to: 2,
      direction: 'pingpong',
    });
    expect(r.text).toMatch(/added tag idle 0-2 pingpong/);
    r = await t.call('frame', {
      project: 'hero',
      action: 'duration',
      frames: { tag: 'idle' },
      durations: [200, 100, 150],
    });
    expect(r.text).toMatch(/0:200 1:100 2:150/);
    r = await t.call('cel', { project: 'hero', action: 'move', layer: 'Body', frames: [1], dy: 1 });
    expect(r.text).toMatch(/moved 1 cel/);
    r = await t.call('cel', { project: 'hero', action: 'link', layer: 'Outline', frames: 'all' });
    expect(r.text).toMatch(/linked 3/);
    r = await t.call('slice', {
      project: 'hero',
      action: 'set',
      name: 'feet',
      bounds: { x: 4, y: 12, w: 8, h: 4 },
      pivot: [4, 3],
    });
    expect(r.text).toMatch(/slice feet/);
    r = await t.call('select', { project: 'hero', action: 'wand', x: 8, y: 8, layer: 'Body' });
    expect(r.text).toMatch(/selection active: \d+ px/);
    r = await t.call('transform', {
      project: 'hero',
      scope: 'cel',
      layer: 'Body',
      frames: [2],
      op: 'flip_h',
    });
    expect(r.text).toMatch(/flip_h applied/);
    r = await t.call('palette', { project: 'hero', action: 'generate_ramp', base: '#c04040', name: 'brick' });
    expect(r.text).toMatch(/indices 33,34,35,36,37/);
    r = await t.call('palette', { project: 'hero', action: 'get' });
    expect(r.text).toMatch(/brick\[33,34,35,36,37\]/);
    r = await t.call('project_get', { project: 'Hero' });
    expect(r.text).toMatch(/tags: idle 0-2 pingpong/);
    expect(r.text).toMatch(/linked \[0-2\]/);
  });

  it('analysis tools', async () => {
    let r = await t.call('analyze', { project: 'hero', kind: 'lint' });
    expect(r.text).toMatch(/^lint:/);
    r = await t.call('analyze', { project: 'hero', kind: 'animation', tag: 'idle' });
    expect(r.text).toMatch(/frame \| ms \| bbox/);
    expect(r.text.split('\n').length).toBeGreaterThan(5); // ping-pong 0 1 2 1
    r = await t.call('analyze', { project: 'hero', kind: 'stats' });
    expect(r.text).toMatch(/L1 "Body"/);
    r = await t.call('analyze', { project: 'hero', kind: 'colors' });
    expect(r.text).toMatch(/palette "endesga-32"/);
    r = await t.call('analyze', { project: 'hero', kind: 'diff', frameA: 0, frameB: 1 });
    expect(r.text).toMatch(/\d+ px differ/);
  });

  it('history and checkpoints', async () => {
    let r = await t.call('checkpoint', { project: 'hero', action: 'create', name: 'good' });
    expect(r.text).toMatch(/checkpoint "good"/);
    await t.call('draw', { project: 'hero', layer: 'Body', ops: [{ op: 'clear' }] });
    r = await t.call('history', { project: 'hero', action: 'undo' });
    expect(r.text).toMatch(/undid: Draw/);
    r = await t.call('history', { project: 'hero', action: 'list' });
    expect(r.text).toMatch(/redo stack: Draw/);
    r = await t.call('checkpoint', { project: 'hero', action: 'restore', name: 'good' });
    expect(r.text).toMatch(/restored "good"/);
    r = await t.call('checkpoint', { project: 'hero', action: 'list' });
    expect(r.text.split('\n').length).toBe(2);
  });

  it('exports and imports through tools', async () => {
    let r = await t.call('export', {
      project: 'hero',
      format: 'spritesheet',
      scale: 2,
      sheet: { layout: 'rows', json: 'aseprite-array' },
      preview: true,
    });
    expect(r.text).toMatch(/exported 2 file/);
    expect(r.images.length).toBe(1);
    r = await t.call('export', { project: 'hero', format: 'aseprite' });
    const path = /- (\S+\.aseprite)/.exec(r.text)![1]!;
    r = await t.call('import', { path, name: 'Hero Copy' });
    expect(r.text).toMatch(/created project hero-copy/);
    r = await t.call('project_list');
    expect(r.text).toMatch(/hero-copy/);
    r = await t.call('project_duplicate', { project: 'hero', name: 'Hero 2' });
    expect(r.text).toMatch(/hero-2/);
    r = await t.call('project_delete', { project: 'hero-2', confirm: true });
    expect(r.text).toMatch(/deleted hero-2/);
  });

  it('canvas and project update', async () => {
    let r = await t.call('canvas', {
      project: 'hero-copy',
      action: 'resize',
      width: 24,
      height: 24,
      anchor: 'bottom',
    });
    expect(r.text).toMatch(/24x24/);
    r = await t.call('canvas', { project: 'hero-copy', action: 'trim' });
    expect(r.text).toMatch(/trimmed/);
    r = await t.call('project_update', {
      project: 'hero-copy',
      name: 'Hero Imported',
      colorMode: 'rgba',
      settings: { previewBackground: '#1a1c2c' },
    });
    expect(r.text).toMatch(/rgba/);
    expect(r.text).toMatch(/previewBackground #1a1c2c/);
  });

  it('errors are actionable', async () => {
    let r = await t.call('draw', { project: 'hero', ops: [{ op: 'rect', x: 0, y: 0, w: 2, h: 2, fill: 1 }] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/No layer specified/);
    expect(r.text).toMatch(/Hint: .*Body \(L1\)/);
    r = await t.call('draw', { project: 'hero', layer: 'Bdy', ops: [{ op: 'clear' }] });
    expect(r.text).toMatch(/Did you mean: Body/);
    r = await t.call('project_get', { project: 'heor' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/hero/);
    r = await t.call('draw', { project: 'hero', layer: 'Body', ops: [{ op: 'grid', rows: ['111', '11'] }] });
    expect(r.text).toMatch(/row 1 has 2/);
    r = await t.call('frame', { project: 'hero', action: 'move' });
    expect(r.text).toMatch(/needs "frame"/);
    r = await t.call('render', { project: 'hero', frame: 99 });
    expect(r.text).toMatch(/0-indexed/);
  });
});
