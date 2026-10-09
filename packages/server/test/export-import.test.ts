import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { addFrames, addTag, draw, moveCels } from '@pixelclaus/core';
import { decodePng, toBase64, writePalette } from '@pixelclaus/formats';
import { services, tempDir } from './helpers.js';

async function sample() {
  const s = await services();
  await s.projects.create({ name: 'blob', width: 8, height: 8, palette: 'pico-8', layers: ['Body', 'Eyes'] });
  await s.projects.mutate('blob', (doc) => {
    draw(doc, { layer: 'Body', ops: [{ op: 'circle', cx: 4, cy: 4, r: 3, fill: 12, color: 4 }] });
    draw(doc, {
      layer: 'Eyes',
      ops: [
        {
          op: 'pixels',
          points: [
            [3, 3],
            [5, 3],
          ],
          color: 1,
        },
      ],
    });
    addFrames(doc, { count: 3, cels: 'copy' });
    moveCels(doc, 'Body', [1, 3], { dy: 1 });
    addTag(doc, { name: 'bounce', from: 0, to: 3, direction: 'pingpong' });
  });
  return s;
}

describe('exports', () => {
  it('stills: png / jpg / webp with scale, layers and trim', async () => {
    const s = await sample();
    const png = await s.exporter.export('blob', { format: 'png', scale: 4 });
    expect(png.files[0]!.width).toBe(32);
    const meta = await sharp(png.files[0]!.path).metadata();
    expect(meta.width).toBe(32);
    const jpg = await s.exporter.export('blob', { format: 'jpg', background: '#000000' });
    expect((await sharp(jpg.files[0]!.path).metadata()).format).toBe('jpeg');
    const webp = await s.exporter.export('blob', { format: 'webp', trim: true });
    const wm = await sharp(webp.files[0]!.path).metadata();
    expect(wm.format).toBe('webp');
    expect(wm.width).toBe(7);
    const split = await s.exporter.export('blob', { format: 'png', splitLayers: true });
    expect(split.files.map((f) => basename(f.path))).toEqual(['blob-Body-f0.png', 'blob-Eyes-f0.png']);
    await expect(s.exporter.export('blob', { format: 'png', scale: 1.5 })).rejects.toThrow(/integer/);
  });

  it('animations: gif / apng / animated webp honour tags', async () => {
    const s = await sample();
    const gif = await s.exporter.export('blob', { format: 'gif', tag: 'bounce' });
    const gm = await sharp(gif.files[0]!.path, { animated: true }).metadata();
    expect(gm.pages).toBe(6); // ping-pong unrolled 0 1 2 3 2 1
    const webp = await s.exporter.export('blob', { format: 'webp_animated', scale: 2 });
    const wm = await sharp(webp.files[0]!.path, { animated: true }).metadata();
    expect(wm.pages).toBe(4);
    expect(wm.delay).toEqual([100, 100, 100, 100]);
    const apng = await s.exporter.export('blob', { format: 'apng', splitTags: true });
    expect(apng.files[0]!.path).toMatch(/blob-bounce\.png$/);
    expect(apng.files[0]!.frames).toBe(6);
    const frames = await s.exporter.export('blob', { format: 'frames', frames: { from: 0, to: 1 } });
    expect(frames.files.length).toBe(2);
  });

  it('sprite sheet with JSON, aseprite, pxc and palette files', async () => {
    const s = await sample();
    const sheet = await s.exporter.export('blob', {
      format: 'spritesheet',
      sheet: { layout: 'grid', columns: 2, padding: 1 },
    });
    expect(sheet.files.map((f) => f.path.split('.').pop())).toEqual(['png', 'json']);
    const json = JSON.parse(readFileSync(sheet.files[1]!.path, 'utf8'));
    expect(json.meta.frameTags[0].name).toBe('bounce');
    expect(Object.keys(json.frames).length).toBe(4);
    const ase = await s.exporter.export('blob', { format: 'aseprite' });
    const imp = await s.importer.import({ path: ase.files[0]!.path, name: 'reimported' });
    expect(imp.summary).toMatch(/2 layers, 4 frames, 1 tags/);
    const pxc = await s.exporter.export('blob', { format: 'pxc' });
    expect((await s.importer.import({ path: pxc.files[0]!.path })).created).toBe(true);
    const pal = await s.exporter.export('blob', { format: 'palette', paletteFormat: 'gpl' });
    expect(readFileSync(pal.files[0]!.path, 'utf8')).toMatch(/^GIMP Palette/);
  });

  it('palette variants (skins) and output dir', async () => {
    const s = await sample();
    const out = tempDir();
    const v = await s.exporter.export('blob', {
      format: 'png',
      outputDir: out,
      paletteVariants: [
        { name: 'gb', palette: 'gameboy' },
        { name: 'sweetie', palette: 'sweetie-16' },
      ],
    });
    expect(v.files.map((f) => f.path)).toEqual([
      join(out, 'blob-gb-f0.png'),
      join(out, 'blob-sweetie-f0.png'),
    ]);
    const a = decodePng(readFileSync(v.files[0]!.path));
    const b = decodePng(readFileSync(v.files[1]!.path));
    expect([...a.data]).not.toEqual([...b.data]);
  });

  it('download returns a zip for multi-file exports', async () => {
    const s = await sample();
    const d = await s.exporter.download('blob', { format: 'spritesheet' });
    expect(d.name).toMatch(/\.zip$/);
    expect(d.data[0]).toBe(0x50);
    const single = await s.exporter.download('blob', { format: 'gif' });
    expect(single.mime).toBe('image/gif');
  });
});

describe('imports', () => {
  it('png → new indexed project with exact palette', async () => {
    const s = await services();
    const dir = tempDir();
    const raw = Buffer.alloc(4 * 4 * 4);
    for (let i = 0; i < 16; i++) raw.set(i % 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4);
    const file = join(dir, 'tile.png');
    await sharp(raw, { raw: { width: 4, height: 4, channels: 4 } })
      .png()
      .toFile(file);
    const r = await s.importer.import({ path: file });
    expect(r.project).toBe('tile');
    expect(r.summary).toMatch(/4x4 indexed/);
    const px = await s.projects.read('tile', (doc) => doc.state.palette.colors.length);
    expect(px.value).toBe(3);
  });

  it('image into an existing project as a layer (base64)', async () => {
    const s = await sample();
    const buf = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ff004d' } })
      .png()
      .toBuffer();
    const r = await s.importer.import({
      project: 'blob',
      data: toBase64(new Uint8Array(buf)),
      filename: 'dot.png',
      layer: 'Dot',
      x: 1,
      y: 1,
    });
    expect(r.summary).toMatch(/new layer 'Dot'/);
    const v = await s.projects.read('blob', (doc) => {
      const l = doc.state.layers.find((x) => x.name === 'Dot')!;
      const cel = doc.state.cels.find((c) => c.layerId === l.id)!;
      return doc.image(cel.imageId).get(1, 1);
    });
    expect(v.value).toBe(9);
  });

  it('sprite sheets are sliced into frames, gifs become frames', async () => {
    const s = await sample();
    const sheet = await s.exporter.export('blob', {
      format: 'spritesheet',
      sheet: { layout: 'horizontal', mergeDuplicates: false },
    });
    const r = await s.importer.import({
      kind: 'spritesheet',
      path: sheet.files[0]!.path,
      frameWidth: 8,
      frameHeight: 8,
      duration: 80,
      name: 'sliced',
    });
    expect(r.summary).toMatch(/4 frame/);
    const gif = await s.exporter.export('blob', { format: 'gif' });
    const g = await s.importer.import({ path: gif.files[0]!.path, name: 'from-gif' });
    expect(g.summary).toMatch(/4 frame/);
  });

  it('palette files replace or append', async () => {
    const s = await sample();
    const dir = tempDir();
    const f = join(dir, 'pal.hex');
    writeFileSync(f, writePalette({ name: 'two', colors: ['#000000', '#ffffff'] }, 'hex'));
    const r = await s.importer.import({ project: 'blob', path: f });
    expect(r.summary).toMatch(/replaced/);
    const r2 = await s.importer.import({ project: 'blob', path: f, paletteMode: 'append' });
    expect(r2.summary).toMatch(/appended 2/);
  });

  it('restricted paths are refused', async () => {
    const s = await services();
    s.config.allowAnyPath = false;
    await expect(s.importer.import({ path: '/etc/hostname' })).rejects.toThrow(/outside/);
  });
});
