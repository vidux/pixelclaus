import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { draw } from '@pixelclaus/core';
import { createHttpApp, type AppServices } from '../src/index.js';
import { mcpClient, services, tempDir, type TestClient } from './helpers.js';

const CLI_SRC = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function cli(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', CLI_SRC, ...args],
      { cwd: ROOT, timeout: 20000 },
      (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
    );
  });
}

describe('uniform MCP error format', () => {
  let t: TestClient;
  beforeAll(async () => {
    t = await mcpClient();
    await t.call('project_create', { name: 'e', width: 8, height: 8 });
  });
  afterAll(() => t.close());

  it('schema validation errors look like every other tool error', async () => {
    const r = await t.call('draw', { project: 'e', ops: [{ op: 'fill', x: 1.5, y: 0, color: 2 }] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^Error \[INVALID_ARGUMENT\]: .*whole number.*ops\[0\]\.x/);
    expect(r.text).toMatch(/Hint:/);
    expect(r.text).not.toMatch(/MCP error -32602/);
  });

  it('integer fields are published as {"type":"integer"} without huge bounds', async () => {
    const { tools } = await t.client.listTools();
    const exp = tools.find((x) => x.name === 'export')!;
    const scale = (exp.inputSchema.properties as Record<string, Record<string, unknown>>).scale!;
    expect(scale.type).toBe('integer');
    expect(JSON.stringify(tools)).not.toMatch(/9007199254740991/);
  });
});

describe('export path safety with symlinks', () => {
  it('an outputDir symlinked into another project is refused', async () => {
    const dir = tempDir();
    const s = await services(dir);
    await s.projects.create({ name: 'mine', width: 4, height: 4 });
    await s.projects.create({ name: 'victim', width: 4, height: 4 });
    const link = join(tempDir(), 'sneaky');
    symlinkSync(join(dir, 'projects', 'victim'), link, 'junction'); // junction: Windows needs no admin rights (ignored elsewhere)
    await expect(
      s.exporter.export('mine', { format: 'png', outputDir: link, filename: 'project' }),
    ).rejects.toThrow(/inside the PixelClaus projects folder/);
    expect(JSON.parse(readFileSync(join(dir, 'projects', 'victim', 'project.json'), 'utf8')).format).toBe(
      'pixelclaus-project',
    );
  });
});

describe('palette imports', () => {
  it('a 256-colour .act is fitted to 255 entries with a warning', async () => {
    const dir = tempDir();
    const s = await services(dir);
    const act = new Uint8Array(768);
    for (let i = 0; i < 256; i++) act.set([i, 255 - i, (i * 7) & 255], i * 3);
    writeFileSync(join(dir, 'std.act'), act);
    const r = await s.importer.import({ path: join(dir, 'std.act') });
    expect(r.created).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/kept the first 255/);
  });

  it('GPL names survive; files without colours are rejected and leave the art alone', async () => {
    const dir = tempDir();
    const s = await services(dir);
    await s.projects.create({ name: 'art', width: 4, height: 4, palette: 'pico-8' });
    await s.projects.mutate('art', (d) =>
      draw(d, { ops: [{ op: 'rect', x: 0, y: 0, w: 4, h: 4, fill: 9 }] }),
    );
    writeFileSync(join(dir, 'named.gpl'), 'GIMP Palette\nName: Named\n#\n255 0 0\tFire Red\n0 255 0\tLeaf\n');
    writeFileSync(join(dir, 'empty.hex'), '\n\n');
    await s.importer.import({ project: 'art', path: join(dir, 'named.gpl') });
    const names = await s.projects.read('art', (d) => d.state.palette.names);
    expect(names.value).toEqual({ '1': 'Fire Red', '2': 'Leaf' });
    await expect(s.importer.import({ project: 'art', path: join(dir, 'empty.hex') })).rejects.toThrow(
      /No colours found/,
    );
    const pal = await s.projects.read('art', (d) => d.state.palette.colors.length - 1);
    expect(pal.value).toBe(2);
  });
});

describe('checkpoints', () => {
  it('blank names are refused; a missing checkpoint file leaves no backup behind', async () => {
    const dir = tempDir();
    const s = await services(dir);
    await s.projects.create({ name: 'k', width: 4, height: 4 });
    await expect(s.projects.createCheckpoint('k', '  ')).rejects.toThrow(/empty/);
    const cp = await s.projects.createCheckpoint('k', 'base');
    const file = join(dir, 'projects', 'k', 'checkpoints', `${cp.id}.pxc`);
    expect(existsSync(file)).toBe(true);
    writeFileSync(file, ''); // corrupt it
    await expect(s.projects.restoreCheckpoint('k', 'base')).rejects.toThrow(/nothing was changed/);
    expect((await s.projects.listCheckpoints('k')).map((c) => c.name)).toEqual(['base']);
  });
});

describe('REST hardening', () => {
  let svc: AppServices;
  let server: Server;
  let base: string;
  beforeAll(async () => {
    svc = await services(tempDir());
    await svc.projects.create({ name: 'web', width: 8, height: 8, frames: 2 });
    const { app } = createHttpApp(svc, { viewerDir: tempDir() });
    await new Promise<void>((r) => {
      server = app.listen(0, '127.0.0.1', () => r());
    });
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it('view.png validates frame and view', async () => {
    expect((await fetch(`${base}/api/projects/web/view.png?frame=1`)).status).toBe(200);
    expect((await fetch(`${base}/api/projects/web/view.png?frame=9`)).status).toBe(404);
    expect((await fetch(`${base}/api/projects/web/view.png?frame=1.5`)).status).toBe(404);
    expect((await fetch(`${base}/api/projects/web/view.png?view=xray`)).status).toBe(400);
  });

  it('unknown API routes, missing projects and missing files are JSON 404s without server paths', async () => {
    for (const path of [
      '/api/nope',
      '/api/projects/ghost/exports',
      '/api/projects/web/exports/missing.png',
    ]) {
      const r = await fetch(base + path);
      expect(r.status, path).toBe(404);
      expect(r.headers.get('content-type'), path).toMatch(/json/);
      const body = await r.text();
      expect(body, path).not.toContain(svc.config.dataDir);
      expect(body, path).not.toMatch(/jsonrpc/);
    }
  });

  it('malformed JSON on REST is a plain 400', async () => {
    const r = await fetch(`${base}/api/projects/web/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'Malformed JSON body' });
  });
});

describe('CLI flag parsing', () => {
  it('rejects unknown flags with a suggestion, missing values, and honours --flag=value', async () => {
    const typo = await cli(['info', '--restrict-path']);
    expect(typo.code).toBe(2);
    expect(typo.out).toMatch(/did you mean --restrict-paths/);
    expect((await cli(['info', '--data'])).code).toBe(2);
    const dir = join(tempDir(), 'x');
    mkdirSync(dir);
    const ok = await cli(['info', `--data=${dir}`, '--port=8123']);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out.slice(ok.out.indexOf('{')))).toMatchObject({ dataDir: dir, port: 8123 });
  }, 60000);
});

describe('generated docs stay in sync (run `npm run docs` after changing tools or guides)', () => {
  const docs = fileURLToPath(new URL('../../../docs/', import.meta.url));

  it('docs/mcp-tools.md has a section for every tool', async () => {
    const t = await mcpClient();
    const { tools } = await t.client.listTools();
    await t.close();
    const md = readFileSync(join(docs, 'mcp-tools.md'), 'utf8');
    for (const tool of tools) expect(md, tool.name).toContain(`\n## ${tool.name}\n`);
    for (const tool of tools)
      expect(md, `${tool.name} description`).toContain(tool.description!.slice(0, 120));
  });

  it('docs/guides/*.md match the in-tool guide text', async () => {
    const { GUIDE } = await import('../src/mcp/guide.js');
    for (const [topic, text] of Object.entries(GUIDE)) {
      expect(readFileSync(join(docs, 'guides', `${topic}.md`), 'utf8').trim(), topic).toBe(text.trim());
    }
  });
});
