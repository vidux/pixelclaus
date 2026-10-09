# PixelClaus — Design Spec

Status: implemented (v0.1). Kept in sync with the code; see `docs/architecture.md` for how it is built. Input: `docs/research/expert-advice.md`.

PixelClaus is a pixel-art and sprite-animation editor whose designer is an AI agent (Claude) working through
MCP tools. Humans get a small viewer (list, inspect layers/frames, delete, export).

## 1. Goals

1. **Agent-first ergonomics.** Every operation is explicit (project, layer, frame), batchable, atomic, undoable,
   and returns compact numeric feedback plus optional images. Errors say what went wrong *and* what to do.
2. **Industrial feature depth.** Aseprite-parity document model (layers, groups, blend modes, frames, linked cels,
   tags, slices, palettes/ramps, indexed + RGBA), full drawing/selection/transform toolset, animation tooling.
3. **Lossless round-trips.** Indexed storage, ASCII grid I/O, `.aseprite` import/export, native `.pxc` container.
4. **Reusable core.** `@pixelclaus/core` is pure TypeScript with zero runtime dependencies and no Node APIs, so a
   future browser UI can use the same document model and commands.

## 2. Package layout (npm workspaces)

| Package | Depends on | Responsibility |
| --- | --- | --- |
| `@pixelclaus/core` | — | colour math, buffers, masks, document model, history, commands, drawing, transforms, palettes, compositing, previews, analysis/lint, ASCII codec, bitmap fonts |
| `@pixelclaus/formats` | core, fflate | PNG/APNG/GIF encoders (+PNG decoder), `.aseprite` read/write, sprite sheets + JSON atlases, palette files, `.pxc` container |
| `@pixelclaus/server` | core, formats, MCP SDK, zod, sharp, express | storage, services, MCP tools (stdio + Streamable HTTP), REST API, viewer hosting, CLI |
| `@pixelclaus/viewer` | (built by Vite) | static web UI consuming the REST API |

Rule: dependencies only point downward (viewer → server API; server → formats → core). Enforced by tests
(`packages/core/test/architecture.test.ts`).

## 3. Conventions (stated in every tool description)

- Coordinates are **0-indexed, origin top-left**, x → right, y → down.
- Rectangles are `{x, y, w, h}`. Line/path endpoints are **inclusive**. Frame ranges `{from, to}` are inclusive.
- Frames are 0-indexed. Layers are addressed by id (`L3`) or unique name. Projects by id or unique name.
- Palette index **0 is always transparent**; usable colours start at 1. `.` and `0` in ASCII mean transparent.
- Durations are milliseconds.

## 4. Document model (core)

```
SpriteState
  id, name, width, height, colorMode: 'indexed'|'rgba', pixelRatio, grid
  palette: { name, colors: '#rrggbbaa'[] (colors[0] = transparent), names?, ramps: {name, indices[]}[] }
  layers: Layer[]   // sibling order bottom → top; tree via parentId
  frames: { duration, notes? }[]
  cels:   { layerId, frame, imageId, x, y, opacity, zIndex }[]   // linked cels share imageId
  tags:   { name, from, to, direction, repeat, color }[]
  slices: { name, color, keys: {frame, bounds, center?, pivot?}[] }[]
  selections: Record<name, maskId>     // immutable masks
  clipboards: Record<name, {imageId, x, y}>
  settings: { paletteLock, missingColor, lightDirection, previewBackground, colorBudget?, outlineColor? }
  notes, created, modified
Layer { id, name, type: image|group|reference, parentId, visible, locked, opacity, blendMode, isBackground,
        continuous, color, notes }
```

- Pixel values live in `PixelBuffer { width, height, data: Uint32Array }`. Indexed mode stores palette
  indices; RGBA mode stores packed `0xRRGGBBAA`. Value `0` is transparent in both modes.
- Images and masks are held in stores keyed by id. Metadata (`SpriteState`) is plain JSON.
- Cels are canvas-sized on creation; offsets move content; cels auto-grow when drawn outside their bounds.

### History

`doc.transact(label, fn)` wraps every mutation. A transaction snapshots metadata, lazily backs up any image
on first write, and on commit stores a history entry `{label, metaBefore?, metaAfter?, patches[]}` where
patches hold only the changed sub-rectangle (before/after). Nested `transact` calls join the outer
transaction, so a batch of draw ops is one undo step. Errors roll the whole transaction back. Named
**checkpoints** are persisted full snapshots (`.pxc`).

## 5. Agent communication strategy (performance)

1. **Batching** — `draw` takes `ops[]`; one call = one transaction = one undo step = one disk write.
2. **Token-efficient pixel encodings** — ASCII grids with legend, `c*n` run-length, `[n]` palette refs,
   optional `07|` row prefixes; region-scoped reads/writes; readback echoes a legend + column header.
3. **Images only when useful** — previews auto-scale to ~512-1024 px (an explicit scale is reduced to stay
   ≤ 1600 px) with grid, rulers, 1x/2x inset and palette strip; region crops; `draw(..., preview:true)` attaches a preview to avoid a round trip.
4. **Numbers over pictures** — every image is paired with text stats; analysis tools return tables.
5. **Deltas, not state** — mutating tools return revision, dirty rect, changed-pixel counts and warnings.
6. **Server-side caching & incremental persistence** — LRU in-memory projects, only dirty images rewritten,
   atomic temp-file+rename writes, external-change detection via manifest mtime/revision.
7. **Forgiving addressing** — ids or names everywhere; helpful "did you mean" errors listing valid options.

## 6. MCP surface

Tools (24): `guide`, `project_create`, `project_list`, `project_get`, `project_update`, `project_delete`,
`project_duplicate`, `history`, `checkpoint`, `layer`, `frame`, `cel`, `tag`, `slice`, `palette`, `select`,
`draw`, `transform`, `canvas`, `render`, `read_pixels`, `analyze`, `export`, `import`.

Entity tools (`layer`, `frame`, `cel`, `tag`, `slice`, `palette`, `select`, `checkpoint`, `history`, `canvas`)
take an `action` discriminator — fewer tools, smaller tool-list footprint, consistent shape.

`draw.ops[]` op types: pixels, grid, line, path, rect, ellipse, circle, polygon, fill, replace_color, gradient,
pattern, outline, selout, shade, erase, clear, copy, paste, stamp, text, adjust, quantize. (A dedicated
`antialias` op was dropped: the expert review recommends manual AA only, placed with `pixels`/`grid`.)

Resources: `pixelclaus://guide/{topic}`, `pixelclaus://projects`, `pixelclaus://projects/{id}`,
`pixelclaus://projects/{id}/preview.png`. Full reference: `docs/mcp-tools.md` (generated).
Prompts: `sprite_workflow`, `animation_workflow`, `tileset_workflow`.
Server `instructions` give a short primer (conventions + recommended loop).

## 7. Rendering & feedback views

`render.view`: composite, silhouette, value, indexed (labelled indices), onion, diff, tile (3x3), filmstrip
(durations, baseline, pivot, ping-pong unrolled), trail (motion trail + centroid path), timing (bar), contact
(composite + silhouette + value), palette (swatches, indices, ramps). Overlays: checkerboard, pixel grid,
major grid every 8 px (or project grid), 0-indexed rulers, 1x/2x inset, palette strip.

## 8. Analysis & lint

`analyze.kind`: stats, colors, lint, animation (per-frame metrics table), diff.
Lint rules: stray-pixels, orphan-pixels, doubles, jaggies, semi-transparent, off-palette,
near-duplicate-colors, color-budget, unused-palette, ramp-contrast, pillow-shading, banding,
outline-gaps, black-outline, rare-colors, background-contrast, detail-density, baseline-drift,
frame-jitter, size-drift; opt-in: tile-seams, symmetry. Line-art rules (doubles, jaggies) analyse
only the outline colour (`settings.outlineColor`, else the dominant darker edge colour) so shading
clusters are not reported. Identical findings on several frames are merged (`frames: […]`).
*Not implemented:* `aa-halo` (AA against transparency) — deferred; the guide tells the agent never to
anti-alias against transparency instead.

## 9. Formats

| Format | Read | Write | Notes |
| --- | --- | --- | --- |
| PNG | ✓ (own decoder; sharp fallback) | ✓ own encoder (indexed when ≤256 colours) | per frame / layer / tag, scale 1-16 |
| APNG | — | ✓ own encoder | full alpha, ms timing |
| GIF | ✓ (sharp) | ✓ own encoder (LZW) | ≤256 colours, 1-bit alpha, cs delays, 20 ms clamp |
| WebP / animated WebP | ✓ (sharp) | ✓ (sharp) | lossless default |
| JPG | ✓ (sharp) | ✓ (sharp) | matte colour required |
| Sprite sheet | ✓ (grid slicing) | ✓ horizontal/vertical/grid/by-tag rows/packed | padding, extrude, POT, trim, dedupe; Aseprite hash/array & TexturePacker JSON |
| `.aseprite` | ✓ | ✓ | layers, groups, cels (raw/zlib/linked), tags, palette, slices, user data |
| Palette | ✓ | ✓ | `.hex`, `.gpl`, `.pal` (JASC), `.act` |
| `.pxc` | ✓ | ✓ | native single-file container (checkpoints, duplication, backup) |

## 10. Storage

```
<dataDir>/projects/<projectId>/
  project.json          # SpriteState + revision + checkpoint index
  images/<imageId>.bin  # tiny header + deflated pixel values (1 byte/px indexed, 4 bytes/px rgba)
  masks/<maskId>.bin
  thumbnail.png
  checkpoints/<id>.pxc
  exports/
```

Default data dir: `$PIXELCLAUS_DATA` or `~/.pixelclaus`.

## 11. Viewer

Project grid (thumbnails, size, frames, layers, modified) → project page (playable frame preview with tag
selector, layer list with per-layer thumbnails and visibility/opacity/blend info, frames/tags, palette) →
export dialog (format + options → download) and delete (with confirmation).
