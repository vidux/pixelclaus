import { afterAll, describe, expect, it } from 'vitest';
import { createDocument, draw, isPixelClausError, renderView } from '@pixelclaus/core';
import { rasterToPng } from '@pixelclaus/formats';
import { ComputePool } from '../src/compute/pool.js';
import { docPayload, payloadDoc } from '../src/compute/snapshot.js';
import { runTask } from '../src/compute/tasks.js';

function sprite() {
  const doc = createDocument({ name: 's', width: 16, height: 16, palette: 'pico-8', frames: 3 });
  draw(doc, { ops: [{ op: 'rect', x: 2, y: 2, w: 8, h: 8, fill: 9 }] });
  draw(doc, { frame: 2, ops: [{ op: 'rect', x: 4, y: 4, w: 8, h: 8, fill: 12 }] });
  return doc;
}

describe('document payloads', () => {
  it('copy only the frames a task needs and rebuild an equivalent document', () => {
    const doc = sprite();
    const all = docPayload(doc);
    const one = docPayload(doc, { frames: [2] });
    expect(all.payload.images.length).toBe(2);
    expect(one.payload.images.length).toBe(1);
    // the copy is independent of the live document
    const rebuilt = payloadDoc(one.payload);
    draw(doc, { frame: 2, ops: [{ op: 'clear' }] });
    expect(rebuilt.image(rebuilt.state.cels.find((c) => c.frame === 2)!.imageId).get(5, 5)).toBe(12);
    // frames that were not copied read as empty instead of failing
    expect(rebuilt.image(rebuilt.state.cels.find((c) => c.frame === 0)!.imageId).get(5, 5)).toBe(0);
  });

  it('a worker render is byte-identical to rendering in-process', async () => {
    const doc = sprite();
    const direct = rasterToPng(renderView(doc, { view: 'indexed', frame: 2 }).raster);
    const { payload } = docPayload(doc, { frames: [2] });
    const viaTask = (await runTask({ kind: 'render', doc: payload, req: { view: 'indexed', frame: 2 } })) as {
      png: Uint8Array;
    };
    expect(Buffer.from(viaTask.png).equals(Buffer.from(direct))).toBe(true);
  });
});

describe('ComputePool', () => {
  const pool = new ComputePool({ size: 2, taskTimeoutMs: 20_000 });
  afterAll(() => pool.close());

  it('runs tasks on worker threads, in parallel', async () => {
    await pool.warm();
    const t0 = Date.now();
    const [a, b] = await Promise.all([
      pool.run({ kind: 'busy', busyMs: 400 }),
      pool.run({ kind: 'busy', busyMs: 400 }),
    ]);
    const ms = Date.now() - t0;
    expect(a.threadId).toBeGreaterThan(0);
    expect(b.threadId).toBeGreaterThan(0);
    expect(a.threadId).not.toBe(b.threadId);
    expect(ms, `two 400 ms tasks took ${ms} ms`).toBeLessThan(750);
  }, 30_000);

  it('keeps the main thread free while workers are busy', async () => {
    const busy = pool.run({ kind: 'busy', busyMs: 500 });
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 20));
    expect(Date.now() - t0).toBeLessThan(150);
    await busy;
  });

  it('errors keep their PixelClaus code and hint across the thread boundary', async () => {
    const { payload } = docPayload(sprite());
    const err = await pool.run({ kind: 'render', doc: payload, req: { frame: 9 } }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isPixelClausError(err)).toBe(true);
    expect((err as Error).message).toMatch(/frame/i);
  });

  it('previews jump ahead of queued exports, and one worker stays free for them', async () => {
    const order: string[] = [];
    const track = (label: string, p: Promise<unknown>) => p.then(() => order.push(label));
    const jobs = [
      track('batch1', pool.run({ kind: 'busy', busyMs: 300 }, [], 2)),
      track('batch2', pool.run({ kind: 'busy', busyMs: 300 }, [], 2)),
      track('batch3', pool.run({ kind: 'busy', busyMs: 300 }, [], 2)),
    ];
    await new Promise((r) => setTimeout(r, 30));
    const t0 = Date.now();
    jobs.push(track('preview', pool.run({ kind: 'busy', busyMs: 10 }, [], 0)));
    await jobs[3];
    // batch work may use only size-1 workers, so the preview starts immediately
    expect(Date.now() - t0).toBeLessThan(200);
    await Promise.all(jobs);
    expect(order[0]).toBe('preview');
  }, 30_000);

  it('a task that runs too long is stopped and its worker replaced', async () => {
    const strict = new ComputePool({ size: 1, taskTimeoutMs: 300 });
    const err = await strict.run({ kind: 'busy', busyMs: 3000 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/took longer/);
    const ok = await strict.run({ kind: 'busy', busyMs: 1 });
    expect(ok.threadId).toBeGreaterThan(0);
    expect(strict.stats().failed).toBe(1);
    await strict.close();
  }, 30_000);

  it('size 0 runs inline on the main thread', async () => {
    const inline = new ComputePool({ size: 0 });
    expect((await inline.run({ kind: 'busy', busyMs: 1 })).threadId).toBe(0);
  });
});
