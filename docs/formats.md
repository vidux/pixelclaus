# Formats

Exports go through one request shape, shared by the MCP `export` tool and the viewer's
`POST /api/projects/:id/export`. Files are written to `<data>/projects/<id>/exports/` unless
`outputDir` is given (MCP only). The REST endpoint returns the file as a download, or a zip when there
are several files.

## Export formats

| `format` | Output | Notes |
| --- | --- | --- |
| `png` | one PNG per frame/layer | Encoded indexed (PLTE + tRNS) when the image has ≤ 256 colours, otherwise RGBA. `frame` (default 0), `layers`, `splitLayers`, `trim`, `background` |
| `jpg` | JPEG | Always flattened on `background` (default: preview background, else white). `quality` 1–100 (default 95), 4:4:4 chroma, mozjpeg |
| `webp` | WebP | Lossless by default; `lossless:false` + `quality` for lossy |
| `gif` | animated GIF | ≤ 256 colours (quantised with a warning), 1-bit transparency (semi-transparent pixels thresholded with a warning), delays rounded to 10 ms, delays < 20 ms clamped to 20 ms |
| `apng` | animated PNG | Full alpha, exact millisecond timing (better than GIF for previews) |
| `webp_animated` | animated WebP | Full alpha, ms timing, lossless by default |
| `frames` | PNG sequence | `name-000.png`, `name-001.png`, … for `frames` or a `tag` |
| `spritesheet` | PNG + JSON atlas | See below |
| `aseprite` | `.aseprite` | Layers, groups, blend modes, opacity, linked cels, tags (direction, repeat), slices (9-patch, pivot), palette, user data |
| `pxc` | `.pxc` | PixelClaus native single-file project (state + images + masks), lossless backup |
| `palette` | palette file | `paletteFormat`: `hex` (Lospec), `gpl` (GIMP, with colour names), `pal` (JASC), `act` (Adobe, 772 bytes) |

Options shared by all formats:

- **`scale`.** Integer 1–16, nearest neighbour. The output is limited to 16384 px per side.
- **`frames`.** A frame index, a list, `{from, to}`, `{tag}` or `"all"`. The `tag` option uses the
  tag's playback order, with ping-pong unrolled. `splitTags:true` writes one file per tag.
- **`loops`.** Animated formats: number of loops. 0 means forever; the default is the tag's `repeat` (0 when no tag is given).
- **`paletteVariants`.** Indexed sprites only: `[{name, palette}]` renders the same art once per
  palette (character skins, day/night).
- **`filename`.** Base name without extension; it is sanitised.

### Sprite sheets

`sheet` options:

| Option | Default | Meaning |
| --- | --- | --- |
| `layout` | `rows` with 2+ tags, else `horizontal` | `horizontal`, `vertical`, `grid`, `rows` (one row per tag), `packed` (shelf packing) |
| `columns` | ⌈√n⌉ | grid columns (1–1024) |
| `padding` / `border` | 0 / 0 | pixels between cells / around the sheet (0–64) |
| `extrude` | 0 | repeat edge pixels outward (0–8) to stop texture bleeding with filtering |
| `trim` | false | crop each cell to its content; `sourceRect`/`sourceSize` keep the offsets |
| `mergeDuplicates` | false | identical cells (same pixels and size) share one rect |
| `powerOfTwo` | false | round the sheet up to power-of-two dimensions |
| `splitLayers` | false | one set of cells per visible image layer |
| `json` | `aseprite-hash` | `aseprite-hash`, `aseprite-array`, `texturepacker`, `none` |
| `filename` | `{title}-{tag}-{tagframe:00}` | cell name template; tokens `{title} {tag} {tagframe} {frame} {layer}`, `:00` pads |

The Aseprite JSON includes `frameTags` (with direction and repeat), `slices`, `layers` and per-frame
`duration`, so engines that read Aseprite atlases (Phaser, Godot importers, LÖVE libraries) work
unchanged. Sheets are limited to 16384 px per side.

## Import

`import {path | data, kind, …}`. `data` is base64 or a `data:` URL. `kind: "auto"` detects the type from
the file name and content.

| `kind` | Source | Result |
| --- | --- | --- |
| `image` | PNG, APNG, GIF, JPEG, WebP, BMP, TIFF (sharp) | Without `project`: a new project; indexed when it has ≤ 255 colours, else RGBA (or quantised to `maxColors`). With `project`: a new layer at `x, y` / `frame`. Animated images become frames (`asFrames`). Colours are snapped to the palette in indexed projects, with a warning; frames are added when needed, with a note |
| `spritesheet` | image + `frameWidth`, `frameHeight`, `count?`, margins, spacing | frames sliced row by row; empty cells skipped; `duration` per frame |
| `aseprite` | `.aseprite` / `.ase` | Full document: layers, groups, cels (raw/zlib/linked), tags, slices, palette. Tilemap layers come in as empty layers with a warning |
| `pxc` | `.pxc` | Exact project copy |
| `palette` | `.hex`, `.gpl`, `.pal` (JASC text), `.act` | New 16×16 project with that palette, or into `project` with `paletteMode`: `replace` (nearest remap), `replace-keep-indices` (palette swap) or `append`. Names from `.gpl` are kept. Palettes longer than 255 entries are fitted (the ACT transparent entry and duplicates are dropped first) with warnings. Files without colours are rejected and the project is left untouched |

Files that cannot be decoded give `INVALID_ARGUMENT` with the list of supported formats.

## Native storage formats

- **`project.json`.** The manifest: `format: "pixelclaus-project"`, `SpriteState`, revision, id counters and the
  checkpoint index.
- **`images/*.bin`, `masks/*.bin`.** A small header plus deflated pixel data: 1 byte per pixel for
  indexed images with ≤ 256 entries, 4 bytes per pixel for RGBA.
- **`.pxc`.** A magic number, a JSON header (state, counters, blob table), then the blobs. Used for
  checkpoints, duplicates, and `export pxc` / `import pxc`.
