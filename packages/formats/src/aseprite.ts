/**
 * .aseprite / .ase reader and writer (file format v1.3).
 * Supported: RGBA / grayscale / indexed sprites, layers & groups (flags, blend, opacity), cels (raw,
 * zlib-compressed, linked), tags (+ colours via user data), palettes (new + legacy chunks), slices
 * (9-patch, pivot), user data on layers/cels/tags/slices, pixel ratio and grid.
 * Skipped: tilemaps/tilesets, external files, properties maps, colour profiles beyond sRGB.
 */
import { unzlibSync, zlibSync } from 'fflate';
import {
  BLEND_MODES,
  getCel,
  newLayer,
  PixelBuffer,
  slugify,
  walkLayers,
  type BlendMode,
  type CelState,
  type DocumentSnapshot,
  type LayerState,
  type Mask,
  type SliceState,
  type SpriteDocument,
  type SpriteState,
  type TagDirection,
  type TagState,
  DEFAULT_SETTINGS,
  paletteValues,
  detectRamps,
  layerDepth,
} from '@pixelclaus/core';
import { ByteReader, ByteWriter, utf8Decode, utf8Encode } from './bytes.js';

const HEADER_MAGIC = 0xa5e0;
const FRAME_MAGIC = 0xf1fa;
const CHUNK = {
  OLD_PALETTE: 0x0004,
  OLD_PALETTE_64: 0x0011,
  LAYER: 0x2004,
  CEL: 0x2005,
  CEL_EXTRA: 0x2006,
  COLOR_PROFILE: 0x2007,
  TAGS: 0x2018,
  PALETTE: 0x2019,
  USER_DATA: 0x2020,
  SLICE: 0x2022,
} as const;

const DIRECTIONS: TagDirection[] = ['forward', 'reverse', 'pingpong', 'pingpong_reverse'];

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

function readString(r: ByteReader): string {
  const n = r.u16();
  return utf8Decode(r.bytes(n));
}

function writeString(w: ByteWriter, s: string): void {
  const b = utf8Encode(s);
  w.u16(b.length).bytes(b);
}

export interface AsepriteReadResult {
  snapshot: DocumentSnapshot;
  warnings: string[];
}

interface UserDataTarget {
  setText(t: string): void;
  setColor(hex: string): void;
}

/** Parse an .aseprite file into a PixelClaus document snapshot. */
export function readAseprite(bytes: Uint8Array, name = 'imported'): AsepriteReadResult {
  const r = new ByteReader(bytes, true);
  const warnings: string[] = [];
  r.u32(); // file size
  if (r.u16() !== HEADER_MAGIC) throw new Error('Not an Aseprite file (bad magic)');
  const frameCount = r.u16();
  const width = r.u16();
  const height = r.u16();
  const depth = r.u16();
  const flags = r.u32();
  r.u16(); // speed
  r.u32();
  r.u32();
  const transparentIndex = r.u8();
  r.skip(3);
  r.u16(); // number of colours
  const pxW = r.u8();
  const pxH = r.u8();
  const gridX = r.i16();
  const gridY = r.i16();
  const gridW = r.u16();
  const gridH = r.u16();
  r.skip(84);
  if (![8, 16, 32].includes(depth)) throw new Error(`Unsupported colour depth ${depth}`);
  const indexed = depth === 8;
  const layerOpacityValid = (flags & 1) !== 0;

  const aseLayers: Array<LayerState & { childLevel: number; aseType: number }> = [];
  const asePalette: Array<{ c: number; name?: string }> = [];
  const cels: Array<{
    layerIndex: number;
    frame: number;
    x: number;
    y: number;
    opacity: number;
    z: number;
    w?: number;
    h?: number;
    pixels?: Uint8Array;
    link?: number;
    notes?: string;
  }> = [];
  const tags: TagState[] = [];
  const slices: SliceState[] = [];
  const durations: number[] = [];
  let pendingTagUserData: TagState[] = [];
  let lastTarget: UserDataTarget | null = null;
  let layerIdN = 0;

  for (let f = 0; f < frameCount; f++) {
    const frameStart = r.pos;
    const frameBytes = r.u32();
    if (r.u16() !== FRAME_MAGIC) throw new Error(`Frame ${f}: bad magic`);
    const oldChunks = r.u16();
    durations.push(r.u16() || 100);
    r.skip(2);
    const newChunks = r.u32();
    const chunks = newChunks || oldChunks;
    for (let c = 0; c < chunks; c++) {
      const cStart = r.pos;
      const size = r.u32();
      const type = r.u16();
      const end = cStart + size;
      switch (type) {
        case CHUNK.LAYER: {
          const lf = r.u16();
          const lt = r.u16();
          const child = r.u16();
          r.u16();
          r.u16();
          const blend = r.u16();
          const opacity = r.u8();
          r.skip(3);
          const lname = readString(r);
          if (lt === 2) warnings.push(`Tilemap layer '${lname}' imported as an empty image layer`);
          const id = `L${++layerIdN}`;
          const layer = {
            ...newLayer(id, lname, {
              type: lt === 1 ? 'group' : lf & 64 ? 'reference' : 'image',
              visible: (lf & 1) !== 0,
              locked: (lf & 2) === 0,
              isBackground: (lf & 8) !== 0,
              continuous: (lf & 16) !== 0,
              collapsed: (lf & 32) !== 0,
              opacity: layerOpacityValid ? opacity : 255,
              blendMode: (BLEND_MODES[blend] ?? 'normal') as BlendMode,
            }),
            childLevel: child,
            aseType: lt,
          };
          aseLayers.push(layer);
          lastTarget = { setText: (t) => (layer.notes = t), setColor: (h) => (layer.color = h.slice(0, 7)) };
          break;
        }
        case CHUNK.CEL: {
          const layerIndex = r.u16();
          const x = r.i16();
          const y = r.i16();
          const opacity = r.u8();
          const ct = r.u16();
          const z = r.i16();
          r.skip(5);
          const cel: (typeof cels)[number] = { layerIndex, frame: f, x, y, opacity, z };
          if (ct === 0 || ct === 2) {
            cel.w = r.u16();
            cel.h = r.u16();
            const raw = r.bytes(end - r.pos);
            cel.pixels = ct === 2 ? unzlibSync(raw) : raw.slice();
          } else if (ct === 1) cel.link = r.u16();
          else warnings.push(`Frame ${f}: tilemap cel skipped`);
          if (ct !== 3) cels.push(cel);
          lastTarget = { setText: (t) => (cel.notes = t), setColor: () => {} };
          break;
        }
        case CHUNK.PALETTE: {
          const size = r.u32();
          const from = r.u32();
          const to = r.u32();
          r.skip(8);
          while (asePalette.length < size) asePalette.push({ c: 0xff });
          for (let i = from; i <= to; i++) {
            const ef = r.u16();
            const rr = r.u8();
            const gg = r.u8();
            const bb = r.u8();
            const aa = r.u8();
            const entry: { c: number; name?: string } = {
              c: ((rr << 24) | (gg << 16) | (bb << 8) | aa) >>> 0,
            };
            if (ef & 1) entry.name = readString(r);
            asePalette[i] = entry;
          }
          lastTarget = null;
          break;
        }
        case CHUNK.OLD_PALETTE:
        case CHUNK.OLD_PALETTE_64: {
          if (asePalette.length) break; // new palette chunk wins
          const packets = r.u16();
          let idx = 0;
          for (let p = 0; p < packets; p++) {
            idx += r.u8();
            let n = r.u8();
            if (n === 0) n = 256;
            for (let k = 0; k < n; k++) {
              let rr = r.u8();
              let gg = r.u8();
              let bb = r.u8();
              if (type === CHUNK.OLD_PALETTE_64) {
                rr = (rr << 2) | (rr >> 4);
                gg = (gg << 2) | (gg >> 4);
                bb = (bb << 2) | (bb >> 4);
              }
              asePalette[idx++] = { c: ((rr << 24) | (gg << 16) | (bb << 8) | 255) >>> 0 };
            }
          }
          break;
        }
        case CHUNK.TAGS: {
          const n = r.u16();
          r.skip(8);
          pendingTagUserData = [];
          for (let i = 0; i < n; i++) {
            const from = r.u16();
            const to = r.u16();
            const dir = r.u8();
            const repeat = r.u16();
            r.skip(6);
            const rr = r.u8();
            const gg = r.u8();
            const bb = r.u8();
            r.u8();
            const tname = readString(r);
            const tag: TagState = {
              name: tname,
              from,
              to,
              direction: DIRECTIONS[dir] ?? 'forward',
              repeat,
              color: `#${hex2(rr)}${hex2(gg)}${hex2(bb)}`,
            };
            tags.push(tag);
            pendingTagUserData.push(tag);
          }
          lastTarget = null;
          break;
        }
        case CHUNK.USER_DATA: {
          const uf = r.u32();
          let text: string | undefined;
          let color: string | undefined;
          if (uf & 1) text = readString(r);
          if (uf & 2) {
            const rr = r.u8();
            const gg = r.u8();
            const bb = r.u8();
            const aa = r.u8();
            color = `#${hex2(rr)}${hex2(gg)}${hex2(bb)}${hex2(aa)}`;
          }
          let target = lastTarget;
          if (!target && pendingTagUserData.length) {
            const tag = pendingTagUserData.shift()!;
            target = { setText: (t) => (tag.notes = t), setColor: (h) => (tag.color = h.slice(0, 7)) };
          }
          if (target) {
            if (text !== undefined) target.setText(text);
            if (color !== undefined) target.setColor(color);
          }
          lastTarget = null;
          break;
        }
        case CHUNK.SLICE: {
          const nkeys = r.u32();
          const sf = r.u32();
          r.u32();
          const sname = readString(r);
          const slice: SliceState = { name: sname, color: '#0000ff', keys: [] };
          for (let k = 0; k < nkeys; k++) {
            const frame = r.u32();
            const bounds = { x: r.i32(), y: r.i32(), w: r.u32(), h: r.u32() };
            const key: SliceState['keys'][number] = { frame, bounds };
            if (sf & 1) key.center = { x: r.i32(), y: r.i32(), w: r.u32(), h: r.u32() };
            if (sf & 2) key.pivot = { x: r.i32(), y: r.i32() };
            slice.keys.push(key);
          }
          slices.push(slice);
          lastTarget = { setText: (t) => (slice.notes = t), setColor: (h) => (slice.color = h.slice(0, 7)) };
          break;
        }
        default:
          break;
      }
      r.pos = end;
    }
    r.pos = frameStart + frameBytes;
  }

  // ── build palette: index 0 reserved transparent; aseprite index t (transparent) is dropped
  const palHex: string[] = ['#00000000'];
  const names: Record<string, string> = {};
  const mapIndex = new Map<number, number>();
  asePalette.forEach((e, i) => {
    if (indexed && i === transparentIndex) {
      mapIndex.set(i, 0);
      return;
    }
    if (!indexed && (e.c & 255) === 0) return;
    if (palHex.length >= 256) return;
    mapIndex.set(i, palHex.length);
    if (e.name) names[String(palHex.length)] = e.name;
    palHex.push(
      `#${hex2(e.c >>> 24)}${hex2((e.c >>> 16) & 255)}${hex2((e.c >>> 8) & 255)}${hex2(e.c & 255)}`,
    );
  });

  // ── layers: resolve parents from child levels
  const stack: string[] = [];
  const layers: LayerState[] = aseLayers.map((l) => {
    stack.length = l.childLevel;
    const parentId = l.childLevel > 0 ? (stack[l.childLevel - 1] ?? null) : null;
    stack[l.childLevel] = l.id;
    const { childLevel: _c, aseType: _t, ...rest } = l;
    return { ...rest, parentId };
  });

  // ── cels
  const images = new Map<string, PixelBuffer>();
  let imageN = 0;
  const celStates: CelState[] = [];
  const byLayerFrame = new Map<string, CelState>();
  const bgLayers = new Set(layers.filter((l) => l.isBackground).map((l) => l.id));
  for (const c of cels.filter((x) => x.pixels)) {
    const layer = layers[c.layerIndex];
    if (!layer || layer.type === 'group') continue;
    const w = c.w!;
    const h = c.h!;
    const buf = new PixelBuffer(w, h);
    const px = c.pixels!;
    const bg = bgLayers.has(layer.id);
    for (let i = 0; i < w * h; i++) {
      if (depth === 32) {
        const a = px[i * 4 + 3]!;
        buf.data[i] =
          a === 0 ? 0 : ((px[i * 4]! << 24) | (px[i * 4 + 1]! << 16) | (px[i * 4 + 2]! << 8) | a) >>> 0;
      } else if (depth === 16) {
        const v = px[i * 2]!;
        const a = px[i * 2 + 1]!;
        buf.data[i] = a === 0 ? 0 : ((v << 24) | (v << 16) | (v << 8) | a) >>> 0;
      } else {
        const v = px[i]!;
        if (v === transparentIndex && !bg) buf.data[i] = 0;
        else buf.data[i] = mapIndex.get(v) ?? 0;
      }
    }
    const imageId = `i${++imageN}`;
    images.set(imageId, buf);
    const cel: CelState = {
      layerId: layer.id,
      frame: c.frame,
      imageId,
      x: c.x,
      y: c.y,
      opacity: c.opacity,
      zIndex: c.z,
      ...(c.notes ? { notes: c.notes } : {}),
    };
    celStates.push(cel);
    byLayerFrame.set(`${layer.id}@${c.frame}`, cel);
  }
  for (const c of cels.filter((x) => x.link !== undefined)) {
    const layer = layers[c.layerIndex];
    if (!layer) continue;
    const src = byLayerFrame.get(`${layer.id}@${c.link}`);
    if (!src) {
      warnings.push(`Linked cel at frame ${c.frame} points to missing frame ${c.link}`);
      continue;
    }
    const cel: CelState = { ...src, frame: c.frame, x: c.x, y: c.y, opacity: c.opacity, zIndex: c.z };
    celStates.push(cel);
    byLayerFrame.set(`${layer.id}@${c.frame}`, cel);
  }

  const now = new Date().toISOString();
  const state: SpriteState = {
    version: 1,
    id: slugify(name),
    name,
    width,
    height,
    colorMode: indexed ? 'indexed' : 'rgba',
    pixelRatio: { x: pxW && pxH ? pxW : 1, y: pxW && pxH ? pxH : 1 },
    grid: { x: gridX, y: gridY, w: gridW || 16, h: gridH || 16 },
    palette: { name: 'aseprite', colors: palHex, names, ramps: [] },
    layers,
    frames: durations.map((d) => ({ duration: d })),
    cels: celStates,
    tags,
    slices,
    selections: {},
    clipboards: {},
    settings: { ...DEFAULT_SETTINGS, paletteLock: indexed },
    notes: '',
    created: now,
    modified: now,
  };
  state.palette.ramps = detectRamps(paletteValues(state.palette));
  if (depth === 16) warnings.push('Grayscale sprite imported in RGBA mode');
  return {
    snapshot: {
      state,
      images,
      masks: new Map<string, Mask>(),
      counters: { layer: layerIdN, image: imageN, mask: 0 },
    },
    warnings,
  };
}

// ───────────────────────────── writer ─────────────────────────────

function chunkStart(w: ByteWriter, type: number): number {
  const at = w.length;
  w.u32(0).u16(type);
  return at;
}

function chunkEnd(w: ByteWriter, at: number): void {
  w.patchU32(at, w.length - at);
}

function userData(w: ByteWriter, text?: string, color?: string): boolean {
  if (!text && !color) return false;
  const at = chunkStart(w, CHUNK.USER_DATA);
  w.u32((text ? 1 : 0) | (color ? 2 : 0));
  if (text) writeString(w, text);
  if (color) {
    const h = color.replace('#', '').padEnd(8, 'f');
    w.u8(parseInt(h.slice(0, 2), 16))
      .u8(parseInt(h.slice(2, 4), 16))
      .u8(parseInt(h.slice(4, 6), 16))
      .u8(parseInt(h.slice(6, 8), 16));
  }
  chunkEnd(w, at);
  return true;
}

/** Serialise a document to .aseprite bytes. */
export function writeAseprite(doc: SpriteDocument): Uint8Array {
  const st = doc.state;
  const indexed = st.colorMode === 'indexed';
  const w = new ByteWriter(64 * 1024, true);
  // header
  w.u32(0)
    .u16(HEADER_MAGIC)
    .u16(st.frames.length)
    .u16(st.width)
    .u16(st.height)
    .u16(indexed ? 8 : 32);
  w.u32(1 | 2)
    .u16(st.frames[0]?.duration ?? 100)
    .u32(0)
    .u32(0);
  w.u8(0).zeros(3).u16(st.palette.colors.length);
  w.u8(st.pixelRatio.x)
    .u8(st.pixelRatio.y)
    .i16(st.grid.x)
    .i16(st.grid.y)
    .u16(st.grid.w)
    .u16(st.grid.h)
    .zeros(84);

  // layer order: depth-first, bottom → top siblings, groups before children
  const order: LayerState[] = [];
  walkLayers(st, (l) => order.push(l));
  const layerIndex = new Map(order.map((l, i) => [l.id, i]));
  const pal = paletteValues(st.palette);

  for (let f = 0; f < st.frames.length; f++) {
    const frameAt = w.length;
    w.u32(0).u16(FRAME_MAGIC).u16(0).u16(st.frames[f]!.duration).zeros(2).u32(0);
    let chunks = 0;
    if (f === 0) {
      // colour profile: sRGB
      let at = chunkStart(w, CHUNK.COLOR_PROFILE);
      w.u16(1).u16(0).u32(0).zeros(8);
      chunkEnd(w, at);
      chunks++;
      // palette (new chunk)
      at = chunkStart(w, CHUNK.PALETTE);
      w.u32(pal.length)
        .u32(0)
        .u32(pal.length - 1)
        .zeros(8);
      pal.forEach((c, i) => {
        const nm = st.palette.names[String(i)];
        w.u16(nm ? 1 : 0)
          .u8(c >>> 24)
          .u8((c >>> 16) & 255)
          .u8((c >>> 8) & 255)
          .u8(i === 0 ? 0 : c & 255);
        if (nm) writeString(w, nm);
      });
      chunkEnd(w, at);
      chunks++;
      // legacy palette for old readers
      at = chunkStart(w, CHUNK.OLD_PALETTE);
      w.u16(1)
        .u8(0)
        .u8(pal.length === 256 ? 0 : pal.length);
      for (const c of pal)
        w.u8(c >>> 24)
          .u8((c >>> 16) & 255)
          .u8((c >>> 8) & 255);
      chunkEnd(w, at);
      chunks++;
      for (const l of order) {
        at = chunkStart(w, CHUNK.LAYER);
        const flags =
          (l.visible ? 1 : 0) |
          (l.locked ? 0 : 2) |
          (l.isBackground ? 8 : 0) |
          (l.continuous ? 16 : 0) |
          (l.collapsed ? 32 : 0) |
          (l.type === 'reference' ? 64 : 0);
        w.u16(flags)
          .u16(l.type === 'group' ? 1 : 0)
          .u16(layerDepth(st, l))
          .u16(0)
          .u16(0);
        w.u16(Math.max(0, BLEND_MODES.indexOf(l.blendMode)))
          .u8(l.opacity)
          .zeros(3);
        writeString(w, l.name);
        chunkEnd(w, at);
        chunks++;
        if (userData(w, l.notes, l.color)) chunks++;
      }
      if (st.tags.length) {
        at = chunkStart(w, CHUNK.TAGS);
        w.u16(st.tags.length).zeros(8);
        for (const t of st.tags) {
          const h = (t.color ?? '#000000').replace('#', '');
          w.u16(t.from).u16(t.to).u8(DIRECTIONS.indexOf(t.direction)).u16(t.repeat).zeros(6);
          w.u8(parseInt(h.slice(0, 2), 16) || 0)
            .u8(parseInt(h.slice(2, 4), 16) || 0)
            .u8(parseInt(h.slice(4, 6), 16) || 0)
            .u8(0);
          writeString(w, t.name);
        }
        chunkEnd(w, at);
        chunks++;
        for (const t of st.tags)
          if (userData(w, t.notes, t.color)) chunks++;
          else {
            // keep user-data order aligned with tags
            const a2 = chunkStart(w, CHUNK.USER_DATA);
            w.u32(0);
            chunkEnd(w, a2);
            chunks++;
          }
      }
      for (const s of st.slices) {
        at = chunkStart(w, CHUNK.SLICE);
        const has9 = s.keys.some((k) => k.center);
        const hasPivot = s.keys.some((k) => k.pivot);
        w.u32(s.keys.length)
          .u32((has9 ? 1 : 0) | (hasPivot ? 2 : 0))
          .u32(0);
        writeString(w, s.name);
        for (const k of s.keys) {
          w.u32(k.frame).i32(k.bounds.x).i32(k.bounds.y).u32(k.bounds.w).u32(k.bounds.h);
          if (has9) {
            const c = k.center ?? { x: 0, y: 0, w: k.bounds.w, h: k.bounds.h };
            w.i32(c.x).i32(c.y).u32(c.w).u32(c.h);
          }
          if (hasPivot) {
            const p = k.pivot ?? { x: 0, y: 0 };
            w.i32(p.x).i32(p.y);
          }
        }
        chunkEnd(w, at);
        chunks++;
        if (userData(w, s.notes, s.color)) chunks++;
      }
    }
    // cels
    for (const l of order) {
      if (l.type === 'group') continue;
      const cel = getCel(st, l.id, f);
      if (!cel) continue;
      const img = doc.image(cel.imageId);
      const bounds = img.bounds();
      if (!bounds) continue;
      // linked to an earlier frame of the same layer?
      let linkFrame = -1;
      for (let pf = 0; pf < f; pf++) {
        const pc = getCel(st, l.id, pf);
        if (pc && pc.imageId === cel.imageId && pc.x === cel.x && pc.y === cel.y) {
          linkFrame = pf;
          break;
        }
      }
      const at = chunkStart(w, CHUNK.CEL);
      w.u16(layerIndex.get(l.id)!);
      if (linkFrame >= 0) {
        const pc = getCel(st, l.id, linkFrame)!;
        const pb = doc.image(pc.imageId).bounds()!;
        w.i16(pc.x + pb.x)
          .i16(pc.y + pb.y)
          .u8(cel.opacity)
          .u16(1)
          .i16(cel.zIndex)
          .zeros(5)
          .u16(linkFrame);
      } else {
        w.i16(cel.x + bounds.x)
          .i16(cel.y + bounds.y)
          .u8(cel.opacity)
          .u16(2)
          .i16(cel.zIndex)
          .zeros(5);
        w.u16(bounds.w).u16(bounds.h);
        const bpp = indexed ? 1 : 4;
        const raw = new Uint8Array(bounds.w * bounds.h * bpp);
        for (let y = 0; y < bounds.h; y++) {
          for (let x = 0; x < bounds.w; x++) {
            const v = img.get(bounds.x + x, bounds.y + y);
            const i = (y * bounds.w + x) * bpp;
            if (indexed) raw[i] = v;
            else {
              raw[i] = v >>> 24;
              raw[i + 1] = (v >>> 16) & 255;
              raw[i + 2] = (v >>> 8) & 255;
              raw[i + 3] = v & 255;
            }
          }
        }
        w.bytes(zlibSync(raw, { level: 9 }));
      }
      chunkEnd(w, at);
      chunks++;
      if (cel.notes && userData(w, cel.notes)) chunks++;
    }
    w.patchU32(frameAt, w.length - frameAt);
    w.patchU16(frameAt + 6, Math.min(chunks, 0xffff));
    w.patchU32(frameAt + 12, chunks);
  }
  w.patchU32(0, w.length);
  return w.toBytes();
}
