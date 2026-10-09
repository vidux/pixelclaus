/**
 * QA: storage & services — persistence across instances after undo/redo, external changes, concurrency,
 * checkpoints, id resolution / path traversal, delete, duplicate, allowAnyPath restrictions.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { addLayer, draw, duplicateFrame, removeFrames, removeLayer } from '@pixelclaus/core';
import { createServices, ProjectService, loadConfig } from '../../src/index.js';
import { services, tempDir } from '../helpers.js';

const L = 'Layer 1';

async function pixelAt(svc: ProjectService, ref: string, layer: string, frame: number, x: number, y: number): Promise<number> {
  const r = await svc.read(ref, (doc) => {
    const l = doc.state.layers.find((q) => q.name === layer || q.id === layer);
    if (!l) return -1;
    const cel = doc.state.cels.find((c) => c.layerId === l.id && c.frame === frame);
    return cel ? doc.image(cel.imageId).get(x - cel.x, y - cel.y) : 0;
  });
  return r.value;
}

function fresh(dir: string): ProjectService {
  return new ProjectService(loadConfig({ dataDir: dir }));
}

describe('persistence after undo/redo (images garbage-collected on disk)', () => {
  it('undo of a layer removal persists the restored layer pixels', async () => {
    const dir = tempDir();
    const s = await services(dir);
    await s.projects.create({ name: 'p', width: 8, height: 8, palette: 'pico-8', layers: ['A', 'B'] });
    await s.projects.mutate('p', (doc) => draw(doc, { layer: 'B', ops: [{ op: 'pixels', points: [[3, 3]], color: 8 }] }));
    await s.projects.mutate('p', (doc) => removeLayer(doc, 'B')); // save GCs B's image file
    await s.projects.history('p', 'undo'); // B is back in memory…
    expect(await pixelAt(s.projects, 'p', 'B', 0, 3, 3)).toBe(8);
    // …and must be back on disk too (another process / restart)
    expect(await pixelAt(fresh(dir), 'p', 'B', 0, 3, 3)).toBe(8);
  });

  it('redo of a drawn new layer persists its pixels', async () => {
    const dir = tempDir();
    const s = await services(dir);
    await s.projects.create({ name: 'p', width: 8, height: 8, palette: 'pico-8' });
    await s.projects.mutate('p', (doc) => {
      addLayer(doc, { name: 'New' });
    });
    await s.projects.mutate('p', (doc) => draw(doc, { layer: 'New', ops: [{ op: 'rect', x: 0, y: 0, w: 2, h: 2, fill: 9 }] })); // creates the cel image
    await s.projects.history('p', 'undo'); // cel gone → file GC'd
    await s.projects.history('p', 'redo'); // cel back (no image patch → not marked dirty)
    expect(await pixelAt(s.projects, 'p', 'New', 0, 1, 1)).toBe(9);
    expect(await pixelAt(fresh(dir), 'p', 'New', 0, 1, 1)).toBe(9);
  });

  it('same session: after undo, cache eviction (cacheSize 4) reloads the project from disk and the pixels are gone', async () => {
    const dir = tempDir();
    const s = await services(dir);
    await s.projects.create({ name: 'p', width: 8, height: 8, palette: 'pico-8', layers: ['A', 'B'] });
    await s.projects.mutate('p', (doc) => draw(doc, { layer: 'B', ops: [{ op: 'pixels', points: [[3, 3]], color: 8 }] }));
    await s.projects.mutate('p', (doc) => removeLayer(doc, 'B'));
    await s.projects.history('p', 'undo');
    for (let i = 0; i < 6; i++) await s.projects.create({ name: `other${i}`, width: 2, height: 2 }); // evicts 'p'
    // same ProjectService instance: the evicted project is reloaded from disk
    expect(await pixelAt(s.projects, 'p', 'B', 0, 3, 3)).toBe(8);
  });

  it('undo of frame removal persists the restored frame', async () => {
    const dir = tempDir();
    const s = await services(dir);
    await s.projects.create({ name: 'p', width: 8, height: 8, palette: 'pico-8' });
    await s.projects.mutate('p', (doc) => draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] }));
    await s.projects.mutate('p', (doc) => duplicateFrame(doc, 0));
    await s.projects.mutate('p', (doc) => draw(doc, { frame: 1, ops: [{ op: 'pixels', points: [[1, 0]], color: 9 }] }));
    await s.projects.mutate('p', (doc) => removeFrames(doc, [1]));
    await s.projects.history('p', 'undo');
    expect(await pixelAt(fresh(dir), 'p', L, 1, 1, 0)).toBe(9);
  });

  it('loading a project whose image file is missing warns instead of silently blanking', async () => {
    const dir = tempDir();
    const s = await services(dir);
    await s.projects.create({ name: 'p', width: 8, height: 8, palette: 'pico-8' });
    await s.projects.mutate('p', (doc) => draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] }));
    const imgDir = join(dir, 'projects', 'p', 'images');
    for (const f of readdirSync(imgDir)) writeFileSync(join(imgDir, f), 'garbage');
    const r = await fresh(dir).read('p', () => 1);
    expect(r.notices.join(' ')).toMatch(/missing|corrupt|unreadable/i);
  });
});

describe('external modification & concurrency', () => {
  it('detects a write by another instance and reports the overwrite', async () => {
    const dir = tempDir();
    const a = await services(dir);
    const b = await services(dir);
    await a.projects.create({ name: 'x', width: 4, height: 4, palette: 'pico-8' });
    await b.projects.read('x', () => 0);
    await new Promise((r) => setTimeout(r, 20));
    await a.projects.mutate('x', (doc) => draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] }));
    const r = await b.projects.read('x', (doc) => doc.image(doc.state.cels[0]!.imageId).get(0, 0));
    expect(r.value).toBe(8);
    expect(r.notices.join()).toMatch(/changed outside/);
  });

  it('64 concurrent mutations on one project and parallel mutations on several projects', async () => {
    const s = await services();
    await s.projects.create({ name: 'c', width: 8, height: 8, palette: 'pico-8' });
    await s.projects.create({ name: 'd', width: 8, height: 8, palette: 'pico-8' });
    const results = await Promise.all(
      Array.from({ length: 64 }, (_, i) =>
        s.projects.mutate(i % 2 ? 'c' : 'd', (doc) => draw(doc, { ops: [{ op: 'pixels', points: [[(i >> 1) % 8, (i >> 4) % 8]], color: 8 + (i % 4) }] })),
      ),
    );
    const revsC = results.filter((_, i) => i % 2).map((r) => r.revision);
    expect(new Set(revsC).size).toBe(32);
    expect(Math.max(...revsC)).toBe(33);
    const disk = await fresh(s.config.dataDir).read('c', (doc) => doc.image(doc.state.cels[0]!.imageId).data.filter((v) => v !== 0).length);
    expect(disk.value).toBe(32);
  });

  it('cache eviction (cacheSize 4) keeps every project intact', async () => {
    const s = await services();
    for (let i = 0; i < 7; i++) {
      await s.projects.create({ name: `e${i}`, width: 4, height: 4, palette: 'pico-8' });
      await s.projects.mutate(`e${i}`, (doc) => draw(doc, { ops: [{ op: 'pixels', points: [[i % 4, 0]], color: 8 }] }));
    }
    for (let i = 0; i < 7; i++) expect(await pixelAt(s.projects, `e${i}`, L, 0, i % 4, 0)).toBe(8);
  });

  it('a mutation that throws leaves disk and memory unchanged and revision unchanged', async () => {
    const s = await services();
    await s.projects.create({ name: 'f', width: 4, height: 4, palette: 'pico-8' });
    const before = (await s.projects.read('f', () => 0)).revision;
    await expect(s.projects.mutate('f', (doc) => draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }, { op: 'fill', x: 0, y: 0, color: 'nope' }] }))).rejects.toThrow();
    expect((await s.projects.read('f', () => 0)).revision).toBe(before);
    expect(await pixelAt(fresh(s.config.dataDir), 'f', L, 0, 0, 0)).toBe(0);
  });
});

describe('checkpoints', () => {
  it('restore creates a backup that itself can be restored', async () => {
    const s = await services();
    await s.projects.create({ name: 'cp', width: 4, height: 4, palette: 'pico-8' });
    await s.projects.mutate('cp', (doc) => draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 8 }] }));
    await s.projects.createCheckpoint('cp', 'red');
    await s.projects.mutate('cp', (doc) => draw(doc, { ops: [{ op: 'pixels', points: [[0, 0]], color: 12 }] }));
    const r = await s.projects.restoreCheckpoint('cp', 'red');
    expect(await pixelAt(s.projects, 'cp', L, 0, 0, 0)).toBe(8);
    await s.projects.restoreCheckpoint('cp', r.backup.name);
    expect(await pixelAt(s.projects, 'cp', L, 0, 0, 0)).toBe(12);
    // history is cleared by a restore
    expect((await s.projects.history('cp', 'undo')).value).toEqual([]);
  });

  it('two restores within the same second do not fail on the backup name', async () => {
    const s = await services();
    await s.projects.create({ name: 'cp2', width: 4, height: 4, palette: 'pico-8' });
    await s.projects.createCheckpoint('cp2', 'a');
    await s.projects.restoreCheckpoint('cp2', 'a');
    await expect(s.projects.restoreCheckpoint('cp2', 'a')).resolves.toBeTruthy();
  });

  it('restoring an unknown checkpoint fails without creating a stray backup checkpoint', async () => {
    const s = await services();
    await s.projects.create({ name: 'cp3', width: 4, height: 4, palette: 'pico-8' });
    await expect(s.projects.restoreCheckpoint('cp3', 'nope')).rejects.toThrow(/not found/);
    expect(await s.projects.listCheckpoints('cp3')).toEqual([]);
  });

  it('checkpoints persist across instances and survive the project being reloaded', async () => {
    const dir = tempDir();
    const s = await services(dir);
    await s.projects.create({ name: 'cp4', width: 4, height: 4, palette: 'pico-8' });
    await s.projects.createCheckpoint('cp4', 'one');
    const other = fresh(dir);
    expect((await other.listCheckpoints('cp4')).map((c) => c.name)).toEqual(['one']);
    await other.restoreCheckpoint('cp4', 'one');
  });
});

describe('ids, names and path traversal', () => {
  it('ids and names resolve; traversal-looking refs never escape the projects folder', async () => {
    const dir = tempDir();
    const s = await services(dir);
    await s.projects.create({ name: 'Hero Sprite', width: 4, height: 4 });
    expect(await s.projects.resolveId('hero-sprite')).toBe('hero-sprite');
    expect(await s.projects.resolveId('HERO SPRITE')).toBe('hero-sprite');
    expect(await s.projects.resolveId('  hero-sprite  ')).toBe('hero-sprite');
    // create a folder outside "projects" that looks like a project
    mkdirSync(join(dir, 'evil'), { recursive: true });
    writeFileSync(join(dir, 'evil', 'project.json'), JSON.stringify({ format: 'pixelclaus-project', state: { name: 'evil' } }));
    for (const ref of ['../evil', '..', '../../etc/passwd', 'hero-sprite/../hero-sprite', '%2e%2e', '/etc', 'a\\..\\b']) {
      await expect(s.projects.resolveId(ref), ref).rejects.toThrow(/not found|Invalid/);
    }
    await expect(s.projects.delete('../evil')).rejects.toThrow();
    expect(existsSync(join(dir, 'evil', 'project.json'))).toBe(true);
  });

  it('accented names slugify to readable ids (diacritics stripped, not turned into hyphens)', async () => {
    const s = await services();
    const a = await s.projects.create({ name: 'Ñandú Café', width: 4, height: 4 });
    expect(a.id).toBe('nandu-cafe'); // currently 'n-andu-cafe'
  });

  it('names that slugify identically get distinct ids; unicode-only names get a fallback id', async () => {
    const s = await services();
    const a = await s.projects.create({ name: 'Nandu!', width: 4, height: 4 });
    const b = await s.projects.create({ name: 'nandu', width: 4, height: 4 });
    expect(a.id).toBe('nandu');
    expect(b.id).toBe('nandu-2');
    const c = await s.projects.create({ name: '勇者', width: 4, height: 4 });
    expect(c.id).toMatch(/^sprite/);
    // the unicode name is still addressable by name
    expect(await s.projects.resolveId('勇者')).toBe(c.id);
    await expect(s.projects.create({ name: '   ', width: 4, height: 4 })).rejects.toThrow(/name/);
  });

  it('duplicate copies content (not history / checkpoints); delete removes the folder', async () => {
    const dir = tempDir();
    const s = await services(dir);
    await s.projects.create({ name: 'orig', width: 4, height: 4, palette: 'pico-8' });
    await s.projects.mutate('orig', (doc) => draw(doc, { ops: [{ op: 'pixels', points: [[1, 1]], color: 8 }] }));
    await s.projects.createCheckpoint('orig', 'c1');
    const dup = await s.projects.duplicate('orig');
    expect(dup.id).toBe('orig-copy');
    expect(await pixelAt(fresh(dir), 'orig-copy', L, 0, 1, 1)).toBe(8);
    expect(await s.projects.listCheckpoints('orig-copy')).toEqual([]);
    expect((await s.projects.history('orig-copy', 'undo')).value).toEqual([]);
    await s.projects.delete('orig');
    expect(existsSync(join(dir, 'projects', 'orig'))).toBe(false);
    await expect(s.projects.read('orig', () => 0)).rejects.toThrow(/not found/);
    await expect(s.projects.delete('orig')).rejects.toThrow(/not found/);
  });
});

describe('allowAnyPath = false', () => {
  it('export outputDir and import path must stay inside the data dir', async () => {
    const dir = tempDir();
    const outside = tempDir();
    const s = await createServices({ dataDir: dir, allowAnyPath: false, cacheSize: 4 });
    await s.projects.create({ name: 'pa', width: 4, height: 4, palette: 'pico-8' });
    await expect(s.exporter.export('pa', { format: 'png', outputDir: outside })).rejects.toThrow(/outside the PixelClaus data directory/);
    // relative outputDir resolves against <data>/projects/pa/exports, so 4 levels up leaves the data dir
    await expect(s.exporter.export('pa', { format: 'png', outputDir: '../../../../escape' })).rejects.toThrow(/outside/);
    await expect(s.exporter.export('pa', { format: 'png', outputDir: '~/x' })).rejects.toThrow(/outside/);
    const ok = await s.exporter.export('pa', { format: 'png', outputDir: join(dir, 'out') });
    expect(ok.files[0]!.path.startsWith(dir)).toBe(true);
    writeFileSync(join(outside, 'x.png'), 'x');
    await expect(s.importer.import({ path: join(outside, 'x.png') })).rejects.toThrow(/outside/);
    await expect(s.importer.import({ path: '../' + basename(outside) + '/x.png' })).rejects.toThrow(/outside/);
  });

  it('a data dir with a sibling sharing its prefix is not considered "inside"', async () => {
    const base = tempDir();
    const dir = join(base, 'data');
    const sibling = join(base, 'data-evil');
    mkdirSync(sibling, { recursive: true });
    const s = await createServices({ dataDir: dir, allowAnyPath: false, cacheSize: 4 });
    await s.projects.create({ name: 'pb', width: 4, height: 4, palette: 'pico-8' });
    await expect(s.exporter.export('pb', { format: 'png', outputDir: sibling })).rejects.toThrow(/outside/);
  });

  it('export cannot overwrite a project manifest (outputDir "..", filename "project", spritesheet JSON)', async () => {
    const dir = tempDir();
    const s = await createServices({ dataDir: dir, allowAnyPath: false, cacheSize: 4 });
    await s.projects.create({ name: 'victim', width: 4, height: 4, palette: 'pico-8' });
    await s.projects.create({ name: 'pd', width: 4, height: 4, palette: 'pico-8' });
    // relative to <data>/projects/pd/exports → <data>/projects/victim/project.json
    await s.exporter.export('pd', { format: 'spritesheet', outputDir: '../../victim', filename: 'project' }).catch(() => undefined);
    await s.exporter.export('pd', { format: 'spritesheet', outputDir: '..', filename: 'project' }).catch(() => undefined);
    const other = fresh(dir);
    await expect(other.read('victim', (d) => d.state.width)).resolves.toMatchObject({ value: 4 });
    await expect(other.read('pd', (d) => d.state.width)).resolves.toMatchObject({ value: 4 });
  });

  it('export filename cannot traverse out of the output dir', async () => {
    const dir = tempDir();
    const s = await createServices({ dataDir: dir, allowAnyPath: false, cacheSize: 4 });
    await s.projects.create({ name: 'pc', width: 4, height: 4, palette: 'pico-8' });
    const r = await s.exporter.export('pc', { format: 'png', filename: '../../../../tmp/pwned' });
    expect(r.files[0]!.path.startsWith(join(dir, 'projects', 'pc', 'exports'))).toBe(true);
  });

  it('defaults: allowAnyPath is ON unless PIXELCLAUS_ALLOW_ANY_PATH=0 (documented risk)', () => {
    expect(loadConfig({}, {}).allowAnyPath).toBe(true);
    expect(loadConfig({}, { PIXELCLAUS_ALLOW_ANY_PATH: '0' }).allowAnyPath).toBe(false);
  });
});
