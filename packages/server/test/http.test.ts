import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { draw } from '@pixelclaus/core';
import { createHttpApp, type AppServices } from '../src/index.js';
import { services, tempDir } from './helpers.js';

let svc: AppServices;
let server: Server;
let base: string;
let closeApp: () => Promise<void>;

beforeAll(async () => {
  svc = await services(tempDir());
  await svc.projects.create({ name: 'web', width: 8, height: 8, palette: 'pico-8', frames: 2 });
  await svc.projects.mutate('web', (doc) =>
    draw(doc, { ops: [{ op: 'rect', x: 1, y: 1, w: 6, h: 6, fill: 9 }] }),
  );
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

describe('REST API', () => {
  it('lists and describes projects', async () => {
    const list = await (await fetch(`${base}/api/projects`)).json();
    expect(list[0].id).toBe('web');
    const p = await (await fetch(`${base}/api/projects/web`)).json();
    expect(p.width).toBe(8);
    expect(p.layers[0].name).toBe('Layer 1');
    expect(p.paletteColors.length).toBe(17);
    const missing = await fetch(`${base}/api/projects/nope`);
    expect(missing.status).toBe(404);
  });

  it('serves images', async () => {
    const thumb = await fetch(`${base}/api/projects/web/thumbnail.png`);
    expect(thumb.headers.get('content-type')).toMatch(/png/);
    const frame = await fetch(`${base}/api/projects/web/frames/0.png?scale=4`);
    expect(frame.status).toBe(200);
    const buf = new Uint8Array(await frame.arrayBuffer());
    expect(buf[1]).toBe(0x50);
    const layer = await fetch(`${base}/api/projects/web/frames/1.png?layers=L1&bg=%23000000`);
    expect(layer.status).toBe(200);
    const view = await fetch(`${base}/api/projects/web/view.png?view=filmstrip`);
    expect(view.status).toBe(200);
  });

  it('exports downloads and lists export files', async () => {
    const res = await fetch(`${base}/api/projects/web/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'gif', scale: 2 }),
    });
    expect(res.headers.get('content-disposition')).toMatch(/web@2x\.gif/);
    const bad = await fetch(`${base}/api/projects/web/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'bmp' }),
    });
    expect(bad.status).toBe(400);
    await svc.exporter.export('web', { format: 'png' });
    const files = await (await fetch(`${base}/api/projects/web/exports`)).json();
    expect(files[0].name).toBe('web-f0.png');
    const dl = await fetch(`${base}/api/projects/web/exports/web-f0.png`);
    expect(dl.status).toBe(200);
  });

  it('rejects foreign Host headers (DNS rebinding protection)', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(`${base}/api/projects`);
      const req = request(
        { host: u.hostname, port: u.port, path: u.pathname, headers: { host: 'evil.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('deletes projects', async () => {
    await svc.projects.create({ name: 'tmp', width: 2, height: 2 });
    const res = await fetch(`${base}/api/projects/tmp`, { method: 'DELETE' });
    expect((await res.json()).deleted).toBe('tmp');
  });
});

describe('MCP over Streamable HTTP', () => {
  it('initialises a session and calls tools', async () => {
    const client = new Client({ name: 'http-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(24);
    const r = (await client.callTool({ name: 'project_list', arguments: {} })) as {
      content: Array<{ text: string }>;
    };
    expect(r.content[0]!.text).toMatch(/web/);
    await client.close();
  });

  it('rejects requests without a session', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(400);
  });
});
