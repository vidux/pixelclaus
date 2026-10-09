/**
 * QA (multi-agent concurrency): several MCP sessions on ONE shared services instance working on the SAME
 * project at once, deleting projects while other sessions still use them, and name collisions.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { draw, type SpriteDocument } from '@pixelclaus/core';
import { decodePxc } from '@pixelclaus/formats';
import { createMcpServer, type AppServices } from '../../src/index.js';
import { services, tempDir } from '../helpers.js';

interface Session {
  call: (tool: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
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
      return { text, isError: !!raw.isError };
    },
    close: () => client.close(),
  };
}

const W = 8;
const FRAMES = 4;

/** Distinct colours of layer L1 over every frame (a consistent snapshot has exactly one). */
function layerColours(state: SpriteDocument['state'], image: (id: string) => { get(x: number, y: number): number }) {
  const colours = new Set<number>();
  for (let f = 0; f < state.frames.length; f++) {
    const cel = state.cels.find((c) => c.layerId === 'L1' && c.frame === f);
    if (!cel) {
      colours.add(0);
      continue;
    }
    const img = image(cel.imageId);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) colours.add(img.get(x, y));
  }
  return colours;
}

/** Fill every frame of L1 with one colour in ONE draw call (atomic: all frames or none). */
const fillAll = (color: number) =>
  Array.from({ length: FRAMES }, (_, f) => ({ op: 'rect', frame: f, x: 0, y: 0, w: W, h: W, fill: color }));

describe('many sessions hammering the same project', () => {
  it('draws / undo / redo / flips / checkpoints / exports / renders interleave without tearing or INTERNAL errors', async () => {
    const svc = await services(tempDir());
    const s = await Promise.all(Array.from({ length: 7 }, (_, i) => session(svc, `agent${i}`)));
    await s[0]!.call('project_create', { name: 'shared', width: W, height: W, frames: FRAMES });
    expect((await s[0]!.call('draw', { project: 'shared', ops: fillAll(2) })).isError).toBe(false);
    await s[0]!.call('checkpoint', { project: 'shared', action: 'create', name: 'base' });

    const errors: string[] = [];
    const revs: number[] = [];
    const record = (r: { text: string; isError: boolean }) => {
      if (r.isError) errors.push(r.text);
      const m = / · rev (\d+)/.exec(r.text);
      // a flip of a uniformly filled canvas is a no-op (nothing saved), so it legitimately reports the current rev
      if (m && !r.isError && !/^flip_h|· 0 px changed/.test(r.text)) revs.push(Number(m[1]));
      return r;
    };
    const exportsSeen: Array<Set<number>> = [];
    const ROUNDS = 12;
    await Promise.all([
      // three drawing agents, each fills ALL frames with its own colours
      ...[0, 1, 2].map(async (k) => {
        for (let i = 0; i < ROUNDS; i++)
          record(
            await s[k]!.call('draw', {
              project: 'shared',
              ops: fillAll(3 + k * 8 + (i % 8)),
              preview: i % 3 === 0,
            }),
          );
      }),
      // undo / redo agent
      (async () => {
        for (let i = 0; i < ROUNDS; i++)
          record(await s[3]!.call('history', { project: 'shared', action: i % 2 ? 'redo' : 'undo' }));
      })(),
      // flips + checkpoint create/restore
      (async () => {
        for (let i = 0; i < ROUNDS / 2; i++) {
          record(await s[4]!.call('transform', { project: 'shared', scope: 'sprite', op: 'flip_h' }));
          record(await s[4]!.call('checkpoint', { project: 'shared', action: 'create', name: `cp${i}` }));
          if (i % 2) record(await s[4]!.call('checkpoint', { project: 'shared', action: 'restore', name: 'base' }));
        }
      })(),
      // readers: native-format exports (decoded and checked) and renders
      (async () => {
        for (let i = 0; i < ROUNDS; i++) {
          const file = await svc.exporter.download('shared', { format: 'pxc' });
          const snap = decodePxc(file.data);
          exportsSeen.push(layerColours(snap.state, (id) => snap.images.get(id)!));
        }
      })(),
      (async () => {
        for (let i = 0; i < ROUNDS; i++) {
          record(await s[5]!.call('render', { project: 'shared', view: i % 2 ? 'filmstrip' : 'composite' }));
          record(await s[6]!.call('export', { project: 'shared', format: i % 2 ? 'gif' : 'spritesheet' }));
          record(await s[6]!.call('analyze', { project: 'shared', kind: 'lint' }));
        }
      })(),
    ]);

    // only "nothing to undo/redo"-style outcomes are acceptable; never INTERNAL or unexpected failures
    expect(errors, errors.join('\n')).toEqual([]);
    // every export saw one consistent document: all frames carry the same colour
    for (const c of exportsSeen) expect([...c].length, [...c].join(',')).toBe(1);
    // every mutation got its own revision
    expect(new Set(revs).size, revs.join(',')).toBe(revs.length);
    // memory == disk: a fresh process sees exactly what the live one has
    const live = await svc.projects.read('shared', (doc) => ({
      colours: [...layerColours(doc.state, (id) => doc.image(id))],
      frames: doc.state.frames.length,
    }));
    const other = await services(svc.config.dataDir);
    const disk = await other.projects.read('shared', (doc) => ({
      colours: [...layerColours(doc.state, (id) => doc.image(id))],
      frames: doc.state.frames.length,
    }));
    expect(disk.value).toEqual(live.value);
    expect(disk.revision).toBe(live.revision);
    expect(live.revision).toBe(Math.max(...revs, live.revision));
    await Promise.all(s.map((x) => x.close()));
  }, 60_000);

  it('frame add/remove racing with whole-sprite draws and exports never yields a torn structure', async () => {
    const svc = await services(tempDir());
    const s = await Promise.all(Array.from({ length: 4 }, (_, i) => session(svc, `t${i}`)));
    await s[0]!.call('project_create', { name: 'timeline', width: W, height: W, frames: 3 });
    await s[0]!.call('tag', { project: 'timeline', action: 'add', name: 'all', from: 0, to: 2 });
    const errors: string[] = [];
    const problems: string[] = [];
    await Promise.all([
      (async () => {
        for (let i = 0; i < 10; i++) {
          const r = await s[0]!.call('frame', { project: 'timeline', action: 'add', cels: 'copy', source: 0 });
          if (r.isError) errors.push(r.text);
        }
      })(),
      (async () => {
        for (let i = 0; i < 10; i++) {
          const r = await s[1]!.call('frame', { project: 'timeline', action: 'remove', frames: [1] });
          // the last frame can never be removed: a clean refusal is fine
          if (r.isError && !/INVALID_ARGUMENT|LIMIT|CONFLICT/.test(r.text)) errors.push(r.text);
        }
      })(),
      (async () => {
        for (let i = 0; i < 10; i++) {
          const r = await s[2]!.call('draw', { project: 'timeline', ops: [{ op: 'rect', x: 0, y: 0, w: W, h: W, fill: 5 + i }] });
          if (r.isError) errors.push(r.text);
        }
      })(),
      (async () => {
        for (let i = 0; i < 10; i++) {
          const snap = decodePxc((await svc.exporter.download('timeline', { format: 'pxc' })).data);
          const n = snap.state.frames.length;
          for (const c of snap.state.cels) {
            if (c.frame >= n) problems.push(`cel on missing frame ${c.frame}/${n}`);
            if (!snap.images.has(c.imageId)) problems.push(`cel image ${c.imageId} missing`);
          }
          for (const t of snap.state.tags) if (t.to >= n || t.from > t.to) problems.push(`tag ${t.from}-${t.to}/${n}`);
          const r = await s[3]!.call('export', { project: 'timeline', format: 'gif', tag: 'all' });
          if (r.isError) errors.push(r.text);
        }
      })(),
    ]);
    expect(errors, errors.join('\n')).toEqual([]);
    expect(problems, problems.join('\n')).toEqual([]);
    await Promise.all(s.map((x) => x.close()));
  }, 60_000);
});

describe('checkpoint restore racing with another agent', () => {
  it("a draw accepted while a restore runs survives either in the result or in the restore's backup", async () => {
    const svc = await services(tempDir());
    const { id } = await svc.projects.create({ name: 'restore-race', width: 8, height: 8 });
    await svc.projects.createCheckpoint(id, 'empty');
    const store = svc.projects.store;
    const orig = store.writeCheckpoint.bind(store);
    let other: Promise<{ revision: number }> | null = null;
    // instrumentation only: another agent's draw arrives while the automatic backup is being written
    store.writeCheckpoint = async (pid, cp, snap) => {
      other ??= svc.projects.mutate(id, (doc) =>
        draw(doc, { ops: [{ op: 'pixels', points: [[3, 3]], color: 9 }] }),
      );
      return orig(pid, cp, snap);
    };
    const restored = await svc.projects.restoreCheckpoint(id, 'empty');
    store.writeCheckpoint = orig;
    const accepted = await other!; // the other agent was told "ok · rev N"
    expect(accepted.revision).toBeGreaterThan(0);
    const inResult = (
      await svc.projects.read(id, (doc) => {
        const cel = doc.state.cels.find((c) => c.frame === 0);
        return cel ? doc.image(cel.imageId).get(3, 3) : 0;
      })
    ).value;
    const backup = await store.readCheckpoint(id, restored.backup.id);
    const cel = backup.state.cels.find((c) => c.frame === 0);
    const inBackup = cel ? backup.images.get(cel.imageId)!.get(3, 3) : 0;
    // the backup is taken in a separate locked step from the restore itself, so a draw can land in
    // between: it is in neither place and the restore cleared undo history → silently, irrecoverably lost
    expect(
      inResult === 9 || inBackup === 9,
      `accepted draw (rev ${accepted.revision}) is in neither the restored project nor backup "${restored.backup.name}"`,
    ).toBe(true);
  });
});

describe('deleting a project while other sessions still use it', () => {
  /** Keep every compute worker busy so a task that already copied its document waits in the queue. */
  function saturate(svc: AppServices, ms: number): Promise<unknown> {
    const n = svc.compute.stats().size;
    return Promise.all(Array.from({ length: n }, () => svc.compute.run({ kind: 'busy', busyMs: ms }, [], 0)));
  }

  it('an export in flight when the project is deleted does not resurrect its folder', async () => {
    const svc = await services(tempDir());
    const { id } = await svc.projects.create({ name: 'doomed', width: 16, height: 16, frames: 4 });
    await svc.projects.mutate(id, (doc) => draw(doc, { ops: [{ op: 'rect', x: 0, y: 0, w: 16, h: 16, fill: 3 }] }));
    await svc.projects.flushThumbnails();
    const busy = saturate(svc, 1200);
    // the export copies the document now, then waits for a worker
    const exporting = svc.exporter.export(id, { format: 'gif', scale: 2 }).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(await svc.projects.delete(id)).toBe(id);
    await busy;
    const res = await exporting;
    const folder = join(svc.config.dataDir, 'projects', id);
    // expected: folder stays deleted (export fails with NOT_FOUND or its files go nowhere inside projects/)
    expect(existsSync(folder), `resurrected ${folder} (export ok=${res.ok})`).toBe(false);
    // and the name is free again
    const again = await svc.projects.create({ name: 'doomed', width: 4, height: 4 });
    expect(again.id).toBe('doomed');
  }, 30_000);

  it('a draw with preview, renders and analysis in flight during delete fail cleanly and leave nothing behind', async () => {
    const svc = await services(tempDir());
    const s = await Promise.all(Array.from({ length: 4 }, (_, i) => session(svc, `d${i}`)));
    await s[0]!.call('project_create', { name: 'victim', width: 32, height: 32, frames: 6 });
    let stop = false;
    const texts: string[] = [];
    const loop = (fn: () => Promise<{ text: string; isError: boolean }>) =>
      (async () => {
        while (!stop) {
          const r = await fn();
          if (r.isError) {
            texts.push(r.text);
            if (/NOT_FOUND/.test(r.text)) return;
          }
        }
      })();
    const workers = [
      loop(() => s[1]!.call('draw', { project: 'victim', ops: [{ op: 'rect', x: 0, y: 0, w: 32, h: 32, fill: 4 }], preview: true })),
      loop(() => s[2]!.call('render', { project: 'victim', view: 'filmstrip' })),
      loop(() => s[3]!.call('analyze', { project: 'victim', kind: 'lint' })),
    ];
    await new Promise((r) => setTimeout(r, 300));
    const del = await s[0]!.call('project_delete', { project: 'victim', confirm: true });
    expect(del.isError, del.text).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    stop = true;
    await Promise.all(workers);
    for (const t of texts) expect(t).toMatch(/NOT_FOUND/);
    await svc.projects.flushThumbnails();
    await new Promise((r) => setTimeout(r, 900)); // past the thumbnail debounce
    expect(existsSync(join(svc.config.dataDir, 'projects', 'victim'))).toBe(false);
    // the server keeps working for everyone
    const ok = await s[1]!.call('project_create', { name: 'victim', width: 4, height: 4 });
    expect(ok.text).toMatch(/created victim\b/);
    await Promise.all(s.map((x) => x.close()));
  }, 30_000);
});

describe('name collisions between agents', () => {
  it("'Hero' / 'hero' / 'HERO' created at once get distinct ids, and the suffixed ones get the NOTE", async () => {
    const svc = await services(tempDir());
    const s = await Promise.all(['Hero', 'hero', 'HERO'].map((n) => session(svc, n)));
    // [developer, T11b] project_create now refuses taken names by default; this test covers the opt-in suffix mode
    const replies = await Promise.all(
      ['Hero', 'hero', 'HERO'].map((name, i) =>
        s[i]!.call('project_create', { name, width: 8, height: 8, ifExists: 'suffix' }),
      ),
    );
    const ids = replies.map((r) => /created (\S+)/.exec(r.text)![1]!);
    expect(new Set(ids)).toEqual(new Set(['hero', 'hero-2', 'hero-3']));
    for (let i = 0; i < 3; i++) {
      if (ids[i] === 'hero') expect(replies[i]!.text).not.toMatch(/NOTE/);
      else expect(replies[i]!.text).toMatch(new RegExp(`NOTE: 'hero' was taken, so this project's id is '${ids[i]}'`));
    }
    // a capitalised shared name is refused
    const amb = await s[0]!.call('project_get', { project: 'Hero' });
    expect(amb.isError).toBe(true);
    expect(amb.text).toMatch(/used by 3 projects/);
    await Promise.all(s.map((x) => x.close()));
  });

  it('a lowercase name shared by two agents is refused too, instead of silently editing the project whose id equals it', async () => {
    // [developer, T11b] C2 is fixed at creation time: by default the second "slime" is refused (CONFLICT),
    // so two agents can no longer end up with projects that share a name; the first agent's work is untouched.
    const svc = await services(tempDir());
    const [a, b] = await Promise.all([session(svc, 'a'), session(svc, 'b')]);
    const [ra, rb] = await Promise.all([
      a.call('project_create', { name: 'slime', width: 8, height: 8 }),
      b.call('project_create', { name: 'slime', width: 8, height: 8 }),
    ]);
    const [won, lost] = ra.isError ? [rb, ra] : [ra, rb];
    expect(won.isError).toBe(false);
    expect(won.text).toMatch(/created slime\b/);
    expect(lost.isError).toBe(true);
    expect(lost.text).toMatch(/CONFLICT.*already exists \(id 'slime'\)/s);
    expect((await svc.projects.list()).filter((p) => p.name === 'slime')).toHaveLength(1);
    await Promise.all([a.close(), b.close()]);
  });
});
