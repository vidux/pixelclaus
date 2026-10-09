import { describe, expect, it } from 'vitest';
import {
  addFrames,
  addLayer,
  addTag,
  compositeFrame,
  createDocument,
  draw,
  linkCels,
  Raster,
  setSlice,
  SpriteDocument,
  updateLayer,
  pack,
} from '@pixelclaus/core';
import {
  buildSpriteSheet,
  crc32,
  decodeGif,
  decodeImageBlob,
  decodePxc,
  decodePng,
  encodeApng,
  encodeGif,
  encodeImageBlob,
  encodePxc,
  encodePng,
  formatName,
  fromBase64,
  readAseprite,
  readPalette,
  sliceSheet,
  toBase64,
  writeAseprite,
  writePalette,
  rasterToPng,
  pngToRaster,
} from '../src/index.js';

function sample(): SpriteDocument {
  const doc = createDocument({
    name: 'hero',
    width: 8,
    height: 8,
    palette: 'pico-8',
    layers: ['Body', 'Eyes'],
  });
  draw(doc, { layer: 'Body', ops: [{ op: 'rect', x: 1, y: 1, w: 6, h: 6, color: 1, fill: 12 }] });
  draw(doc, {
    layer: 'Eyes',
    ops: [
      {
        op: 'pixels',
        points: [
          [3, 3],
          [5, 3],
        ],
        color: 8,
      },
    ],
  });
  addFrames(doc, { count: 2, cels: 'copy' });
  draw(doc, { layer: 'Eyes', frame: 1, ops: [{ op: 'clear' }] });
  linkCels(doc, 'Body', [0, 1, 2]);
  addTag(doc, { name: 'blink', from: 0, to: 2, direction: 'pingpong', repeat: 2 });
  setSlice(doc, { name: 'feet', bounds: { x: 1, y: 6, w: 6, h: 2 }, pivot: { x: 3, y: 1 } });
  return doc;
}

describe('bytes', () => {
  it('crc32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('base64 round-trip', () => {
    const b = Uint8Array.from([0, 1, 2, 250, 251, 252, 253]);
    expect([...fromBase64(toBase64(b))]).toEqual([...b]);
    expect(toBase64(new TextEncoder().encode('hi!'))).toBe('aGkh');
  });
});

describe('png', () => {
  it('round-trips indexed (few colours) and rgba (many colours)', () => {
    const r = new Raster(5, 3);
    r.set(0, 0, pack(255, 0, 0));
    r.set(1, 0, pack(0, 255, 0, 128));
    const png = encodePng({ width: 5, height: 3, data: r.data });
    const d = decodePng(png);
    expect(d.palette).toBeDefined();
    expect([...d.data]).toEqual([...r.data]);
    const big = new Raster(32, 32);
    for (let i = 0; i < 1024; i++) big.set(i % 32, Math.floor(i / 32), pack(i & 255, (i >> 2) & 255, 77));
    const d2 = decodePng(encodePng({ width: 32, height: 32, data: big.data }));
    expect(d2.palette).toBeUndefined();
    expect([...d2.data]).toEqual([...big.data]);
  });
  it('raster helpers', () => {
    const r = Raster.filled(2, 2, pack(1, 2, 3));
    expect([...pngToRaster(rasterToPng(r)).data]).toEqual([...r.data]);
  });
  it('rejects non-png', () => {
    expect(() => decodePng(new Uint8Array(10))).toThrow(/Not a PNG/);
  });
});

describe('apng', () => {
  it('writes acTL / fcTL / fdAT chunks', () => {
    const doc = sample();
    const frames = [0, 1, 2].map((f) => ({ image: compositeFrame(doc, { frame: f }), duration: 120 }));
    const bytes = encodeApng(frames);
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain('acTL');
    expect(text.split('fcTL').length - 1).toBe(3);
    expect(text).toContain('fdAT');
    // first frame decodes as a regular PNG
    expect([...decodePng(bytes).data]).toEqual([...frames[0]!.image.data]);
  });
});

describe('gif', () => {
  it('round-trips an animation through our decoder', () => {
    const doc = sample();
    const frames = [0, 1, 2].map((f) => ({
      image: compositeFrame(doc, { frame: f }),
      duration: f === 0 ? 5 : 105,
    }));
    const res = encodeGif(frames, { loops: 0 });
    expect(res.warnings.join()).toMatch(/clamped/);
    expect(res.warnings.join()).toMatch(/rounded/);
    const g = decodeGif(res.bytes);
    expect(g.frames.length).toBe(3);
    expect(g.frames[1]!.duration).toBe(110);
    for (let i = 0; i < 3; i++) expect([...g.frames[i]!.data]).toEqual([...frames[i]!.image.data]);
  });
  it('handles large frames (LZW table resets)', () => {
    const r = new Raster(128, 128);
    for (let y = 0; y < 128; y++)
      for (let x = 0; x < 128; x++) r.set(x, y, pack((x * 7) & 255, (y * 13) & 255, ((x ^ y) * 3) & 0xf0));
    const colors = new Set<number>();
    for (let i = 0; i < r.data.length; i += 4)
      colors.add((r.data[i]! << 16) | (r.data[i + 1]! << 8) | r.data[i + 2]!);
    const q = (m: Map<number, number>, max: number) => [...m.keys()].slice(0, max);
    const res = encodeGif([{ image: r, duration: 100 }], { quantize: q });
    const g = decodeGif(res.bytes);
    expect(g.width).toBe(128);
    if (colors.size <= 256) expect([...g.frames[0]!.data]).toEqual([...r.data]);
  });
});

describe('aseprite', () => {
  it('round-trips structure and pixels', () => {
    const doc = sample();
    updateLayer(doc, 'Eyes', { opacity: 200, blendMode: 'multiply', notes: 'eye layer' });
    addLayer(doc, { type: 'group', name: 'FX' });
    addLayer(doc, { name: 'Spark', parent: 'FX' });
    draw(doc, { layer: 'Spark', frame: 2, ops: [{ op: 'pixels', points: [[0, 0]], color: 11 }] });
    const bytes = writeAseprite(doc);
    const { snapshot, warnings } = readAseprite(bytes, 'hero');
    expect(warnings).toEqual([]);
    const back = new SpriteDocument(snapshot);
    expect(back.state.width).toBe(8);
    expect(back.state.frames.length).toBe(3);
    expect(
      back.state.layers.map((l) => [
        l.name,
        l.type,
        l.parentId ? back.state.layers.find((p) => p.id === l.parentId)!.name : null,
      ]),
    ).toEqual([
      ['Body', 'image', null],
      ['Eyes', 'image', null],
      ['FX', 'group', null],
      ['Spark', 'image', 'FX'],
    ]);
    const eyes = back.state.layers.find((l) => l.name === 'Eyes')!;
    expect(eyes).toMatchObject({ opacity: 200, blendMode: 'multiply', notes: 'eye layer' });
    expect(back.state.tags[0]).toMatchObject({
      name: 'blink',
      from: 0,
      to: 2,
      direction: 'pingpong',
      repeat: 2,
    });
    expect(back.state.slices[0]!.keys[0]).toMatchObject({
      bounds: { x: 1, y: 6, w: 6, h: 2 },
      pivot: { x: 3, y: 1 },
    });
    expect(back.state.palette.colors).toEqual(
      doc.state.palette.colors.map((c, i) => (i === 0 ? '#00000000' : c)),
    );
    // linked body cels stay linked
    const bodyId = back.state.layers[0]!.id;
    expect(new Set(back.state.cels.filter((c) => c.layerId === bodyId).map((c) => c.imageId)).size).toBe(1);
    for (let f = 0; f < 3; f++)
      expect([...compositeFrame(back, { frame: f }).data]).toEqual([
        ...compositeFrame(doc, { frame: f }).data,
      ]);
  });

  it('round-trips RGBA sprites', () => {
    const doc = createDocument({
      name: 'rgba',
      width: 4,
      height: 4,
      colorMode: 'rgba',
      settings: { paletteLock: false },
    });
    draw(doc, {
      ops: [
        {
          op: 'pixels',
          points: [
            [0, 0, '#12345680'],
            [3, 3, '#abcdef'],
          ],
        },
      ],
    });
    const back = new SpriteDocument(readAseprite(writeAseprite(doc)).snapshot);
    expect(back.state.colorMode).toBe('rgba');
    expect([...compositeFrame(back, { frame: 0 }).data]).toEqual([...compositeFrame(doc, { frame: 0 }).data]);
  });

  it('rejects other files', () => {
    expect(() => readAseprite(new Uint8Array(200))).toThrow(/magic/);
  });
});

describe('sprite sheets', () => {
  it('horizontal sheet with aseprite hash JSON', () => {
    const doc = sample();
    const res = buildSpriteSheet(doc, {
      layout: 'horizontal',
      mergeDuplicates: false,
      json: 'aseprite-hash',
      imageName: 'hero.png',
    });
    expect(res.raster.width).toBe(24);
    expect(res.raster.height).toBe(8);
    const json = res.json as {
      frames: Record<string, { frame: { x: number }; duration: number }>;
      meta: { frameTags: unknown[]; image: string; slices: unknown[] };
    };
    expect(Object.keys(json.frames)).toEqual(['hero-blink-00', 'hero-blink-01', 'hero-blink-02']);
    expect(json.frames['hero-blink-01']!.frame.x).toBe(8);
    expect(json.meta.frameTags).toHaveLength(1);
    expect(json.meta.image).toBe('hero.png');
  });

  it('dedupes, trims, pads, extrudes, scales and packs', () => {
    const doc = sample();
    const merged = buildSpriteSheet(doc, { layout: 'horizontal' });
    expect(merged.cells.filter((c) => c.duplicateOf !== undefined).length).toBe(1); // frames 0 and 2 identical
    const t = buildSpriteSheet(doc, {
      layout: 'grid',
      columns: 2,
      trim: true,
      padding: 1,
      border: 2,
      extrude: 1,
      scale: 2,
      json: 'aseprite-array',
      mergeDuplicates: false,
    });
    expect(t.cells[0]!.trimmed).toBe(true);
    expect(t.cells[0]!.sourceSize).toEqual({ w: 16, h: 16 });
    expect(Array.isArray((t.json as { frames: unknown[] }).frames)).toBe(true);
    const p = buildSpriteSheet(doc, { layout: 'packed', powerOfTwo: true });
    expect(Math.log2(p.raster.width) % 1).toBe(0);
    const tp = buildSpriteSheet(doc, { json: 'texturepacker' });
    expect((tp.json as { meta: { app: string } }).meta.app).toMatch(/texturepacker/);
  });

  it('rows layout and split layers', () => {
    const doc = sample();
    addTag(doc, { name: 'solo', from: 1, to: 1 });
    const rows = buildSpriteSheet(doc, { layout: 'rows', mergeDuplicates: false });
    expect(rows.raster.height).toBe(16);
    const split = buildSpriteSheet(doc, {
      splitLayers: true,
      layout: 'horizontal',
      mergeDuplicates: false,
      filename: '{layer}-{frame}',
    });
    expect(split.cells.map((c) => c.name)).toContain('Eyes-0');
  });

  it('slices a sheet back into frames', () => {
    const doc = sample();
    const sheet = buildSpriteSheet(doc, { layout: 'horizontal', mergeDuplicates: false }).raster;
    const frames = sliceSheet(sheet, { frameWidth: 8, frameHeight: 8 });
    expect(frames.length).toBe(3);
    expect([...frames[1]!.data]).toEqual([...compositeFrame(doc, { frame: 1 }).data]);
  });

  it('filename templates', () => {
    expect(formatName('{title}-{tag}-{tagframe:00}', { title: 'a', tag: 'walk', tagframe: 3 })).toBe(
      'a-walk-03',
    );
    expect(formatName('{title}-{tag}-{frame}', { title: 'a', frame: 3 })).toBe('a-3');
  });
});

describe('palette files', () => {
  it('round-trips all formats', () => {
    const p = {
      name: 'test',
      colors: ['#000000', '#ff8800', '#12ab34'],
      names: [undefined, 'orange', undefined],
    };
    for (const f of ['hex', 'gpl', 'pal', 'act'] as const) {
      const back = readPalette(writePalette(p, f), `test.${f}`);
      expect(back.colors, f).toEqual(p.colors);
    }
    expect(readPalette(writePalette(p, 'gpl'), 'x.gpl').names?.[1]).toBe('orange');
  });
});

describe('native containers', () => {
  it('image blobs store 1 or 4 bytes per pixel', () => {
    const doc = sample();
    const img = doc.image(doc.state.cels[0]!.imageId);
    expect(decodeImageBlob(encodeImageBlob(img)).equals(img)).toBe(true);
  });
  it('pxc round-trips a document', () => {
    const doc = sample();
    const back = new SpriteDocument(decodePxc(encodePxc(doc.snapshot())));
    expect(back.state).toEqual(doc.state);
    for (let f = 0; f < 3; f++)
      expect([...compositeFrame(back, { frame: f }).data]).toEqual([
        ...compositeFrame(doc, { frame: f }).data,
      ]);
  });
});
