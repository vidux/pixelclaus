import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { draw, addFrames } from '@pixelclaus/core';
import { ProjectService, loadConfig } from '../src/index.js';
import { services, tempDir } from './helpers.js';

describe('ProjectService', () => {
  it('creates, lists, resolves names and persists across instances', async () => {
    const dir = tempDir();
    const s = await services(dir);
    const { id } = await s.projects.create({ name: 'My Hero', width: 8, height: 8, palette: 'pico-8' });
    expect(id).toBe('my-hero');
    const second = await s.projects.create({ name: 'My Hero', width: 8, height: 8 });
    expect(second.id).toBe('my-hero-2');
    // a name shared by two projects is refused (it could be another agent's project); ids always work
    await expect(s.projects.resolveId('My Hero')).rejects.toThrow(/used by 2 projects.*|Pass the id/);
    await s.projects.mutate('my-hero', (doc) => {
      draw(doc, { ops: [{ op: 'pixels', points: [[1, 1]], color: 9 }] });
      addFrames(doc, { count: 2, cels: 'copy' });
    });
    const list = await s.projects.list();
    expect(list.map((p) => p.id).sort()).toEqual(['my-hero', 'my-hero-2']);
    // a fresh service instance (another process) sees the same content
    const other = new ProjectService(loadConfig({ dataDir: dir }));
    const r = await other.read('my-hero', (doc) => ({
      frames: doc.state.frames.length,
      px: doc.image(doc.state.cels[0]!.imageId).get(1, 1),
    }));
    expect(r.value).toEqual({ frames: 3, px: 9 });
    await expect(s.projects.resolveId('my-heor')).rejects.toThrow(/did you mean/);
  });

  it('reloads when another process changed the files', async () => {
    const dir = tempDir();
    const a = await services(dir);
    const b = await services(dir);
    await a.projects.create({ name: 'shared', width: 4, height: 4 });
    await b.projects.read('shared', () => null);
    await new Promise((r) => setTimeout(r, 15));
    await a.projects.mutate('shared', (doc) =>
      draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 2 }] }),
    );
    const res = await b.projects.mutate('shared', (doc) => doc.image(doc.state.cels[0]!.imageId).get(0, 0));
    expect(res.value).toBe(2);
    expect(res.warnings.join()).toMatch(/reloaded/);
  });

  it('checkpoints create / restore / delete', async () => {
    const s = await services();
    await s.projects.create({ name: 'cp', width: 4, height: 4 });
    await s.projects.mutate('cp', (doc) =>
      draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 2 }] }),
    );
    const cp = await s.projects.createCheckpoint('cp', 'before');
    await expect(s.projects.createCheckpoint('cp', 'before')).rejects.toThrow(/exists/);
    await s.projects.mutate('cp', (doc) => draw(doc, { ops: [{ op: 'clear' }] }));
    const r = await s.projects.restoreCheckpoint('cp', 'before');
    expect(r.restored.id).toBe(cp.id);
    const px = await s.projects.read('cp', (doc) => doc.image(doc.state.cels[0]!.imageId).get(0, 0));
    expect(px.value).toBe(2);
    const list = await s.projects.listCheckpoints('cp');
    expect(list.length).toBe(2);
    await s.projects.deleteCheckpoint('cp', 'before');
    expect((await s.projects.listCheckpoints('cp')).length).toBe(1);
  });

  it('undo/redo via service, duplicate and delete', async () => {
    const s = await services();
    await s.projects.create({ name: 'u', width: 4, height: 4 });
    await s.projects.mutate('u', (doc) => draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 2 }] }));
    expect((await s.projects.history('u', 'undo')).value).toHaveLength(1);
    expect((await s.projects.history('u', 'undo')).value).toHaveLength(0);
    await s.projects.history('u', 'redo');
    const dup = await s.projects.duplicate('u', 'u copy');
    expect(dup.id).toBe('u-copy');
    await s.projects.delete('u');
    await expect(s.projects.read('u', () => 1)).rejects.toThrow(/not found/);
  });

  it('serialises concurrent mutations', async () => {
    const s = await services();
    await s.projects.create({ name: 'c', width: 16, height: 1 });
    await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        s.projects.mutate('c', (doc) => draw(doc, { ops: [{ op: 'pixels', points: [[i, 0]], color: 2 }] })),
      ),
    );
    const r = await s.projects.read(
      'c',
      (doc) => doc.image(doc.state.cels[0]!.imageId).data.filter((v) => v === 2).length,
    );
    expect(r.value).toBe(16);
    const m = await s.projects.read('c', () => 0);
    expect(m.revision).toBe(17);
  });

  it('rejects path traversal ids', async () => {
    const s = await services();
    await expect(s.projects.read('../etc', () => 1)).rejects.toThrow();
    writeFileSync(`${s.config.dataDir}/projects/not-a-project.txt`, 'x');
    expect((await s.projects.list()).length).toBe(0);
  });
});
