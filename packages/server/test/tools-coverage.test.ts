import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mcpClient, type TestClient } from './helpers.js';

let t: TestClient;
const P = 'cov';
async function ok(name: string, args: Record<string, unknown>, match?: RegExp): Promise<string> {
  const r = await t.call(name, { project: P, ...args });
  expect(r.isError, `${name} ${JSON.stringify(args)} → ${r.text}`).toBe(false);
  if (match) expect(r.text).toMatch(match);
  return r.text;
}

beforeAll(async () => {
  t = await mcpClient();
  await t.call('project_create', {
    name: P,
    width: 16,
    height: 16,
    palette: 'pico-8',
    frames: 4,
    layers: ['A', 'B'],
  });
  await t.call('draw', {
    project: P,
    layer: 'A',
    ops: [{ op: 'rect', x: 2, y: 2, w: 8, h: 8, fill: 9, color: 1 }],
  });
});
afterAll(async () => t.close());

describe('palette tool actions', () => {
  it('covers every action', async () => {
    await ok('palette', { action: 'presets' }, /pico-8 \(16\)/);
    await ok(
      'palette',
      { action: 'add', colors: ['#123456', '#abcdef'], names: ['navy', 'sky'] },
      /indices 17,18/,
    );
    await ok(
      'palette',
      { action: 'set_colors', entries: [{ index: 17, color: '#223344', name: 'deep' }] },
      /updated 1/,
    );
    await ok('palette', { action: 'set_ramps', ramps: [{ name: 'blue', indices: [17, 18] }] }, /set 1 ramp/);
    await ok('palette', { action: 'sort', by: 'hue' }, /sorted/);
    await ok('palette', { action: 'auto_ramps' }, /ramps:/);
    await ok('palette', { action: 'remap', mapping: { '1': 2 } }, /remapped/);
    await ok('palette', { action: 'adjust', hue: 10, indices: [3] }, /adjusted 1/);
    await ok('palette', { action: 'remove', indices: [18] }, /removed 1/);
    await ok('palette', { action: 'generate_ramp', base: '#40c040', steps: 3, add: false }, /not added/);
    await ok('palette', { action: 'load_preset', name: 'db32', strategy: 'nearest' }, /loaded db32/);
    await ok(
      'palette',
      { action: 'set', colors: ['#000000', '#ff0000', '#ffffff'], strategy: 'nearest' },
      /3 colours/,
    );
    await ok('palette', { action: 'get' }, /3 colours/);
    // every pixel is now red (nearest match of the old colours) → extract keeps 1 colour
    await ok('palette', { action: 'extract' }, /extracted palette \(1 colours\)/);
    await ok('palette', { action: 'load_preset', name: 'pico-8', strategy: 'nearest' });
  });
});

describe('select tool actions', () => {
  it('covers shapes and modifiers', async () => {
    await ok('select', { action: 'rect', x: 0, y: 0, w: 4, h: 4 }, /16 px/);
    await ok('select', { action: 'ellipse', x: 0, y: 0, w: 6, h: 6, mode: 'add' });
    await ok('select', {
      action: 'polygon',
      points: [
        [0, 0],
        [8, 0],
        [0, 8],
      ],
      name: 'tri',
    });
    await ok('select', { action: 'color', color: 9, layer: 'A', name: 'red' });
    await ok('select', { action: 'alpha', layer: 'A', name: 'opaque' }, /64 px/);
    await ok('select', { action: 'all', name: 'every' }, /256 px/);
    await ok('select', { action: 'invert', name: 'opaque' }, /192 px/);
    await ok('select', { action: 'grow', name: 'red', amount: 1 });
    await ok('select', { action: 'shrink', name: 'red', amount: 1 });
    await ok('select', { action: 'border', name: 'every', amount: 1 }, /60 px/);
    await ok('select', { action: 'move', name: 'tri', dx: 2, dy: 2 });
    await ok('select', { action: 'combine', name: 'tri', other: 'red', mode: 'intersect' });
    await ok('select', { action: 'rename', name: 'tri', newName: 'triangle' });
    await ok('select', { action: 'delete', name: 'triangle' });
    await ok('select', { action: 'none', name: 'empty' }, /0 px/);
    await ok('select', { action: 'list' }, /every: 60 px/);
    await ok(
      'draw',
      { layer: 'B', clip: 'every', ops: [{ op: 'rect', x: 0, y: 0, w: 16, h: 16, fill: 1 }] },
      /60 px changed/,
    );
  });
});

describe('structure tool actions', () => {
  it('layers', async () => {
    await ok('layer', { action: 'add', name: 'Top', above: 'B' }, /L3 "Top"/);
    await ok('layer', { action: 'move', layer: 'Top', index: 0 }, /moved/);
    await ok('layer', { action: 'duplicate', layer: 'A', name: 'A2' }, /"A2"/);
    await ok('layer', { action: 'merge_down', layer: 'A2' }, /merged/);
    await ok('layer', { action: 'remove', layer: 'Top' }, /removed L3/);
  });
  it('frames, cels, tags, slices, canvas, transform', async () => {
    await ok('frame', { action: 'add', at: 1, count: 1, cels: 'link' }, /5 frame/);
    await ok('frame', { action: 'move', frame: 0, to: 2 }, /moved frame 0/);
    await ok('frame', { action: 'reverse', from: 0, to: 2 }, /reversed/);
    await ok('frame', { action: 'notes', frame: 0, notes: 'contact' });
    await ok('frame', { action: 'duration', fps: 10 }, /0:100/);
    await ok('frame', { action: 'remove', frames: [4] }, /removed 1/);
    await ok('cel', { action: 'link', layer: 'A', frames: 'all' }, /linked 4/);
    await ok(
      'cel',
      { action: 'unlink', layer: 'A', frames: 'all' },
      /unlinked 3/ /* the last one is already unique */,
    );
    await ok('cel', { action: 'opacity', layer: 'A', frames: [0], opacity: 200 }, /1 cel/);
    await ok('cel', { action: 'copy', layer: 'A', frame: 0, toLayer: 'B', toFrame: 3 }, /copied/);
    await ok('cel', { action: 'clear', layer: 'B', frames: [3] }, /cleared 1/);
    await ok('cel', { action: 'move', layer: 'A', frames: [3], x: 3, y: 0 }, /moved 1/);
    await ok('cel', { action: 'tween', layer: 'A', from: 0, to: 3, ease: 'ease-in-out' }, /tweened 2/);
    await ok('tag', { action: 'add', name: 'run', from: 0, to: 3 });
    await ok(
      'tag',
      { action: 'update', name: 'run', newName: 'dash', direction: 'reverse', repeat: 2 },
      /dash 0-3 reverse/,
    );
    await ok('tag', { action: 'list' }, /dash 0-3 reverse ×2/);
    await ok('tag', { action: 'remove', name: 'dash' });
    await ok('slice', {
      action: 'set',
      name: 'ui',
      bounds: { x: 0, y: 0, w: 12, h: 12 },
      center: { x: 4, y: 4, w: 4, h: 4 },
    });
    await ok('slice', { action: 'list' }, /ui: f0 0,0 12x12 center 4,4 4x4/);
    await ok('slice', { action: 'remove', name: 'ui' });
    await ok('transform', { scope: 'layer', layer: 'A', op: 'rotate', angle: 30 }, /rotate applied/);
    await ok('transform', { scope: 'sprite', op: 'flip_v' }, /flip_v applied/);
    await ok(
      'transform',
      { scope: 'cel', layer: 'A', frames: [0], op: 'scale', factor: 2, method: 'scale2x' },
      /scale applied/,
    );
    await ok('transform', { scope: 'layer', layer: 'A', op: 'offset', dx: 8, dy: 8 }, /offset applied/);
    await ok('canvas', { action: 'crop', rect: { x: 0, y: 0, w: 12, h: 12 } }, /12x12/);
    await ok('canvas', { action: 'scale', factor: 2 }, /24x24/);
    await ok('layer', { action: 'flatten' }, /flattened/);
  });
});
