import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { mcpClient, type TestClient } from './helpers.js';

describe('loadConfig numeric validation', () => {
  it('accepts valid values and defaults', () => {
    expect(loadConfig({}, {}).port).toBe(7420);
    expect(loadConfig({}, { PIXELCLAUS_PORT: '8080', PIXELCLAUS_CACHE: '2' })).toMatchObject({
      port: 8080,
      cacheSize: 2,
    });
  });

  it('rejects non-numeric or out-of-range values with a clear message', () => {
    expect(() => loadConfig({}, { PIXELCLAUS_PORT: 'abc' })).toThrow(/Invalid port 'abc'/);
    expect(() => loadConfig({}, { PIXELCLAUS_PORT: '70000' })).toThrow(/0\.\.65535/);
    expect(() => loadConfig({}, { PIXELCLAUS_CACHE: '0' })).toThrow(/cache size/);
  });
});

describe('draw replies and previews', () => {
  let t: TestClient;
  beforeAll(async () => {
    t = await mcpClient();
    await t.call('project_create', { name: 'r', width: 16, height: 16, palette: 'pico-8', frames: 3 });
  });
  afterAll(() => t.close());

  it('small batches list every op', async () => {
    const r = await t.call('draw', {
      project: 'r',
      ops: [
        { op: 'pixels', points: [[0, 0]], color: 8 },
        { op: 'pixels', points: [[1, 0]], color: 9 },
      ],
    });
    expect(r.text).toMatch(/- \[0\] pixels/);
    expect(r.text).toMatch(/- \[1\] pixels/);
  });

  it('large batches are grouped by op and target, notes are kept', async () => {
    const ops: Record<string, unknown>[] = Array.from({ length: 120 }, (_, i) => ({
      op: 'pixels',
      points: [[i % 16, (i >> 4) % 16]],
      color: 2 + (i % 3),
    }));
    ops.push({ op: 'rect', x: 0, y: 0, w: 1, h: 1, fill: 0, frame: 1 }); // erases nothing on an empty frame → note
    const r = await t.call('draw', { project: 'r', ops });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/pixels .*×120/);
    expect(r.text).toMatch(/\[120\] rect/);
    expect(r.text).not.toMatch(/- \[5\] pixels/);
    expect(r.text.length).toBeLessThan(1500);
  });

  it('preview shows the frame of the last op that changed pixels', async () => {
    const r = await t.call('draw', {
      project: 'r',
      frame: 0,
      ops: [{ op: 'rect', frame: 2, x: 4, y: 4, w: 8, h: 8, fill: 12 }],
      preview: true,
    });
    const f2 = await t.call('render', { project: 'r', frame: 2, maxSize: 512 });
    expect(r.images).toHaveLength(1);
    expect(r.images[0]).toBe(f2.images[0]);
  });
});

describe('import robustness', () => {
  let t: TestClient;
  beforeAll(async () => {
    t = await mcpClient();
    await t.call('project_create', { name: 'imp', width: 8, height: 8, palette: 'pico-8' });
  });
  afterAll(() => t.close());

  it('warns when imported colours are snapped to the palette', async () => {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 10, g: 200, b: 190, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const r = await t.call('import', { data: png.toString('base64'), filename: 'teal.png', project: 'imp' });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/not in the palette; 4 pixel\(s\) were snapped/);
  });

  it('exact palette colours import without a snap warning', async () => {
    // pico-8 red #ff004d
    const png = await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 0, b: 77, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const r = await t.call('import', { data: png.toString('base64'), filename: 'red.png', project: 'imp' });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).not.toMatch(/snapped/);
  });

  it('undecodable payloads give INVALID_ARGUMENT with a hint', async () => {
    const r = await t.call('import', {
      data: Buffer.from('definitely not pixels').toString('base64'),
      filename: 'x.png',
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Could not decode 'x\.png' as an image/);
    expect(r.text).toMatch(/Supported: PNG/);
    expect(r.text).not.toMatch(/INTERNAL/);
  });

  it('broken .aseprite files are reported cleanly', async () => {
    const r = await t.call('import', {
      data: Buffer.from('nope').toString('base64'),
      filename: 'broken.aseprite',
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/as an \.aseprite file/);
  });
});
