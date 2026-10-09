/**
 * QA recheck (D9/D11 on every REST route): out-of-range frames, bad export options and error bodies.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { draw } from '@pixelclaus/core';
import { createHttpApp, type AppServices } from '../../src/index.js';
import { services, tempDir } from '../helpers.js';

let svc: AppServices;
let server: Server;
let base: string;
let closeApp: () => Promise<void>;

beforeAll(async () => {
  svc = await services(tempDir());
  await svc.projects.create({ name: 'web', width: 8, height: 8, palette: 'pico-8', frames: 2 });
  await svc.projects.create({ name: 'rgb', width: 8, height: 8, palette: 'pico-8', colorMode: 'rgba' });
  await svc.projects.mutate('web', (doc) => draw(doc, { ops: [{ op: 'rect', x: 1, y: 1, w: 6, h: 6, fill: 9 }] }));
  await svc.projects.mutate('web', (doc) => draw(doc, { frame: 1, ops: [{ op: 'pixels', points: [[0, 0]], color: 12 }] }));
  const { app, close } = createHttpApp(svc, { viewerDir: tempDir() });
  closeApp = close;
  await new Promise<void>((r) => {
    server = app.listen(0, '127.0.0.1', () => r());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await closeApp();
  await new Promise((r) => server.close(r));
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('D9 recheck: frame parameters on every REST route', () => {
  it('frames/:frame.png rejects 2, 1.5, -1 and abc with a JSON 404 (regression guard)', async () => {
    for (const f of ['2', '1.5', '-1', 'abc']) {
      const r = await fetch(`${base}/api/projects/web/frames/${f}.png`);
      expect(r.status, f).toBe(404);
      expect((await r.json()).code, f).toBe('NOT_FOUND');
    }
  });

  it('R12: view.png?frame=99 / -5 / abc / 1.5 is reported instead of silently rendering another frame', async () => {
    for (const f of ['99', '-5', 'abc', '1.5']) {
      const r = await fetch(`${base}/api/projects/web/view.png?frame=${f}`);
      expect([400, 404], `view.png?frame=${f} returned ${r.status}`).toContain(r.status);
    }
  });

  it('R12 (minor): view.png?view=xray is rejected instead of silently returning the composite', async () => {
    const r = await fetch(`${base}/api/projects/web/view.png?view=xray`);
    expect(r.status).toBe(400);
  });

  it('export download validates frames, tags and layers (regression guard)', async () => {
    for (const [body, status] of [
      [{ format: 'png', frame: 5 }, 400],
      [{ format: 'png', frame: 1.5 }, 400],
      [{ format: 'gif', frames: [0, 9] }, 400],
      [{ format: 'spritesheet', frames: { from: 0, to: 9 } }, 400],
      [{ format: 'gif', tag: 'nope' }, 404],
      [{ format: 'png', layers: ['nope'] }, 404],
    ] as const) {
      const r = await post('/api/projects/web/export', body);
      expect(r.status, JSON.stringify(body)).toBe(status);
      expect(r.headers.get('content-type'), JSON.stringify(body)).toMatch(/json/);
    }
  });
});

describe('D11 recheck: export options never produce a 500 or a stall', () => {
  it('R13: a non-integer JPEG/WebP quality (50.5) is a 400, not "500 Internal server error"', async () => {
    for (const body of [
      { format: 'jpg', quality: 50.5 },
      { format: 'webp', quality: 50.5, lossless: false },
    ]) {
      const r = await post('/api/projects/web/export', body);
      expect(r.status, `${JSON.stringify(body)} → ${r.status} ${await r.clone().text()}`).toBe(400);
    }
  });

  it('R14: sheet.border/padding have no upper bound — a 6000 px border must be refused or cheap (< 1 s)', async () => {
    const t0 = performance.now();
    const r = await post('/api/projects/web/export', { format: 'spritesheet', sheet: { border: 6000 } });
    const ms = performance.now() - t0;
    await r.arrayBuffer();
    expect(r.status === 400 || ms < 1000, `status ${r.status} after ${Math.round(ms)} ms (event loop blocked)`).toBe(true);
  }, 60000);

  it('R14 (minor): fractional sheet geometry (padding 1.5, columns 1.5) is refused', async () => {
    for (const sheet of [{ padding: 1.5 }, { columns: 1.5, layout: 'grid' }, { extrude: 1.5 }, { border: 0.5 }]) {
      const r = await post('/api/projects/web/export', { format: 'spritesheet', sheet });
      expect(r.status, JSON.stringify(sheet)).toBe(400);
    }
  });

  it('strict schema, malformed JSON and indexed-only options are 4xx JSON (regression guard)', async () => {
    for (const [body, raw] of [
      [{ format: 'png', unknownField: 1 }, false],
      [{}, false],
      ['{bad json', true],
      ['null', true],
    ] as const) {
      const r = await fetch(`${base}/api/projects/web/export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw ? (body as string) : JSON.stringify(body),
      });
      expect(r.status, String(raw ? body : JSON.stringify(body))).toBe(400);
      expect(r.headers.get('content-type')).toMatch(/json/);
    }
    const r = await post('/api/projects/rgb/export', { format: 'png', paletteVariants: [{ name: 'x', palette: 'pico-8' }] });
    expect(r.status).toBe(400);
  });
});

describe('R15: REST error bodies', () => {
  it('a missing export file is a plain JSON 404 without a JSON-RPC envelope or absolute server paths', async () => {
    const r = await fetch(`${base}/api/projects/web/exports/missing.png`);
    expect(r.status).toBe(404);
    const body = await r.text();
    expect(body).not.toMatch(/jsonrpc|-32700/);
    expect(body).not.toContain(svc.config.dataDir);
  });

  it('(minor) unknown /api routes answer JSON, not an HTML "Cannot GET" page', async () => {
    const r = await fetch(`${base}/api/nothing-here`);
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toMatch(/json/);
  });

  it('(minor) listing exports of a project that does not exist is a 404, not []', async () => {
    const r = await fetch(`${base}/api/projects/no-such-project/exports`);
    expect(r.status).toBe(404);
  });
});
