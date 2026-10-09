/**
 * QA: REST API with bad inputs and MCP over Streamable HTTP with concurrent sessions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import sharp from 'sharp';
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

const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('REST: bad ids and parameters', () => {
  it('invalid / traversal ids are rejected with JSON errors', async () => {
    for (const id of ['..', '..%2F..%2Fetc', 'UPPER', 'a%00b', '%2e%2e']) {
      const r = await fetch(`${base}/api/projects/${id}`);
      expect([400, 404], id).toContain(r.status);
      expect(r.headers.get('content-type'), id).toMatch(/json|html/);
    }
    const r = await fetch(`${base}/api/projects/does-not-exist`);
    expect(r.status).toBe(404);
    expect((await r.json()).code).toBe('NOT_FOUND');
  });

  it('frame index out of range is reported, not silently clamped to the last frame', async () => {
    const f1 = Buffer.from(await (await fetch(`${base}/api/projects/web/frames/1.png`)).arrayBuffer());
    const r = await fetch(`${base}/api/projects/web/frames/99.png`);
    const f99 = Buffer.from(await r.arrayBuffer());
    // today 99 → frame 1 (clamped) with status 200
    expect(r.status === 400 || r.status === 404 || !f99.equals(f1)).toBe(true);
  });

  it('frame "abc" / negative / huge scale do not crash', async () => {
    for (const q of ['frames/abc.png', 'frames/-3.png', 'frames/0.png?scale=99999', 'frames/0.png?layers=nope', 'view.png?view=xray', 'view.png?tag=missing']) {
      const r = await fetch(`${base}/api/projects/web/${q}`);
      expect(r.status, q).toBeLessThan(500);
    }
  });

  it('unknown layer in ?layers= returns a 4xx JSON error with a hint', async () => {
    const r = await fetch(`${base}/api/projects/web/frames/0.png?layers=Nope`);
    expect(r.status).toBe(404);
    const j = await r.json();
    expect(j.hint).toMatch(/Available/);
  });

  it('export download: invalid formats and malformed options are 4xx JSON, never 500 stack traces', async () => {
    const bodies: unknown[] = [
      { format: 'bmp' },
      {},
      { format: 'png', scale: 2.5 },
      { format: 'png', frame: 50 },
      { format: 'gif', tag: 'nope' },
      { format: 'webp', quality: 500 },
      { format: 'png', layers: 'L1' },
      { format: 'png', paletteVariants: 'x' },
      { format: 'spritesheet', sheet: { layout: 'diagonal' } },
      { format: 'png', background: 'not-a-colour' },
    ];
    const problems: string[] = [];
    for (const b of bodies) {
      const r = await post('/api/projects/web/export', b);
      const text = (await r.text()).replace(/[^\x20-\x7e]+/g, ' ');
      const stack = /at .*\.(ts|js):\d+/.test(text);
      if (r.status < 400 || r.status >= 500 || stack) problems.push(`${JSON.stringify(b)} → ${r.status}${stack ? ' (stack trace)' : ''} ${text.slice(0, 90)}`);
    }
    expect(problems).toEqual([]);
  });

  it('export download ignores outputDir and sanitises filename (no path traversal)', async () => {
    const r = await post('/api/projects/web/export', { format: 'png', outputDir: '/tmp', filename: '../../../etc/passwd' });
    expect(r.status).toBe(200);
    const cd = r.headers.get('content-disposition')!;
    expect(cd).not.toMatch(/[/\\]/);
    const png = Buffer.from(await r.arrayBuffer());
    expect((await sharp(png).metadata()).width).toBe(8);
  });

  it('multi-file export downloads as a zip', async () => {
    const r = await post('/api/projects/web/export', { format: 'frames' });
    expect(r.headers.get('content-type')).toMatch(/zip/);
    const b = Buffer.from(await r.arrayBuffer());
    expect(b.subarray(0, 2).toString()).toBe('PK');
  });

  it('exports file listing / download rejects traversal names', async () => {
    await svc.exporter.export('web', { format: 'png' });
    for (const name of ['..%2Fproject.json', '..%5Cproject.json', '.hidden', 'nope.png']) {
      const r = await fetch(`${base}/api/projects/web/exports/${name}`);
      expect(r.status, name).toBeGreaterThanOrEqual(400);
      expect(r.status, name).toBeLessThan(500);
    }
  });

  it('DELETE of a bad id is a 4xx', async () => {
    const r = await fetch(`${base}/api/projects/..`, { method: 'DELETE' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    const r2 = await fetch(`${base}/api/projects/ghost`, { method: 'DELETE' });
    expect(r2.status).toBe(404);
  });

  it('health and formats endpoints', async () => {
    expect((await (await fetch(`${base}/api/health`)).json()).ok).toBe(true);
    const f = await (await fetch(`${base}/api/formats`)).json();
    expect(f.export).toContain('spritesheet');
  });
});

describe('MCP over Streamable HTTP', () => {
  async function connect(name: string): Promise<Client> {
    const c = new Client({ name, version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    return c;
  }
  const text = (r: unknown) => ((r as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? '').join('\n'));

  it('two concurrent sessions mutate the same project without lost updates', async () => {
    const [a, b] = await Promise.all([connect('a'), connect('b')]);
    await a.callTool({ name: 'project_create', arguments: { name: 'shared', width: 16, height: 2, palette: 'pico-8' } });
    const calls = Array.from({ length: 16 }, (_, i) =>
      (i % 2 ? a : b).callTool({ name: 'draw', arguments: { project: 'shared', ops: [{ op: 'pixels', points: [[i, 0]], color: 8 }] } }),
    );
    const results = await Promise.all(calls);
    const revs = results.map((r) => Number(/rev (\d+)/.exec(text(r))![1]));
    expect(new Set(revs).size).toBe(16);
    const rp = text(await b.callTool({ name: 'read_pixels', arguments: { project: 'shared', region: { x: 0, y: 0, w: 16, h: 1 } } }));
    expect(rp).toMatch(/0\| 8{16}/);
    await Promise.all([a.close(), b.close()]);
  });

  it('a session sees changes made by another session (no stale cache)', async () => {
    const [a, b] = await Promise.all([connect('a2'), connect('b2')]);
    await a.callTool({ name: 'project_create', arguments: { name: 'seen', width: 4, height: 4, palette: 'pico-8' } });
    await b.callTool({ name: 'draw', arguments: { project: 'seen', ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] } });
    const r = text(await a.callTool({ name: 'read_pixels', arguments: { project: 'seen' } }));
    expect(r).toMatch(/0\| 8\.\.\./);
    // undo history is shared per project (not per session) — document the behaviour
    const u = text(await a.callTool({ name: 'history', arguments: { project: 'seen', action: 'undo' } }));
    expect(u).toMatch(/undid: Draw 1 op/);
    await Promise.all([a.close(), b.close()]);
  });

  it('unknown session ids get 404, missing session 400, GET without session 400', async () => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'nope' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(r.status).toBe(404);
    const g = await fetch(`${base}/mcp`);
    expect(g.status).toBe(400);
  });

  it('closing a session frees it (DELETE /mcp) and the id is no longer valid', async () => {
    const c = new Client({ name: 'closer', version: '1' });
    const tr = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    await c.connect(tr);
    const sid = tr.sessionId!;
    await tr.terminateSession();
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    expect(r.status).toBe(404);
  });

  it('malformed JSON body is a 4xx', async () => {
    const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc": "2.0", ' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(await r.text()).not.toMatch(/at .*\.(ts|js):\d+/);
  });
});
