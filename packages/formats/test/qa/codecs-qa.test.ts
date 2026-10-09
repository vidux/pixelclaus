/**
 * QA: codec correctness validated with an independent decoder (sharp/libvips) where possible.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  addFrames,
  addLayer,
  addTag,
  compositeFrame,
  createDocument,
  draw,
  linkCels,
  moveCels,
  Raster,
  select,
  setCelOpacity,
  setSlice,
  SpriteDocument,
  updateLayer,
  walkLayers,
} from '@pixelclaus/core';
import {
  buildSpriteSheet,
  decodeGif,
  decodePxc,
  decodePng,
  encodeApng,
  encodeGif,
  encodePxc,
  rasterToPng,
  readAseprite,
  readPalette,
  writeAseprite,
  writePalette,
  type SheetLayout,
} from '@pixelclaus/formats';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomRaster(w: number, h: number, seed: number, opts: { colors?: number; alpha?: 'binary' | 'any' } = {}): Raster {
  const r = new Raster(w, h);
  const rand = rng(seed);
  const pal = Array.from({ length: opts.colors ?? 1 << 24 }, () => 0).length <= 4096
    ? Array.from({ length: opts.colors! }, () => [Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256)])
    : null;
  for (let i = 0; i < w * h; i++) {
    const c = pal ? pal[Math.floor(rand() * pal.length)]! : [Math.floor(rand() * 256), Math.floor(rand() * 256), Math.floor(rand() * 256)];
    let a = 255;
    if (opts.alpha === 'binary') a = rand() < 0.3 ? 0 : 255;
    else if (opts.alpha === 'any') a = Math.floor(rand() * 256);
    if (a === 0) continue; // canonical transparent = all zero
    r.data.set([c[0]!, c[1]!, c[2]!, a], i * 4);
  }
  return r;
}

async function sharpRaw(bytes: Uint8Array, page = 0): Promise<{ data: Uint8Array; width: number; height: number }> {
  const { data, info } = await sharp(bytes, { page }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

/** Compare RGBA buffers treating every alpha-0 pixel as equal. */
function sameRgba(a: Uint8Array | Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray): number {
  let diff = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] === 0 && b[i + 3] === 0) continue;
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) diff++;
  }
  return diff;
}

describe('PNG encoder (validated with sharp)', () => {
  const cases: Array<[string, Raster]> = [
    ['1x1 opaque', randomRaster(1, 1, 1, { colors: 1 })],
    ['indexed ≤256 colours with binary alpha', randomRaster(37, 23, 2, { colors: 40, alpha: 'binary' })],
    ['exactly 256 colours', randomRaster(64, 64, 3, { colors: 256 })],
    ['> 256 colours truecolour', randomRaster(50, 40, 4)],
    ['semi-transparent truecolour', randomRaster(33, 17, 5, { alpha: 'any' })],
    ['semi-transparent few colours (tRNS)', randomRaster(20, 20, 6, { colors: 8, alpha: 'any' })],
    ['wide 4096x1', randomRaster(4096, 1, 7, { colors: 12 })],
  ];
  for (const [name, r] of cases) {
    it(name, async () => {
      const png = rasterToPng(r);
      const meta = await sharp(png).metadata();
      expect(meta.width).toBe(r.width);
      expect(meta.height).toBe(r.height);
      const raw = await sharpRaw(png);
      expect(sameRgba(raw.data, r.data)).toBe(0);
      // own decoder agrees too
      expect(sameRgba(decodePng(png).data, r.data)).toBe(0);
    });
  }
});

describe('PNG decoder vs sharp-encoded variants', () => {
  const src = randomRaster(19, 13, 9, { colors: 6, alpha: 'binary' });
  const base = () => sharp(Buffer.from(src.data), { raw: { width: 19, height: 13, channels: 4 } });
  const variants: Array<[string, () => Promise<Buffer>]> = [
    ['palette', () => base().png({ palette: true, colours: 16, dither: 0 }).toBuffer()],
    ['interlaced (Adam7)', () => base().png({ progressive: true }).toBuffer()],
    ['16-bit', () => base().toColourspace('rgb16').png().toBuffer()],
    ['grayscale', () => base().removeAlpha().greyscale().png().toBuffer()],
    ['grayscale + alpha', () => base().greyscale().png().toBuffer()],
  ];
  for (const [name, make] of variants) {
    it(name, async () => {
      const bytes = new Uint8Array(await make());
      const ref = await sharpRaw(bytes);
      const own = decodePng(bytes);
      expect(own.width).toBe(ref.width);
      // allow ±1 rounding from 16→8 bit reduction
      let worst = 0;
      for (let i = 0; i < own.data.length; i++) worst = Math.max(worst, Math.abs(own.data[i]! - ref.data[i]!));
      expect(worst).toBeLessThanOrEqual(1);
    });
  }
});

describe('GIF encoder', () => {
  it('> 256 colours is quantised (warning) and sharp decodes every frame', async () => {
    const frames = [0, 1, 2].map((i) => ({ image: randomRaster(24, 24, 20 + i), duration: 100 }));
    expect(() => encodeGif(frames)).toThrow(/quantiser/);
    const res = encodeGif(frames, { quantize: (colors, max) => [...colors.keys()].slice(0, max) });
    expect(res.warnings.join(' ')).toMatch(/quantised/);
    const meta = await sharp(res.bytes, { animated: true }).metadata();
    expect(meta.pages).toBe(3);
    expect(meta.delay).toEqual([100, 100, 100]);
  });

  it('transparency survives (1-bit) and semi-transparency warns', async () => {
    const img = randomRaster(16, 16, 30, { colors: 5, alpha: 'binary' });
    const res = encodeGif([{ image: img, duration: 50 }]);
    const raw = await sharpRaw(res.bytes);
    expect(sameRgba(raw.data, img.data)).toBe(0);
    const semi = randomRaster(8, 8, 31, { colors: 3, alpha: 'any' });
    expect(encodeGif([{ image: semi, duration: 50 }]).warnings.join(' ')).toMatch(/semi-transparent/);
  });

  it('own decoder round-trips frames, delays and cropped sub-frames', () => {
    const a = new Raster(10, 10);
    a.fillRect({ x: 2, y: 2, w: 3, h: 3 }, 0xff0000ff);
    const b = new Raster(10, 10);
    b.fillRect({ x: 6, y: 5, w: 2, h: 4 }, 0x00ff00ff);
    const res = encodeGif([{ image: a, duration: 120 }, { image: b, duration: 5 }], { loops: 3 });
    expect(res.warnings.join(' ')).toMatch(/clamped to 20 ms/);
    const dec = decodeGif(res.bytes);
    expect(dec.frames.length).toBe(2);
    expect(dec.frames.map((f) => f.duration)).toEqual([120, 20]);
    expect(sameRgba(dec.frames[0]!.data, a.data)).toBe(0);
    expect(sameRgba(dec.frames[1]!.data, b.data)).toBe(0);
  });

  it('fully transparent frame in the middle of an animation', async () => {
    const a = randomRaster(8, 8, 40, { colors: 3 });
    const empty = new Raster(8, 8);
    const res = encodeGif([{ image: a, duration: 100 }, { image: empty, duration: 100 }, { image: a, duration: 100 }]);
    const meta = await sharp(res.bytes, { animated: true }).metadata();
    expect(meta.pages).toBe(3);
    const mid = await sharpRaw(res.bytes, 1);
    expect(mid.data.filter((_, i) => i % 4 === 3).every((x) => x === 0)).toBe(true);
  });
});

describe('APNG encoder', () => {
  it('writes acTL/fcTL and every frame decodes (first frame via sharp, others via chunk parsing)', async () => {
    const frames = [0, 1, 2, 3].map((i) => {
      const r = new Raster(12, 12);
      r.fillRect({ x: i * 2, y: 3, w: 3, h: 3 }, 0x3366ccff);
      return { image: r, duration: 40 + i * 10 };
    });
    const bytes = encodeApng(frames, { loops: 2 });
    const first = await sharpRaw(bytes);
    expect(sameRgba(first.data, frames[0]!.image.data)).toBe(0);
    // parse chunks
    const types: string[] = [];
    let o = 8;
    let numFrames = -1;
    let plays = -1;
    const delays: number[] = [];
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    while (o < bytes.length) {
      const len = dv.getUint32(o);
      const type = String.fromCharCode(...bytes.subarray(o + 4, o + 8));
      types.push(type);
      if (type === 'acTL') {
        numFrames = dv.getUint32(o + 8);
        plays = dv.getUint32(o + 12);
      }
      if (type === 'fcTL') {
        const num = dv.getUint16(o + 8 + 20);
        const den = dv.getUint16(o + 8 + 22) || 100;
        delays.push(Math.round((num * 1000) / den));
      }
      o += 12 + len;
    }
    expect(numFrames).toBe(4);
    expect(plays).toBe(2);
    expect(delays).toEqual([40, 50, 60, 70]);
    expect(types.indexOf('acTL')).toBeLessThan(types.indexOf('IDAT'));
    expect(types.at(-1)).toBe('IEND');
  });
});

// ─── .aseprite ───

function richDoc(colorMode: 'indexed' | 'rgba'): SpriteDocument {
  const doc = createDocument({ name: 'rich', width: 20, height: 14, palette: 'pico-8', colorMode, layers: ['Body'], frames: 4, frameDuration: 80 });
  addLayer(doc, { name: 'FX', type: 'group' });
  addLayer(doc, { name: 'Glow', parent: 'FX', blendMode: 'screen', opacity: 180 });
  addLayer(doc, { name: 'Ref', type: 'reference' });
  updateLayer(doc, 'Body', { color: '#ff8800', notes: 'main body' });
  draw(doc, { layer: 'Body', ops: [{ op: 'rect', x: 2, y: 2, w: 8, h: 9, fill: 9, color: 1 }] });
  draw(doc, { layer: 'Glow', frame: 1, ops: [{ op: 'ellipse', x: 10, y: 3, w: 6, h: 6, fill: 10 }] });
  draw(doc, { layer: 'Ref', ops: [{ op: 'pixels', points: [[0, 0]], color: 12 }] });
  linkCels(doc, 'Body', [0, 1, 2]);
  draw(doc, { layer: 'Body', frame: 3, ops: [{ op: 'pixels', points: [[19, 13]], color: 8 }] });
  moveCels(doc, 'Body', [3], { dx: 1, dy: -1 });
  setCelOpacity(doc, 'Body', [3], 128);
  addTag(doc, { name: 'idle', from: 0, to: 2, direction: 'pingpong', repeat: 2, color: '#00ff00' });
  addTag(doc, { name: 'hit', from: 3, to: 3 });
  setSlice(doc, { name: 'hitbox', bounds: { x: 2, y: 2, w: 8, h: 9 }, pivot: { x: 4, y: 9 }, color: '#ff0000' });
  setSlice(doc, { name: 'panel', bounds: { x: 0, y: 0, w: 10, h: 10 }, center: { x: 2, y: 2, w: 6, h: 6 } });
  updateLayer(doc, 'FX', { visible: false });
  updateLayer(doc, 'Ref', { locked: true });
  doc.state.palette.names['9'] = 'red';
  return doc;
}

function fromSnapshot(s: ReturnType<typeof readAseprite>['snapshot']): SpriteDocument {
  return new SpriteDocument(s);
}

describe('.aseprite write → read round-trip', () => {
  for (const mode of ['indexed', 'rgba'] as const) {
    it(`${mode}: structure, pixels, links, tags, slices, user data`, () => {
      const doc = richDoc(mode);
      const back = fromSnapshot(readAseprite(writeAseprite(doc), 'rich').snapshot);
      const s = back.state;
      expect(s.colorMode).toBe(mode);
      expect([s.width, s.height]).toEqual([20, 14]);
      expect(s.frames.map((f) => f.duration)).toEqual([80, 80, 80, 80]);
      // compare in depth-first sibling order (global array order is not significant)
      const describeLayers = (st: SpriteDocument['state']) => {
        const out: unknown[] = [];
        walkLayers(st, (l) => out.push([l.name, l.type, l.parentId ? st.layers.find((p) => p.id === l.parentId)!.name : null, l.blendMode, l.opacity, l.visible, l.locked]));
        return out;
      };
      expect(describeLayers(s)).toEqual(describeLayers(doc.state));
      const body = s.layers.find((l) => l.name === 'Body')!;
      expect(body.color).toBe('#ff8800');
      expect(body.notes).toBe('main body');
      // linked cels survive
      const bodyCels = s.cels.filter((c) => c.layerId === body.id).sort((a, b) => a.frame - b.frame);
      expect(new Set(bodyCels.slice(0, 3).map((c) => c.imageId)).size).toBe(1);
      expect(bodyCels[3]!.opacity).toBe(128);
      expect(s.tags).toEqual(doc.state.tags.map((t) => ({ ...t, notes: t.notes })).map(({ notes: _n, ...t }) => expect.objectContaining(t)));
      expect(s.slices.map((x) => [x.name, x.color, x.keys])).toEqual(doc.state.slices.map((x) => [x.name, x.color, x.keys]));
      expect(s.palette.names['9']).toBe('red');
      // composite of every frame identical (include hidden + reference so every layer is compared)
      for (let f = 0; f < 4; f++) {
        const a = compositeFrame(doc, { frame: f, includeHidden: true });
        const b = compositeFrame(back, { frame: f, includeHidden: true });
        expect(sameRgba(a.data, b.data), `frame ${f}`).toBe(0);
      }
    });
  }

  it('256-entry indexed palette and index 255 pixels survive', () => {
    const colors = Array.from({ length: 255 }, (_, i) => `#${i.toString(16).padStart(2, '0')}${(255 - i).toString(16).padStart(2, '0')}80`);
    const doc = createDocument({ name: 'p', width: 4, height: 1, palette: colors });
    draw(doc, { layer: 'Layer 1', ops: [{ op: 'grid', rows: ['[255][128][1].'] }] });
    const back = fromSnapshot(readAseprite(writeAseprite(doc)).snapshot);
    expect(back.state.palette.colors.length).toBe(256);
    expect([...back.image(back.state.cels[0]!.imageId).data].slice(0, 3)).toEqual([255, 128, 1].map((v) => v));
  });

  it('cel linked across different offsets (same image) round-trips visually', () => {
    const doc = createDocument({ name: 'p', width: 8, height: 8, palette: 'pico-8', frames: 2 });
    draw(doc, { layer: 'Layer 1', ops: [{ op: 'pixels', points: [[1, 1]], color: 8 }] });
    linkCels(doc, 'Layer 1', [0, 1]);
    moveCels(doc, 'Layer 1', [1], { dx: 3 });
    const back = fromSnapshot(readAseprite(writeAseprite(doc)).snapshot);
    for (let f = 0; f < 2; f++) expect(sameRgba(compositeFrame(doc, { frame: f }).data, compositeFrame(back, { frame: f }).data)).toBe(0);
  });

  it('rejects garbage with a clear error', () => {
    expect(() => readAseprite(new Uint8Array(200))).toThrow(/Aseprite/);
    const good = writeAseprite(richDoc('rgba'));
    expect(() => readAseprite(good.slice(0, 300))).toThrow();
  });
});

// ─── sprite sheets ───

function animDoc(): SpriteDocument {
  const doc = createDocument({ name: 'hero', width: 16, height: 16, palette: 'pico-8', frames: 6 });
  for (let f = 0; f < 6; f++) draw(doc, { layer: 'Layer 1', frame: f, ops: [{ op: 'rect', x: 1 + f, y: 2, w: 4 + (f % 3), h: 6 + (f % 2), fill: 8 + f }] });
  addFrames(doc, { count: 1, cels: 'copy', source: 5 }); // frame 6 duplicates frame 5
  addTag(doc, { name: 'walk', from: 0, to: 3 });
  addTag(doc, { name: 'jump', from: 4, to: 6 });
  return doc;
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('sprite sheets', () => {
  const layouts: SheetLayout[] = ['horizontal', 'vertical', 'grid', 'rows', 'packed'];
  for (const layout of layouts) {
    for (const opt of [{}, { trim: true }, { padding: 2, border: 3, extrude: 1 }, { trim: true, extrude: 2, powerOfTwo: true, scale: 2 }, { mergeDuplicates: false, columns: 2 }]) {
      it(`${layout} ${JSON.stringify(opt)}: rects in bounds, no overlaps, pixels match the frames`, () => {
        const doc = animDoc();
        const sheet = buildSpriteSheet(doc, { layout, ...opt });
        const W = sheet.raster.width;
        const H = sheet.raster.height;
        const ext = (opt as { extrude?: number }).extrude ?? 0;
        const scale = (opt as { scale?: number }).scale ?? 1;
        const uniq = new Map<string, (typeof sheet.cells)[number]>();
        for (const c of sheet.cells) {
          expect(c.rect.x - ext).toBeGreaterThanOrEqual(0);
          expect(c.rect.y - ext).toBeGreaterThanOrEqual(0);
          expect(c.rect.x + c.rect.w + ext).toBeLessThanOrEqual(W);
          expect(c.rect.y + c.rect.h + ext).toBeLessThanOrEqual(H);
          // sheet rect must have the trimmed source size
          expect([c.rect.w, c.rect.h], c.name).toEqual([c.sourceRect.w, c.sourceRect.h]);
          expect(c.sourceRect.x + c.sourceRect.w).toBeLessThanOrEqual(c.sourceSize.w);
          uniq.set(`${c.rect.x},${c.rect.y}`, c);
          // pixel content equals the frame composite crop
          const frame = compositeFrame(doc, { frame: c.frame });
          const scaled = scale > 1 ? frame.scaled(scale) : frame;
          for (let y = 0; y < c.rect.h; y++)
            for (let x = 0; x < c.rect.w; x++) {
              const want = scaled.get(c.sourceRect.x + x, c.sourceRect.y + y);
              const got = sheet.raster.get(c.rect.x + x, c.rect.y + y);
              if (want !== got) throw new Error(`${c.name} pixel ${x},${y}: want ${want.toString(16)} got ${got.toString(16)}`);
            }
        }
        const list = [...uniq.values()].map((c) => ({ x: c.rect.x - ext, y: c.rect.y - ext, w: c.rect.w + 2 * ext, h: c.rect.h + 2 * ext }));
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) expect(overlaps(list[i]!, list[j]!), `${i} vs ${j}`).toBe(false);
        // JSON frames agree with cells
        const json = sheet.json as { frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }>; meta: { size: { w: number; h: number } } };
        expect(json.meta.size).toEqual({ w: W, h: H });
        expect(Object.keys(json.frames).length).toBe(sheet.cells.length);
      });
    }
  }

  it('dedupe does not merge trimmed frames of different shapes (2x3 vs 3x2 solid)', () => {
    const doc = createDocument({ name: 's', width: 8, height: 8, palette: 'pico-8', frames: 2 });
    draw(doc, { layer: 'Layer 1', frame: 0, ops: [{ op: 'rect', x: 1, y: 1, w: 2, h: 3, fill: 8 }] });
    draw(doc, { layer: 'Layer 1', frame: 1, ops: [{ op: 'rect', x: 1, y: 1, w: 3, h: 2, fill: 8 }] });
    const sheet = buildSpriteSheet(doc, { trim: true });
    for (const c of sheet.cells) expect([c.rect.w, c.rect.h], `frame ${c.frame}`).toEqual([c.sourceRect.w, c.sourceRect.h]);
  });

  it('frame names keep frame numbers for frames outside any tag', () => {
    const doc = createDocument({ name: 'hero', width: 8, height: 8, palette: 'pico-8', frames: 4 });
    for (let f = 0; f < 4; f++) draw(doc, { layer: 'Layer 1', frame: f, ops: [{ op: 'pixels', points: [[f, 0]], color: 8 }] });
    addTag(doc, { name: 'walk', from: 0, to: 1 });
    const sheet = buildSpriteSheet(doc, { layout: 'horizontal' });
    const names = sheet.cells.map((c) => c.name);
    expect(names.slice(0, 2)).toEqual(['hero-walk-00', 'hero-walk-01']);
    // untagged frames 2 and 3 currently become "hero" and "hero-1"
    expect(names[2]).toMatch(/2/);
    expect(names[3]).toMatch(/3/);
  });
});

// ─── palette files & pxc ───

describe('palette files', () => {
  const colors = ['#000000', '#ff004d', '#29adff', '#ffffff', '#123456'];
  const names = ['black', 'red', undefined, 'white', 'navy blue'];
  for (const fmt of ['hex', 'gpl', 'pal', 'act'] as const) {
    it(`${fmt} round-trip`, () => {
      const bytes = writePalette({ name: 'test', colors, names }, fmt);
      const back = readPalette(bytes, `test.${fmt}`);
      expect(back.colors).toEqual(colors);
      if (fmt === 'gpl') expect(back.names).toEqual(names);
    });
  }

  it('ACT with 256 colours', () => {
    const many = Array.from({ length: 256 }, (_, i) => `#${i.toString(16).padStart(2, '0')}0000`);
    expect(readPalette(writePalette({ name: 'x', colors: many }, 'act'), 'x.act').colors).toEqual(many);
  });

  it('a 768-byte .hex file is not mistaken for ACT', () => {
    const lines = Array.from({ length: 109 }, (_, i) => `${i.toString(16).padStart(2, '0')}aa0${i % 10}`).join('\n') + '\n';
    const bytes = new TextEncoder().encode(lines.padEnd(768, '\n'));
    expect(bytes.length).toBe(768);
    expect(readPalette(bytes, 'mine.hex').colors.length).toBe(109);
  });
});

describe('.pxc container', () => {
  it('round-trips state, images, masks, clipboards and counters', () => {
    const doc = richDoc('indexed');
    select(doc, { shape: 'ellipse', x: 1, y: 1, w: 6, h: 6, name: 'sel' });
    draw(doc, { layer: 'Body', ops: [{ op: 'copy', name: 'clip', area: { x: 0, y: 0, w: 5, h: 5 } }] });
    const snap = decodePxc(encodePxc(doc.snapshot()));
    const back = new SpriteDocument(snap);
    expect(JSON.stringify(back.state)).toBe(JSON.stringify(doc.state));
    expect(back.counters).toEqual(doc.counters);
    expect(back.mask(back.state.selections.sel!).count()).toBe(doc.mask(doc.state.selections.sel!).count());
    expect([...back.image(back.state.clipboards.clip!.imageId).data]).toEqual([...doc.image(doc.state.clipboards.clip!.imageId).data]);
  });

  it('truncated / corrupt .pxc fails loudly', () => {
    const bytes = encodePxc(richDoc('rgba').snapshot());
    expect(() => decodePxc(bytes.slice(0, 40))).toThrow();
    expect(() => decodePxc(new Uint8Array(64))).toThrow(/pxc/);
  });
});
