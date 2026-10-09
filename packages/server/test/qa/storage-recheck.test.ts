/**
 * QA recheck: storage & services.
 * - D1: undo/redo across several GC cycles, verified by a fresh ProjectService (process restart).
 * - D3: export outputDir must never write into another project's folder — also through symlinks.
 * - D7: checkpoint restore must not leave a stray backup when the checkpoint cannot be read.
 * - Palette import: bad/empty palette files must not silently wipe the art; GPL names survive import.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { draw, removeLayer, addLayer, removeFrames, duplicateFrame } from '@pixelclaus/core';
import { createServices, loadConfig, ProjectService } from '../../src/index.js';
import { services, tempDir } from '../helpers.js';

function fresh(dir: string): ProjectService {
  return new ProjectService(loadConfig({ dataDir: dir }));
}

/** Opaque pixel count per layer name at a frame (or '-' when the layer has no cel / is missing). */
async function census(svc: ProjectService, id: string, frame = 0): Promise<Record<string, number | string>> {
  const r = await svc.read(id, (doc) =>
    Object.fromEntries(
      doc.state.layers
        .filter((l) => l.type === 'image')
        .map((l) => {
          const cel = doc.state.cels.find((c) => c.layerId === l.id && c.frame === frame);
          return [l.name, cel ? doc.image(cel.imageId).data.filter((v) => v !== 0).length : '-'];
        }),
    ),
  );
  expect(r.notices.filter((n) => /missing|unreadable/.test(n)), 'blobs missing on disk').toEqual([]);
  return r.value;
}

describe('D1 recheck: undo/redo across several GC cycles survives a restart', () => {
  it('remove two layers, edit, undo 3, redo 2, undo 2 → a new process sees the same pixels', async () => {
    const dir = tempDir();
    const s = await services(dir);
    await s.projects.create({ name: 'g', width: 8, height: 8, palette: 'pico-8', layers: ['A', 'B', 'C'] });
    await s.projects.mutate('g', (doc) => draw(doc, { layer: 'B', ops: [{ op: 'pixels', points: [[3, 3]], color: 8 }] }));
    await s.projects.mutate('g', (doc) => draw(doc, { layer: 'C', ops: [{ op: 'rect', x: 0, y: 0, w: 2, h: 2, fill: 9 }] }));
    await s.projects.mutate('g', (doc) => removeLayer(doc, 'B')); // GC #1
    await s.projects.mutate('g', (doc) => removeLayer(doc, 'C')); // GC #2
    await s.projects.mutate('g', (doc) => draw(doc, { layer: 'A', ops: [{ op: 'pixels', points: [[1, 1]], color: 7 }] }));
    await s.projects.history('g', 'undo', 3); // A's only cel was created by the undone draw → '-'
    expect(await census(fresh(dir), 'g')).toEqual({ A: '-', B: 1, C: 4 });
    await s.projects.history('g', 'redo', 2); // B and C removed again → GC
    expect(await census(fresh(dir), 'g')).toEqual({ A: '-' });
    await s.projects.history('g', 'undo', 2); // resurrected a second time
    expect(await census(fresh(dir), 'g')).toEqual({ A: '-', B: 1, C: 4 });
    expect(await census(s.projects, 'g')).toEqual({ A: '-', B: 1, C: 4 });
    await s.projects.history('g', 'redo', 3); // back to the end, including the draw on A
    expect(await census(fresh(dir), 'g')).toEqual({ A: 1 });
  });

  it('frame removal + layer removal + checkpoint restore + undo keep every blob on disk', async () => {
    const dir = tempDir();
    const s = await services(dir);
    await s.projects.create({ name: 'h', width: 8, height: 8, palette: 'pico-8', layers: ['A', 'B'], frames: 1 });
    await s.projects.mutate('h', (doc) => draw(doc, { layer: 'A', ops: [{ op: 'rect', x: 0, y: 0, w: 3, h: 3, fill: 8 }] }));
    await s.projects.mutate('h', (doc) => duplicateFrame(doc, 0, { count: 2 }));
    await s.projects.mutate('h', (doc) => draw(doc, { layer: 'B', frame: 2, ops: [{ op: 'pixels', points: [[7, 7]], color: 9 }] }));
    await s.projects.createCheckpoint('h', 'full');
    await s.projects.mutate('h', (doc) => removeFrames(doc, [1, 2]));
    await s.projects.mutate('h', (doc) => {
      addLayer(doc, { name: 'C' });
    });
    await s.projects.restoreCheckpoint('h', 'full'); // full save + GC, history cleared
    expect(await census(fresh(dir), 'h', 2)).toEqual({ A: 9, B: 1 });
    await s.projects.mutate('h', (doc) => removeLayer(doc, 'B'));
    await s.projects.history('h', 'undo');
    expect(await census(fresh(dir), 'h', 2)).toEqual({ A: 9, B: 1 });
  });
});

describe('D3 recheck: outputDir can never reach another project folder', () => {
  it('R7: absolute outputDir through the real path of a symlinked data dir overwrites another project.json', async () => {
    const real = tempDir();
    const link = join(tempDir(), 'pc-link');
    symlinkSync(real, link, 'junction'); // junction: Windows needs no admin rights (ignored elsewhere)
    const s = await createServices({ dataDir: link, cacheSize: 4 });
    await s.projects.create({ name: 'victim', width: 4, height: 4, palette: 'pico-8' });
    await s.projects.create({ name: 'atk', width: 4, height: 4, palette: 'pico-8' });
    await s.exporter
      .export('atk', { format: 'spritesheet', outputDir: join(real, 'projects', 'victim'), filename: 'project' })
      .catch(() => undefined);
    expect(existsSync(join(real, 'projects', 'victim', 'project.png')), 'export wrote into another project folder').toBe(false);
    await expect(fresh(link).read('victim', (d) => d.state.width)).resolves.toMatchObject({ value: 4 });
  });

  it('R7: an outputDir that is a symlink to another project folder overwrites its project.json', async () => {
    const dir = tempDir();
    const s = await createServices({ dataDir: dir, cacheSize: 4 });
    await s.projects.create({ name: 'victim', width: 4, height: 4, palette: 'pico-8' });
    await s.projects.create({ name: 'atk', width: 4, height: 4, palette: 'pico-8' });
    const out = tempDir();
    symlinkSync(join(dir, 'projects', 'victim'), join(out, 'shared'), 'junction');
    await s.exporter.export('atk', { format: 'spritesheet', outputDir: join(out, 'shared'), filename: 'project' }).catch(() => undefined);
    await expect(fresh(dir).read('victim', (d) => d.state.width)).resolves.toMatchObject({ value: 4 });
  });

  it('".." spellings, trailing slashes and absolute paths into the projects root are all refused (regression guard)', async () => {
    const dir = tempDir();
    const s = await createServices({ dataDir: dir, cacheSize: 4 });
    await s.projects.create({ name: 'victim', width: 4, height: 4, palette: 'pico-8' });
    await s.projects.create({ name: 'atk', width: 4, height: 4, palette: 'pico-8' });
    for (const od of [
      '..',
      '../',
      './../..',
      '../../victim',
      '../../victim/./',
      '../exports/../../victim',
      '../../victim/images',
      '../checkpoints',
      join(dir, 'projects', 'victim'),
      join(dir, 'projects', 'victim', 'images') + '/',
      join(dir, 'projects', 'atk'),
      `${dir}/projects/atk/exports/../images`,
    ]) {
      await expect(s.exporter.export('atk', { format: 'spritesheet', outputDir: od, filename: 'project' }), od).rejects.toThrow(/projects folder/);
    }
    // own exports folder (and sub-folders) stay allowed
    const ok = await s.exporter.export('atk', { format: 'png', outputDir: './sub' });
    expect(ok.files[0]!.path).toBe(join(dir, 'projects', 'atk', 'exports', 'sub', 'atk.png'));
    await expect(fresh(dir).read('victim', (d) => d.state.width)).resolves.toMatchObject({ value: 4 });
  });

  it('the projects root itself is refused as an outputDir (regression guard)', async () => {
    const dir = tempDir();
    const s = await createServices({ dataDir: dir, cacheSize: 4 });
    await s.projects.create({ name: 'atk', width: 4, height: 4, palette: 'pico-8' });
    await expect(s.exporter.export('atk', { format: 'png', outputDir: join(dir, 'projects') })).rejects.toThrow(/projects folder/);
  });
});

describe('D7 recheck: checkpoint restore', () => {
  it('R8: restoring a checkpoint whose .pxc file is missing gives a clean error and leaves no stray backup', async () => {
    const dir = tempDir();
    const s = await services(dir);
    await s.projects.create({ name: 'k', width: 8, height: 8, palette: 'pico-8' });
    const cp = await s.projects.createCheckpoint('k', 'base');
    rmSync(join(dir, 'projects', 'k', 'checkpoints', `${cp.id}.pxc`));
    const err = await s.projects.restoreCheckpoint('k', 'base').then(
      () => null,
      (e: unknown) => e as Error & { code?: string },
    );
    expect(err).not.toBeNull();
    expect(err!.code, String(err)).toMatch(/NOT_FOUND|INVALID_ARGUMENT/);
    expect((await s.projects.listCheckpoints('k')).map((c) => c.name)).toEqual(['base']);
  });

  it('R8 (minor): a blank checkpoint name is refused (it cannot be restored by name afterwards)', async () => {
    const s = await services();
    await s.projects.create({ name: 'k2', width: 8, height: 8, palette: 'pico-8' });
    await expect(s.projects.createCheckpoint('k2', '   ')).rejects.toThrow();
  });

  it('restore of a corrupted checkpoint keeps the current state (regression guard)', async () => {
    const dir = tempDir();
    const s = await services(dir);
    await s.projects.create({ name: 'k3', width: 8, height: 8, palette: 'pico-8' });
    await s.projects.mutate('k3', (doc) => draw(doc, { ops: [{ op: 'pixels', points: [[1, 1]], color: 8 }] }));
    const cp = await s.projects.createCheckpoint('k3', 'base');
    writeFileSync(join(dir, 'projects', 'k3', 'checkpoints', `${cp.id}.pxc`), 'garbage');
    await expect(s.projects.restoreCheckpoint('k3', 'base')).rejects.toThrow();
    expect(await census(fresh(dir), 'k3')).toEqual({ 'Layer 1': 1 });
  });
});

describe('palette import must not destroy art', () => {
  async function withArt() {
    const dir = tempDir();
    const s = await services(dir);
    await s.projects.create({ name: 'art', width: 8, height: 8, palette: 'pico-8' });
    await s.projects.mutate('art', (doc) => draw(doc, { ops: [{ op: 'rect', x: 0, y: 0, w: 8, h: 8, fill: 9 }] }));
    return { s, dir };
  }

  for (const [label, file, content] of [
    ['empty .hex', 'empty.hex', ''],
    ['text that is not a GIMP palette (.gpl)', 'junk.gpl', 'not a palette'],
    ['binary RIFF .pal', 'riff.pal', 'RIFF\u0010\u0000\u0000\u0000PAL data'],
  ] as const) {
    it(`R9: importing ${label} into a project is an error, not "palette replaced (0 colours), 64 pixel(s) remapped"`, async () => {
      const { s, dir } = await withArt();
      writeFileSync(join(dir, file), content);
      await s.importer.import({ project: 'art', path: join(dir, file) }).catch(() => undefined);
      expect(await census(s.projects, 'art')).toEqual({ 'Layer 1': 64 });
      const pal = await s.projects.read('art', (d) => d.state.palette.colors.length - 1);
      expect(pal.value).toBe(16);
    });
  }

  it('R10: a standard 768-byte Adobe .act (256 colours, no count trailer) can be imported', async () => {
    const dir = tempDir();
    const s = await services(dir);
    const act = new Uint8Array(768);
    for (let i = 0; i < 256; i++) act.set([i, 255 - i, (i * 7) & 255], i * 3);
    writeFileSync(join(dir, 'std.act'), act);
    const r = await s.importer.import({ path: join(dir, 'std.act') });
    expect(r.created).toBe(true);
  });

  it('R11: GPL colour names survive import (replace mode and new project)', async () => {
    const dir = tempDir();
    const s = await services(dir);
    writeFileSync(join(dir, 'named.gpl'), 'GIMP Palette\nName: Named\nColumns: 4\n#\n255 0 0\tFire Red\n0 255 0\tLeaf\n');
    await s.projects.create({ name: 'pal', width: 4, height: 4, palette: 'pico-8' });
    await s.importer.import({ project: 'pal', path: join(dir, 'named.gpl') });
    const names = await s.projects.read('pal', (d) => d.state.palette.names);
    expect(names.value).toMatchObject({ '1': 'Fire Red', '2': 'Leaf' });
    const created = await s.importer.import({ path: join(dir, 'named.gpl'), name: 'from-gpl' });
    const names2 = await s.projects.read(created.project, (d) => d.state.palette.names);
    expect(names2.value).toMatchObject({ '1': 'Fire Red', '2': 'Leaf' });
  });
});
