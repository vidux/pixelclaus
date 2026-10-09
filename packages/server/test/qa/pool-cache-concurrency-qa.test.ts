/**
 * QA (multi-agent concurrency): compute pool under load from 7 sessions, result correctness, failure
 * isolation, main-thread responsiveness, and the project cache with many active agents.
 */
import { describe, expect, it } from 'vitest';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { draw, isPixelClausError, renderView, type RenderRequest } from '@pixelclaus/core';
import { rasterToPng } from '@pixelclaus/formats';
import { createMcpServer, createServices, type AppServices } from '../../src/index.js';
import { docPayload, payloadDoc } from '../../src/compute/snapshot.js';
import { services, tempDir } from '../helpers.js';

interface Session {
  call: (tool: string, args?: Record<string, unknown>) => Promise<{ text: string; images: string[]; isError: boolean }>;
  close: () => Promise<void>;
}

async function session(svc: AppServices, name: string): Promise<Session> {
  const server = createMcpServer(svc);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name, version: '1' });
  await client.connect(b);
  return {
    call: async (tool, args = {}) => {
      const raw = (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
      const text = raw.content
        .filter((c) => c.type === 'text')
        .map((c) => (c as { text: string }).text)
        .join('\n');
      const images = raw.content.filter((c) => c.type === 'image').map((c) => (c as { data: string }).data);
      return { text, images, isError: !!raw.isError };
    },
    close: () => client.close(),
  };
}

async function settle(svc: AppServices): Promise<void> {
  await svc.projects.flushThumbnails();
  for (let i = 0; i < 100 && (svc.compute.stats().busy || svc.compute.stats().queued); i++)
    await new Promise((r) => setTimeout(r, 20));
}

describe('compute pool under load from 7 agents', () => {
  it('50 renders + 21 exports + failing tasks: correct results, no leaked workers, responsive main thread', async () => {
    const svc = await services(tempDir());
    const agents = await Promise.all(Array.from({ length: 7 }, (_, i) => session(svc, `a${i}`)));
    await Promise.all(
      agents.map(async (a, i) => {
        await a.call('project_create', { name: `load-${i}`, width: 48, height: 48, frames: 6, layers: ['A', 'B'] });
        await a.call('draw', {
          project: `load-${i}`,
          layer: 'A',
          ops: Array.from({ length: 6 }, (_, f) => ({ op: 'gradient', frame: f, from: [0, 0], to: [48, 48 - f], colors: [2 + i, 3 + i, 4 + i] })),
        });
      }),
    );
    await settle(svc);
    const before = svc.compute.stats();
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const errors: string[] = [];
    const expectedFailures: string[] = [];
    const mismatches: string[] = [];
    // inline (main-thread) reference renders are done after the measurement window: they are the test's
    // own CPU work, not the server's
    const compare: Array<() => void> = [];
    await Promise.all(
      agents.map(async (a, i) => {
        const project = `load-${i}`;
        const jobs: Array<Promise<unknown>> = [];
        for (let k = 0; k < 7; k++) {
          const view = ['composite', 'filmstrip', 'indexed', 'value', 'silhouette', 'onion', 'composite'][k]!;
          jobs.push(a.call('render', { project, view, frame: k % 6 }).then((r) => r.isError && errors.push(r.text)));
        }
        for (const format of ['gif', 'spritesheet', 'apng'])
          jobs.push(a.call('export', { project, format, scale: 3 }).then((r) => r.isError && errors.push(r.text)));
        // a task that throws on the worker (frame out of range): a clean, typed error
        jobs.push(
          a.call('render', { project, frame: 99 }).then((r) => {
            if (!r.isError || /INTERNAL/.test(r.text)) errors.push(`bad failure: ${r.text}`);
            else expectedFailures.push(r.text);
          }),
        );
        // worker output == inline output for the same document copy, while the pool is saturated
        jobs.push(
          (async () => {
            const req: RenderRequest = { view: 'composite', frame: i % 6 };
            const { value } = await svc.projects.read(project, (doc) => ({
              ref: docPayload(doc).payload,
              ...docPayload(doc, { frames: [i % 6] }),
            }));
            const viaPool = await svc.compute.run({ kind: 'render', doc: value.payload, req }, value.transfer);
            compare.push(() => {
              const inline = rasterToPng(renderView(payloadDoc(value.ref), req).raster);
              if (!Buffer.from(viaPool.png).equals(Buffer.from(inline))) mismatches.push(project);
            });
          })(),
        );
        await Promise.all(jobs);
      }),
    );
    loop.disable();
    for (const c of compare) c();
    expect(compare).toHaveLength(7);
    expect(errors, errors.join('\n')).toEqual([]);
    expect(expectedFailures).toHaveLength(7);
    expect(mismatches).toEqual([]);
    await settle(svc);
    const after = svc.compute.stats();
    expect(after.busy).toBe(0);
    expect(after.queued).toBe(0);
    expect(after.started).toBeLessThanOrEqual(after.size);
    expect(after.completed - before.completed).toBeGreaterThanOrEqual(7 * 11);
    expect(after.failed - before.failed).toBeGreaterThanOrEqual(7);
    const stall = loop.max / 1e6;
    expect(stall, `event loop stalled ${stall.toFixed(0)} ms`).toBeLessThan(400);
    await Promise.all(agents.map((a) => a.close()));
  }, 60_000);

  it('a very large export never delays another agent’s preview (batch work leaves a worker free)', async () => {
    const svc = await services(tempDir());
    const [big, small] = await Promise.all([session(svc, 'big'), session(svc, 'small')]);
    await big.call('project_create', { name: 'huge', width: 256, height: 256, frames: 16 });
    await big.call('draw', {
      project: 'huge',
      ops: Array.from({ length: 16 }, (_, f) => ({ op: 'gradient', frame: f, from: [0, f], to: [255, 255], colors: [2, 5, 9, 12, 20] })),
    });
    await small.call('project_create', { name: 'tiny', width: 16, height: 16 });
    await settle(svc);
    const order: string[] = [];
    const e1 = big.call('export', { project: 'huge', format: 'gif', scale: 4 }).then((r) => (order.push('export1'), r));
    const e2 = big.call('export', { project: 'huge', format: 'apng', scale: 4 }).then((r) => (order.push('export2'), r));
    await new Promise((r) => setTimeout(r, 50));
    const p = small.call('draw', { project: 'tiny', ops: [{ op: 'pixels', points: [[1, 1]], color: 3 }], preview: true });
    const pr = await p.then((r) => (order.push('preview'), r));
    expect(pr.isError, pr.text).toBe(false);
    expect(pr.images).toHaveLength(1);
    const [r1, r2] = await Promise.all([e1, e2]);
    expect(r1.isError, r1.text).toBe(false);
    expect(r2.isError, r2.text).toBe(false);
    // two exports may share at most size-1 workers, so the second one is still running/queued
    expect(order.indexOf('preview'), order.join(' → ')).toBeLessThan(order.indexOf('export2'));
    await Promise.all([big.close(), small.close()]);
  }, 60_000);

  it('many failing tasks do not leak busy workers and keep their error codes', async () => {
    const svc = await services(tempDir());
    await svc.projects.create({ name: 'err', width: 8, height: 8, frames: 2 });
    const { value } = await svc.projects.read('err', (doc) => docPayload(doc));
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) =>
        svc.compute.run({ kind: 'render', doc: structuredClone(value.payload), req: { frame: 5 + i } }),
      ),
    );
    for (const r of results) {
      expect(r.status).toBe('rejected');
      expect(isPixelClausError((r as PromiseRejectedResult).reason)).toBe(true);
    }
    await settle(svc);
    expect(svc.compute.stats().busy).toBe(0);
    const ok = await svc.compute.run({ kind: 'render', doc: value.payload, req: { frame: 1 } });
    expect(ok.png.length).toBeGreaterThan(0);
  });
});

describe('main thread stays responsive for other agents during heavy storage work', () => {
  it('checkpoint create/restore and duplicate of a large animation do not freeze the event loop', async () => {
    const svc = await services(tempDir());
    const { id } = await svc.projects.create({ name: 'epic', width: 256, height: 256, frames: 48, layers: ['A', 'B'] });
    for (const layer of ['A', 'B'])
      await svc.projects.mutate(id, (doc) =>
        draw(doc, {
          layer,
          ops: Array.from({ length: 48 }, (_, f) => ({ op: 'gradient' as const, frame: f, from: [0, f] as [number, number], to: [255, 200] as [number, number], colors: [2, 7, 9, 14, 20, 23], dither: 'bayer4' }) as never),
        }),
      );
    await settle(svc);
    const stalls: Record<string, number> = {};
    const measure = async (label: string, fn: () => Promise<unknown>) => {
      const loop = monitorEventLoopDelay({ resolution: 10 });
      loop.enable();
      await fn();
      loop.disable();
      stalls[label] = Math.round(loop.max / 1e6);
    };
    await measure('checkpoint create', () => svc.projects.createCheckpoint(id, 'big'));
    await measure('checkpoint restore', () => svc.projects.restoreCheckpoint(id, 'big'));
    await measure('duplicate', () => svc.projects.duplicate(id, 'epic copy'));
    const worst = Math.max(...Object.values(stalls));
    // the same 400 ms budget the compute pool is held to: another agent's tiny draw would wait this long
    expect(worst, `main-thread stalls (ms): ${JSON.stringify(stalls)}`).toBeLessThan(400);
  }, 60_000);
});

describe('project cache with many active agents', () => {
  it('cacheSize 2 with 7 agents working for a while: every agent can still undo its own steps', async () => {
    const svc = await createServices({ dataDir: tempDir(), cacheSize: 2 });
    const agents = await Promise.all(Array.from({ length: 7 }, (_, i) => session(svc, `c${i}`)));
    await Promise.all(agents.map((a, i) => a.call('project_create', { name: `keep-${i}`, width: 8, height: 8 })));
    for (let round = 0; round < 4; round++)
      await Promise.all(
        agents.map((a, i) =>
          a.call('draw', { project: `keep-${i}`, ops: [{ op: 'pixels', points: [[round, 0]], color: 2 + round }] }),
        ),
      );
    // interleave lots of reads of OTHER projects too (viewer polling, project_get)
    await Promise.all(agents.map((a, i) => a.call('project_get', { project: `keep-${(i + 3) % 7}` })));
    const undone = await Promise.all(agents.map((a, i) => a.call('history', { project: `keep-${i}`, action: 'undo', steps: 2 })));
    for (const u of undone) {
      expect(u.isError, u.text).toBe(false);
      expect(u.text).toMatch(/^undid: .* \| /);
      expect(u.text).not.toMatch(/history was|nothing to undo/i);
    }
    expect(svc.projects.cacheStats().open).toBeLessThanOrEqual(8);
    await Promise.all(agents.map((a) => a.close()));
  }, 60_000);

  it('cacheIdleSeconds 0: idle projects are unloaded and the reload notice says why', async () => {
    const svc = await createServices({ dataDir: tempDir(), cacheSize: 2, cacheIdleSeconds: 0 });
    const a = await session(svc, 'idle');
    for (let i = 0; i < 4; i++) {
      await a.call('project_create', { name: `p${i}`, width: 8, height: 8 });
      await a.call('draw', { project: `p${i}`, ops: [{ op: 'pixels', points: [[0, 0]], color: 2 }] });
    }
    expect(svc.projects.cacheStats().open).toBeLessThanOrEqual(2);
    const u = await a.call('history', { project: 'p0', action: 'undo' });
    expect(u.text).toMatch(/nothing to undo/);
    expect(u.text).toMatch(/Undo history was cleared: the project was idle and unloaded from memory/);
    // the notice is delivered once
    const again = await a.call('project_get', { project: 'p0' });
    expect(again.text).not.toMatch(/Undo history was cleared/);
    await a.close();
  });

  it('when more projects are active than the hard cap allows, the notice does not claim they were idle', async () => {
    // cacheSize 1 → hard cap 4 projects; 6 agents keep 6 projects busy within a few seconds
    const svc = await createServices({ dataDir: tempDir(), cacheSize: 1 });
    const agents = await Promise.all(Array.from({ length: 6 }, (_, i) => session(svc, `h${i}`)));
    await Promise.all(agents.map((a, i) => a.call('project_create', { name: `hot-${i}`, width: 8, height: 8 })));
    for (let round = 0; round < 2; round++)
      for (let i = 0; i < 6; i++)
        await agents[i]!.call('draw', { project: `hot-${i}`, ops: [{ op: 'pixels', points: [[round, 0]], color: 2 }] });
    const replies = await Promise.all(agents.map((a, i) => a.call('history', { project: `hot-${i}`, action: 'undo' })));
    const cleared = replies.filter((r) => /Undo history was cleared/.test(r.text));
    expect(cleared.length).toBeGreaterThan(0); // documented: the hard cap wins over undo history
    // these projects were used seconds ago (cacheIdleSeconds = 600): "idle" sends the agent the wrong message
    for (const r of cleared) expect(r.text).not.toMatch(/was idle/);
    await Promise.all(agents.map((a) => a.close()));
  }, 30_000);
});
