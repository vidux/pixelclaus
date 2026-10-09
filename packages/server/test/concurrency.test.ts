/**
 * Several agents (6-7 Claude sessions / subagents) using ONE PixelClaus server at the same time, each
 * building its own asset. They must not block each other, collide on project ids, or lose each other's
 * work or undo history.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { draw } from '@pixelclaus/core';
import { createHttpApp, createMcpServer, type AppServices } from '../src/index.js';
import { services, tempDir } from './helpers.js';

interface Agent {
  name: string;
  call: (
    tool: string,
    args?: Record<string, unknown>,
  ) => Promise<{ text: string; images: string[]; ms: number }>;
  close: () => Promise<void>;
}

/** One MCP session on a shared server (what each Claude subagent / session gets). */
async function connect(svc: AppServices, name: string): Promise<Agent> {
  const server = createMcpServer(svc);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name, version: '1' });
  await client.connect(b);
  return {
    name,
    call: async (tool, args = {}) => {
      const t0 = performance.now();
      const raw = (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
      const ms = performance.now() - t0;
      const text = raw.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as { text: string }).text)
        .join('\n');
      if (raw.isError) throw new Error(`${name} ${tool}: ${text}`);
      const images = raw.content.filter((c) => c.type === 'image').map((c) => (c as { data: string }).data);
      return { text, images, ms };
    },
    close: () => client.close(),
  };
}

const AGENTS = 7;

/** A realistic per-agent asset build: frames, previews, analysis, several exports. */
async function buildAsset(agent: Agent, project: string, size: number, frames: number, color: number) {
  await agent.call('project_create', {
    name: project,
    width: size,
    height: size,
    frames,
    layers: ['Body', 'FX'],
  });
  for (let f = 0; f < frames; f++) {
    await agent.call('draw', {
      project,
      layer: 'Body',
      frame: f,
      ops: [
        { op: 'rect', x: 0, y: 0, w: size, h: size, fill: color },
        { op: 'ellipse', x: 2 + (f % 4), y: 4, w: size - 8, h: size - 8, fill: color + 1, color: 26 },
        { op: 'outline', color: 26, side: 'inside' },
      ],
      preview: f === 0,
    });
  }
  await agent.call('tag', { project, action: 'add', name: 'loop', from: 0, to: frames - 1 });
  await agent.call('render', { project, view: 'filmstrip', tag: 'loop' });
  await agent.call('analyze', { project, kind: 'lint' });
  await agent.call('export', { project, format: 'gif', tag: 'loop', scale: 4 });
  await agent.call('export', { project, format: 'spritesheet', scale: 2 });
}

describe('concurrent agents on one server', () => {
  let svc: AppServices;
  let agents: Agent[];

  beforeAll(async () => {
    svc = await services(tempDir());
    agents = await Promise.all(Array.from({ length: AGENTS }, (_, i) => connect(svc, `agent${i}`)));
  });
  afterAll(async () => {
    await Promise.all(agents.map((a) => a.close()));
  });

  it('7 agents creating "Hero" at once: exactly one gets it, the others get CONFLICT with a way out', async () => {
    const settled = await Promise.allSettled(
      agents.map((a) => a.call('project_create', { name: 'Hero', width: 8, height: 8 })),
    );
    const ok = settled.filter((r) => r.status === 'fulfilled');
    const refused = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(AGENTS - 1);
    for (const r of refused) {
      expect(String(r.reason)).toMatch(/CONFLICT.*already exists \(id 'hero'\)/s);
      expect(String(r.reason)).toMatch(/another name \(e\.g\. "Hero 2"\)|ifExists/);
    }
    expect((await svc.projects.list()).filter((p) => p.name === 'Hero')).toHaveLength(1);
  });

  it('with ifExists:"suffix" the same race yields 7 separate projects, each told its exact id', async () => {
    const results = await Promise.all(
      agents.map((a) =>
        a.call('project_create', { name: 'Villain', width: 8, height: 8, ifExists: 'suffix' }),
      ),
    );
    const ids = results.map((r) => /id=(\S+)/.exec(r.text)![1]);
    expect(new Set(ids).size, ids.join(',')).toBe(AGENTS);
    expect(results.filter((r) => /NOTE: 'villain' was taken/.test(r.text))).toHaveLength(AGENTS - 1);
  });

  it('7 agents build their own assets concurrently; every project contains only its own work', async () => {
    await Promise.all(agents.map((a, i) => buildAsset(a, `own-${i}`, 32, 4, 2 + i * 3)));
    for (let i = 0; i < AGENTS; i++) {
      const r = await svc.projects.read(`own-${i}`, (doc) => ({
        frames: doc.state.frames.length,
        tags: doc.state.tags.map((t) => t.name),
        corner: doc.image(doc.state.cels.find((c) => c.frame === 0 && c.layerId === 'L1')!.imageId).get(1, 1),
      }));
      expect(r.value).toEqual({ frames: 4, tags: ['loop'], corner: 2 + i * 3 });
    }
  }, 120_000);

  it('a light call stays fast while the other agents run heavy renders, lint and exports', async () => {
    const heavy = agents.slice(1);
    await Promise.all(
      heavy.map((a, i) =>
        a.call('project_create', { name: `big-${i}`, width: 128, height: 128, frames: 12 }),
      ),
    );
    await Promise.all(
      heavy.map((a, i) =>
        a.call('draw', {
          project: `big-${i}`,
          ops: Array.from({ length: 12 }, (_, f) => ({
            op: 'gradient',
            frame: f,
            from: [0, 0],
            to: [128, 128],
            colors: [12, 13, 14, 15],
          })),
        }),
      ),
    );
    const probe = agents[0]!;
    await probe.call('project_create', { name: 'probe', width: 16, height: 16 });

    let done = false;
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const work = Promise.all(
      heavy.map(async (a, i) => {
        for (let k = 0; k < 1; k++) {
          await a.call('export', { project: `big-${i}`, format: 'gif', scale: 4 });
          await a.call('analyze', { project: `big-${i}`, kind: 'lint' });
          await a.call('render', { project: `big-${i}`, view: 'filmstrip' });
        }
      }),
    ).finally(() => (done = true));
    const latencies: number[] = [];
    while (!done) {
      latencies.push((await probe.call('project_get', { project: 'probe' })).ms);
      latencies.push(
        (await probe.call('draw', { project: 'probe', ops: [{ op: 'pixels', points: [[1, 1]], color: 3 }] }))
          .ms,
      );
      await new Promise((r) => setTimeout(r, 20));
    }
    await work;
    loop.disable();
    const maxStallMs = loop.max / 1e6;
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)]!;
    // before the compute pool: the event loop froze for 1-4 s per export and probes waited behind it
    expect(maxStallMs, `event loop stalled ${maxStallMs.toFixed(0)} ms`).toBeLessThan(400);
    expect(p95, `probe p95 ${p95.toFixed(0)} ms over ${latencies.length} calls`).toBeLessThan(400);
  }, 180_000);

  it('undo history survives when agents touch more projects than the cache size', async () => {
    // helpers use cacheSize 4; 7 agents keep 7+ projects busy
    await Promise.all(
      agents.map((a, i) => a.call('project_create', { name: `undo-${i}`, width: 8, height: 8 })),
    );
    for (let round = 0; round < 3; round++) {
      await Promise.all(
        agents.map((a, i) =>
          a.call('draw', {
            project: `undo-${i}`,
            ops: [{ op: 'pixels', points: [[round, 0]], color: 2 + round }],
          }),
        ),
      );
    }
    const undone = await Promise.all(
      agents.map((a, i) => a.call('history', { project: `undo-${i}`, action: 'undo' })),
    );
    for (const u of undone) expect(u.text).not.toMatch(/nothing to undo|history was reset/i);
    for (let i = 0; i < AGENTS; i++) {
      const r = await svc.projects.read(`undo-${i}`, (doc) => {
        const img = doc.image(doc.state.cels[0]!.imageId);
        return [img.get(0, 0), img.get(1, 0), img.get(2, 0)];
      });
      expect(r.value).toEqual([2, 3, 0]);
    }
  }, 60_000);
});

describe('readers and writers on the same project', () => {
  it('reads during saves (viewer polling, other agents) never reload the project or wipe undo', async () => {
    const svc = await services(tempDir());
    await svc.projects.create({ name: 'busy', width: 32, height: 32, frames: 4 });
    let writing = true;
    const writes = (async () => {
      const warnings: string[] = [];
      try {
        for (let i = 0; i < 40; i++) {
          const r = await svc.projects.mutate('busy', (doc) =>
            draw(doc, { frame: i % 4, ops: [{ op: 'pixels', points: [[i % 32, 1]], color: 2 + (i % 5) }] }),
          );
          warnings.push(...r.warnings);
        }
      } finally {
        writing = false; // a failed save ends the read loop instead of spinning until the timeout
      }
      return warnings;
    })();
    let reads = 0;
    while (writing) {
      await Promise.all([
        svc.projects.read('busy', (doc) => doc.state.frames.length),
        svc.projects.read('busy', (doc) => doc.history.canUndo),
      ]);
      reads += 2;
      await new Promise((r) => setImmediate(r));
    }
    const warnings = await writes;
    expect(reads).toBeGreaterThan(0);
    expect(warnings.join('\n')).not.toMatch(/changed outside|modified by another process|history was/);
    const undone = await svc.projects.history('busy', 'undo', 40);
    expect(undone.value).toHaveLength(40);
  }, 60_000);

  it('concurrent first loads of a project share one document (single-flight)', async () => {
    const dir = tempDir();
    const a = await services(dir);
    await a.projects.create({ name: 'lazy', width: 8, height: 8 });
    const b = await services(dir); // another process: nothing cached yet
    const docs = await Promise.all(Array.from({ length: 6 }, () => b.projects.read('lazy', (doc) => doc)));
    expect(new Set(docs.map((d) => d.value)).size).toBe(1);
  });
});

describe('concurrent agents over Streamable HTTP', () => {
  let svc: AppServices;
  let server: Server;
  let base: string;
  let closeApp: () => Promise<void>;

  beforeAll(async () => {
    svc = await services(tempDir());
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

  it('7 HTTP sessions build assets in parallel without interfering', async () => {
    const clients = await Promise.all(
      Array.from({ length: AGENTS }, async (_, i) => {
        const c = new Client({ name: `http${i}`, version: '1' });
        await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
        return c;
      }),
    );
    const call = async (c: Client, name: string, args: Record<string, unknown>) => {
      const r = (await c.callTool({ name, arguments: args })) as CallToolResult;
      if (r.isError) throw new Error(JSON.stringify(r.content));
      return r;
    };
    await Promise.all(
      clients.map(async (c, i) => {
        await call(c, 'project_create', { name: `web-${i}`, width: 16, height: 16, frames: 3 });
        for (let f = 0; f < 3; f++)
          await call(c, 'draw', {
            project: `web-${i}`,
            frame: f,
            ops: [{ op: 'rect', x: 0, y: 0, w: 16, h: 16, fill: 2 + i }],
          });
        await call(c, 'export', { project: `web-${i}`, format: 'apng', scale: 2 });
      }),
    );
    for (let i = 0; i < AGENTS; i++) {
      const r = await svc.projects.read(`web-${i}`, (doc) => doc.image(doc.state.cels[2]!.imageId).get(5, 5));
      expect(r.value).toBe(2 + i);
    }
    await Promise.all(clients.map((c) => c.close()));
  }, 120_000);
});

describe('multi-agent safety details', () => {
  it('a manifest replaced within the same timestamp tick still counts as changed (inode stamp)', async () => {
    const { writeFileAtomic, fileStamp } = await import('../src/storage/fs-utils.js');
    const { utimesSync } = await import('node:fs');
    const { join } = await import('node:path');
    const file = join(tempDir(), 'm.json');
    await writeFileAtomic(file, '{"a":1}');
    const before = await fileStamp(file);
    const t = new Date('2026-01-01T00:00:00Z');
    utimesSync(file, t, t);
    const pinned = await fileStamp(file);
    await writeFileAtomic(file, '{"a":2}'); // same size, then force the same mtime
    utimesSync(file, t, t);
    expect(await fileStamp(file)).not.toBe(pinned);
    expect(before).not.toBe(pinned);
  });

  it('names without ASCII letters share the fallback id but are only refused by name', async () => {
    const svc = await services(tempDir());
    const a = await svc.projects.create({ name: '勇者', width: 4, height: 4 }, { ifExists: 'error' });
    const b = await svc.projects.create({ name: '騎士', width: 4, height: 4 }, { ifExists: 'error' });
    expect(a.id).not.toBe(b.id);
    await expect(
      svc.projects.create({ name: '勇者', width: 4, height: 4 }, { ifExists: 'error' }),
    ).rejects.toThrow(/already exists/);
  });

  it('a project created by another process resolves by name right away (name cache refreshes on a miss)', async () => {
    const dir = tempDir();
    const a = await services(dir);
    const b = await services(dir);
    await a.projects.create({ name: 'First Asset', width: 4, height: 4 });
    expect(await b.projects.resolveId('First Asset')).toBe('first-asset');
    await a.projects.create({ name: 'Second Asset', width: 4, height: 4 });
    expect(await b.projects.resolveId('Second Asset')).toBe('second-asset');
  });

  it('a save never recreates a project another process deleted', async () => {
    const dir = tempDir();
    const a = await services(dir);
    const b = await services(dir);
    await a.projects.create({ name: 'gone', width: 4, height: 4 });
    await b.projects.read('gone', () => null); // cached in b
    await a.projects.delete('gone');
    await expect(
      b.projects.mutate('gone', (doc) => draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 2 }] })),
    ).rejects.toThrow(/not found|deleted/i);
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    expect(existsSync(join(dir, 'projects', 'gone'))).toBe(false);
  });
});

describe('several server processes on one data directory', () => {
  it('concurrent edits of the same project from two processes are all kept (project lock file)', async () => {
    const dir = tempDir();
    const [a, b] = await Promise.all([services(dir), services(dir)]);
    await a.projects.create({ name: 'shared-proc', width: 32, height: 2 });
    const warnings: string[] = [];
    await Promise.all(
      [a, b].map(async (svc, k) => {
        for (let i = 0; i < 16; i++) {
          const r = await svc.projects.mutate('shared-proc', (doc) =>
            draw(doc, { ops: [{ op: 'pixels', points: [[k * 16 + i, 0]], color: 2 + k }] }),
          );
          warnings.push(...r.warnings);
        }
      }),
    );
    const fresh = await services(dir);
    const row = await fresh.projects.read('shared-proc', (doc) => {
      const img = doc.image(doc.state.cels[0]!.imageId);
      return Array.from({ length: 32 }, (_, x) => img.get(x, 0));
    });
    expect(row.value).toEqual(Array.from({ length: 32 }, (_, x) => (x < 16 ? 2 : 3)));
    expect(warnings.join('\n')).not.toMatch(/modified by another process/);
  }, 60_000);

  it('a lock left by a crashed process is broken once stale', async () => {
    const { writeFileSync, utimesSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = tempDir();
    const svc = await services(dir);
    await svc.projects.create({ name: 'crashed', width: 4, height: 4 });
    const lock = join(dir, 'projects', 'crashed', '.lock');
    writeFileSync(lock, '99999 old');
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
    const r = await svc.projects.mutate('crashed', (doc) =>
      draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 2 }] }),
    );
    expect(r.changed).toBe(true);
  });
});
