/**
 * QA (multi-agent concurrency): two PixelClaus processes (two stdio servers started by two Claude
 * sessions) on the same data directory, simulated by two independent services instances.
 */
import { describe, expect, it } from 'vitest';
import { draw } from '@pixelclaus/core';
import { createServices, type AppServices } from '../../src/index.js';
import { tempDir } from '../helpers.js';

/** A separate "process": own ProjectService/cache, same data dir. */
function proc(dir: string): Promise<AppServices> {
  return createServices({ dataDir: dir, cacheSize: 4 });
}

const px = (svc: AppServices, id: string, x: number, y: number) =>
  svc.projects
    .read(id, (doc) => {
      const cel = doc.state.cels.find((c) => c.frame === 0);
      return cel ? doc.image(cel.imageId).get(x, y) : 0;
    })
    .then((r) => r.value);

describe('two processes on one data directory', () => {
  it('same-name creates from both processes at once get distinct ids', async () => {
    const dir = tempDir();
    const [a, b] = await Promise.all([proc(dir), proc(dir)]);
    const made = await Promise.all(
      Array.from({ length: 14 }, (_, i) =>
        (i % 2 ? a : b).projects.create({ name: 'Knight', width: 8, height: 8 }),
      ),
    );
    const ids = made.map((m) => m.id);
    expect(new Set(ids).size, ids.join(',')).toBe(14);
    const listed = (await a.projects.list()).filter((p) => p.name === 'Knight').map((p) => p.id);
    expect(new Set(listed)).toEqual(new Set(ids));
  });

  it('mutating different projects from both processes does not interfere and raises no warnings', async () => {
    const dir = tempDir();
    const [a, b] = await Promise.all([proc(dir), proc(dir)]);
    await a.projects.create({ name: 'pa', width: 16, height: 16 });
    await b.projects.create({ name: 'pb', width: 16, height: 16 });
    const warnings: string[] = [];
    await Promise.all(
      [
        [a, 'pa'],
        [b, 'pb'],
      ].map(async ([svc, id]) => {
        for (let i = 0; i < 16; i++) {
          const r = await (svc as AppServices).projects.mutate(id as string, (doc) =>
            draw(doc, { ops: [{ op: 'pixels', points: [[i, 0]], color: 2 + (i % 5) }] }),
          );
          warnings.push(...r.warnings);
        }
      }),
    );
    expect(warnings).toEqual([]);
    for (const [svc, id] of [
      [b, 'pa'],
      [a, 'pb'],
    ] as const)
      for (let i = 0; i < 16; i++) expect(await px(svc, id, i, 0)).toBe(2 + (i % 5));
  });

  it('alternating edits of the SAME project from two processes never silently lose a change', async () => {
    const dir = tempDir();
    const [a, b] = await Promise.all([proc(dir), proc(dir)]);
    await a.projects.create({ name: 'tug', width: 32, height: 4 });
    const notices: string[] = [];
    // strictly sequential: A, B, A, B, ... each sets its own pixel; each must see the other's last change
    for (let i = 0; i < 32; i++) {
      const svc = i % 2 ? b : a;
      const r = await svc.projects.mutate('tug', (doc) =>
        draw(doc, { ops: [{ op: 'pixels', points: [[i, 0]], color: 2 + (i % 7) }] }),
      );
      notices.push(...r.warnings);
    }
    const lost: number[] = [];
    const fresh = await proc(dir);
    for (let i = 0; i < 32; i++) if ((await px(fresh, 'tug', i, 0)) !== 2 + (i % 7)) lost.push(i);
    expect(lost, `pixels written but lost on disk: ${lost.join(',')}; notices: ${[...new Set(notices)].join(' | ')}`).toEqual([]);
    // the reload is announced, but nobody overwrote anybody
    expect(notices.join('\n')).not.toMatch(/overwrote/);
    expect(notices.join('\n')).toMatch(/changed outside this session; reloaded/);
  });

  it('a change made by another process within the same file-timestamp tick is not silently overwritten', async () => {
    const dir = tempDir();
    const [a, b] = await Promise.all([proc(dir), proc(dir)]);
    await a.projects.create({ name: 'tick', width: 64, height: 4 });
    const silent: number[] = [];
    for (let i = 0; i < 30; i++) {
      // A saves, B looks at the project, A saves again right away, then B edits
      await a.projects.mutate('tick', (doc) => draw(doc, { ops: [{ op: 'pixels', points: [[i, 0]], color: 2 }] }));
      await b.projects.read('tick', () => null);
      await a.projects.mutate('tick', (doc) => draw(doc, { ops: [{ op: 'pixels', points: [[i, 1]], color: 3 }] }));
      const rb = await b.projects.mutate('tick', (doc) =>
        draw(doc, { ops: [{ op: 'pixels', points: [[i, 2]], color: 4 }] }),
      );
      const fresh = await proc(dir);
      const keptA = (await px(fresh, 'tick', i, 1)) === 3;
      if (!keptA && !rb.warnings.some((w) => /another process|changed outside/.test(w))) silent.push(i);
    }
    // manifest mtimes are not unique (two saves in one kernel tick get the same mtimeMs), so B keeps its
    // stale copy, saves over A's second edit and reports nothing
    expect(silent, `A's edit silently lost in rounds ${silent.join(',')}`).toEqual([]);
  });

  it('concurrent edits of the SAME project from two processes: every lost change is announced', async () => {
    const dir = tempDir();
    const [a, b] = await Promise.all([proc(dir), proc(dir)]);
    await a.projects.create({ name: 'race', width: 32, height: 4 });
    const warnings: string[] = [];
    await Promise.all(
      [a, b].map(async (svc, k) => {
        for (let i = 0; i < 16; i++) {
          const x = k * 16 + i;
          const r = await svc.projects.mutate('race', (doc) =>
            draw(doc, { ops: [{ op: 'pixels', points: [[x, 1]], color: 2 + k }] }),
          );
          warnings.push(...r.warnings);
          await new Promise((res) => setImmediate(res));
        }
      }),
    );
    const fresh = await proc(dir);
    let lost = 0;
    for (let x = 0; x < 32; x++) if ((await px(fresh, 'race', x, 1)) !== 2 + (x < 16 ? 0 : 1)) lost++;
    // last-writer-wins is the documented behaviour, but it must never be silent
    if (lost > 0) expect(warnings.join('\n'), `${lost} pixel(s) lost without a warning`).toMatch(/modified by another process/);
  });

  it('a project deleted by another process gives NOT_FOUND here (cached or not) and is not recreated', async () => {
    const dir = tempDir();
    const [a, b] = await Promise.all([proc(dir), proc(dir)]);
    await a.projects.create({ name: 'gone', width: 8, height: 8 });
    await b.projects.read('gone', () => null); // cached in B
    await a.projects.flushThumbnails();
    await a.projects.delete('gone');
    const err = await b.projects
      .mutate('gone', (doc) => draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 2 }] }))
      .then(
        () => null,
        (e: Error & { code?: string }) => e,
      );
    expect(err?.code).toBe('NOT_FOUND');
    expect(await a.projects.list()).toEqual([]);
  });
});
