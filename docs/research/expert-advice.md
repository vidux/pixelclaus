# Pixel-Art Expert Advisory (design input)

> Source: read-only advisory session with a senior pixel-art / animation expert agent
> (10+ years: Aseprite, Pyxel Edit, Pro Motion NG, GraphicsGale; Unity/Godot/Phaser pipelines).
> This document is the design input for PixelClaus. `docs/design/spec.md` records which
> recommendations were adopted and how.

## 1. Document model

**MUST (Aseprite parity that matters)**

- `Sprite { id, name, width, height, colorMode: 'indexed'|'rgba', pixelRatio, grid, transparentIndex: 0, palette, layers, frames, tags, slices, userData }`
- `Layer { id, name, type: 'image'|'group'|'reference', parentId, opacity 0..255, blendMode, visible, locked, isBackground, continuous, color, userData }`.
  Ship all 19 Aseprite blend modes (normal, multiply, screen, overlay, darken, lighten, color-dodge, color-burn,
  hard-light, soft-light, difference, exclusion, hue, saturation, color, luminosity, addition, subtract, divide).
- `Frame { durationMs: 100 }`.
- `Cel { layerId, frame, x, y, opacity, imageId, zIndex }` with images stored separately so
  **linked cels are two cels sharing one imageId**.
- `Tag { name, from, to, direction: forward|reverse|pingpong|pingpong_reverse, repeat (0 = infinite), color }`.
- `Slice { name, color, keys: [{ frame, bounds, center? (9-patch), pivot? }] }`.
- `Palette { colors, ramps }` — ramps are not in Aseprite but drive shading tools and lint.
- One opaque background layer at most, always bottom-most.
- Command-pattern undo/redo **plus named checkpoints** — a blind agent needs these more than a human.

**Simplify safely:** drop tilemaps/tilesets, per-frame palettes, grayscale mode (= indexed + gray palette),
16-bit channels, colour profiles (always sRGB).

**Pixel storage — be truly indexed.** Default to indexed with palette indices, `transparentIndex = 0`:
the index *is* the pixel (lossless ASCII both ways), palette swaps are O(1), .aseprite round-trips, lint is trivial.
Offer RGBA mode for imports/effects with `paletteLock: true` (writes snap to nearest palette colour in OKLab).
Provide `convertColorMode(target, { dither })`.

**Palette ops — three distinct operations:**
`setColors` (recolor appearance, pixels untouched), `remapPixels` (rewrite indices, used after sort),
`applyPreset(name, { strategy: byIndex|nearestColor })`, plus `paletteVariants` export (N skins in one call).

## 2. Drawing & editing

Every op is **batchable, mask-aware and target-addressed** (explicit layer + frame, never "current").

MUST: setPixels, drawGrid (ASCII — primary input), getPixels → ASCII, pencil path with pixel-perfect mode,
line, rect, ellipse (midpoint, small circles must look right), polygon, flood fill (contiguous/global,
tolerance, 4/8 connectivity, **reference = composite** for filling under an outline layer), replace colour
(cel/layer/frame/sprite scope), outline (inside/outside, 4/8), **shade along a palette ramp** (the single most
useful painting tool for an agent), gradient with ordered dithering (bayer2/4/8, checker), pattern fill,
selections (rect, ellipse, polygon, magic wand, by colour, all/none/invert, grow/shrink, border, from alpha;
named & persistent), transforms (flip, rotate 90/180/270, rotate arbitrary nearest (RotSprite SHOULD),
nearest scale, **offset-wrap for tiling**, canvas resize w/ 9-point anchor, trim, crop, move cel/selection),
structural (copy/paste/stamp regions, duplicate frame copy/link/empty, duplicate layer, merge down, flatten,
link/unlink cels), colour adjust (HSL, brightness/contrast, invert, desaturate, quantize to palette).

SHOULD: scale2x/EPX, bitmap text (3x5, 5x7), auto-AA on interior edges, stroke selection.
Skip: spray, smudge, blur, custom brushes, lasso, pressure, hq2x/xBR, perspective, tilemap tools.

## 3. Palettes & colour

Presets: pico-8, sweetie-16, endesga-32, db32, db16, resurrect-64, aap-64, apollo, lospec500,
gameboy (DMG), 1-bit, nes, c64, cga, zx-spectrum, nyx8, oil-6, twilight-5, slso8, ammo-8, vinik24.
Read/write `.hex`, `.gpl`, `.pal` (JASC), `.act`.

Ramp generator in **OKLCH**: shadows rotate hue toward ~260° (cool), highlights toward ~70° (warm), 12-25° per step;
lightness steps non-uniform (shadows 0.12-0.14 L, highlights 0.08-0.10 L); chroma "bell": peak at first shadow
(~115%), darkest 80%, brightest highlight 50-60%.

Rules: colour budget 16x16 → 3-5 (+outline), 32x32 → 5-9, 64x64 → 10-18, tiles 4-8; adjacent ramp steps
ΔL ≥ 0.08 and hue shift ≥ 8° (zero hue shift = muddy); avoid pure #000 outlines / #FFF highlights; share colours
across ramps; silhouette must contrast with the declared background (ΔL ≥ 0.25).

## 4. Animation

Timeline MUST: per-frame ms durations (default 100, fps helper), tags with direction+repeat, linked cels,
duplicate with link/copy/empty, reverse, reorder, onion skin as a render parameter, tag-scoped render/export.
SHOULD: tween cel offsets, insert holds. NICE: per-frame notes.

Typical cycles: idle 2-4 @ 180-250 ms (1 px bob); walk 4 @ 120 / 6 @ 100 / 8 @ 80; run 6-8 @ 60-80 with lean
and an airborne frame; attack = anticipation (120-180) → smear (40-60) → strike hold (80-120) → recovery (2×100);
jump = crouch/launch/rise/apex/fall/land as separate tags; hit 2-3 @ 70-90 + flash via palette;
death 4-8 @ 100-150, last frame 400+ ms.

Principles: timing lives in durations (holds), 1-frame anticipation, smear for fast motion, squash/stretch
≤ 1 px at 16 px (2 px at 32), feet on the same baseline on contact frames, secondary motion lags 1 frame,
silhouettes differ between key poses, sub-pixel motion via ramp-step colour shifts, separate layers for parts.

**Feedback for a blind agent:** filmstrip (frame index + ms, baseline guide, pivot, ping-pong unrolled),
onion skin (prev red / next blue), diff image (added magenta, removed cyan) + changed-pixel count,
motion trail with centroid path, **animation metrics table** (bbox, centroid, pixel count, foot row,
changed vs prev, duration — more useful than any image), timing bar. Never pretend the agent can watch a GIF.

## 5. Feedback loop for a blind agent (most important)

Preview render defaults: integer nearest-neighbour scale so the longest side lands at 512-768 px (cap 1024 —
bigger costs more tokens and gets downsampled anyway); checkerboard transparency; per-pixel grid at scale ≥ 8
with bold lines every 8 px; rulers top/left, **0-indexed, origin top-left**; a **1x (and 2x) actual-size inset**
(best single cure for over-detailing); palette strip (swatch, index, hex, count). Modes: composite, layer,
silhouette, value (OKLab L), **indexed (palette index labelled in each cell when scale ≥ 24)**, onion, diff,
tile 3x3, contact sheet. Every image is paired with a text block of numbers (size, scale, bbox, colours, lint).

ASCII I/O is the only lossless channel: `.` = transparent, `0-9 a-z A-Z` minus ambiguous `l I O o`;
explicit legend; optional `07|` row prefixes and a column header on readback; strict row-width validation with
exact errors; region writes, RLE, symmetry. Above ~48 px wide push toward primitives + region patches.
Pitfalls: tabs, trailing spaces, mixed-width rows, 0/O confusion, miscounted long runs, inclusive/exclusive
bounds (state inclusiveness everywhere), legend drift. Always echo the written region.

Art lint: orphan pixels, jaggies/doubles, off-palette & near-duplicate colours, semi-transparent alpha,
colour count vs budget, unused palette entries, low ramp contrast, pillow shading, banding, outline gaps,
AA halo against transparency, frame jitter, baseline drift, size drift, tiling seams, symmetry mismatch.

## 6. Recommended AI workflow

Sprite: create (size, palette, preview background, light direction, 4-8 px margin) → silhouette (check
silhouette view + 1x inset) → flats on a separate layer (check value view) → shading along ramps with a light
direction (hard shapes, one terminator; lint pillow/banding) → outline then selout → manual interior AA →
lint/cleanup/checkpoint → export preview 1x/2x/4x.

Canvas sizes: characters 16/16x24/24/32/32x48/48/64; tiles 8/16/32; icons 16/24/32; portraits 32-128;
9-patch 16 with 4 px corners; fonts 5x7, 8x8.

Animation: key poses with holds → filmstrip + metrics check → breakdowns → in-betweens only where the diff
shows a jump > 2 px → secondary motion on its own layer (1 frame lag) → timing via durations → GIF for humans.

Tileset: tile 3x3 preview + offset-wrap to expose seams; seam/hot-pixel lint; 47-blob template (NICE).

## 7. Export & pipeline

Sheets: horizontal, vertical, grid(columns), **byRows (one tag per row)**, packed (MaxRects). Options:
border/shape/inner padding, extrude, power-of-two, trim with sourceSize/spriteSourceSize, merge duplicates,
split layers/tags, ignore empty. JSON: Aseprite **hash** and **array** exactly (frameTags, layers, slices with
center/pivot) + TexturePacker flavour; namespaced `meta.pixelclaus` extension. Filename tokens
`{title} {layer} {tag} {tagframe} {frame}`. Integer scaling 1-8x only.
GIF: ≤ 256 colours, 1-bit alpha (threshold 128), centisecond delays (warn on rounding), clamp < 20 ms to 20,
disposal 2, loop from tag repeat. APNG / animated WebP: full alpha, ms timing — preferred previews.
JPG: requires a matte colour. `.aseprite`: chunks 0x2004, 0x2005 (raw/zlib/linked), 0x2007, 0x2018, 0x2019,
0x2020, 0x2022; read legacy 0x0004/0x0011; skip tilesets.

## 8. Top pitfalls

1. Over-detailing because previews are zoomed → 1x inset, detail-density lint.
2. ASCII misalignment / off-by-one → strict validation, echo-back, inclusive bounds stated everywhere.
3. Off-palette / semi-transparent pixels → indexed default, palette lock, alpha lint.
4. Pillow shading / no light direction → shade requires a light direction; pillow lint.
5. Banding and jaggies → pixel-perfect default on; banding/doubles lint.
6. Uniform black outlines → one-call selout; warn on #000 outlines.
7. Baseline/centroid drift → metrics table, baseline guide, drift lint.
8. Even timing / too many in-betweens → templates with authored durations; "holds before frames".
9. Hallucinating pixel positions from images → ASCII readback + indexed labelled view; "verify before claiming".
10. Editing a linked cel unintentionally → explicit warnings ("this edit affects N frames"), warn on hidden/locked
    layers, checkpoints before destructive ops.
