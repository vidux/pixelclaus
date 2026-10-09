# Architecture

PixelClaus is an npm-workspaces monorepo of four ESM TypeScript packages. Dependencies point one way:

```
viewer ──HTTP/REST──▶ server ──▶ formats ──▶ core
Claude ──MCP────────▶ server
```

| Package | Runtime deps | Role |
| --- | --- | --- |
| `@pixelclaus/core` | none | Document model, transactions/history, drawing, selections, transforms, palettes and ramps, compositing, preview rendering, ASCII codec, analysis and lint. No Node APIs, so a browser editor can reuse it. |
| `@pixelclaus/formats` | core, fflate | PNG/APNG/GIF encoders, PNG/GIF decoders, `.aseprite` read/write, sprite sheets and JSON atlases, palette files, native `.pxc` container, image/mask blob codecs. Browser-safe. |
| `@pixelclaus/server` | core, formats, MCP SDK, zod, sharp, express | Storage, services, compute worker pool, the 24 MCP tools (stdio + Streamable HTTP), REST API, viewer hosting, CLI. |
| `@pixelclaus/viewer` | — (Vite build) | Static web UI that talks only to the REST API. |

Layering is enforced. ESLint forbids Node built-ins, sharp and express in core/formats, and
`packages/core/test/architecture.test.ts` checks the dependency direction and module size (each source
file stays under 700 lines).

## Core

### Document model

`SpriteDocument` wraps a JSON `SpriteState` plus two stores keyed by id:

- **Images.** `PixelBuffer` (`Uint32Array`) holds palette indices in indexed mode and packed `0xRRGGBBAA`
  in RGBA mode. Value 0 is transparent in both modes.
- **Masks.** Selections are immutable `Mask` objects (1 byte per pixel).

```
SpriteState
  width, height, colorMode, pixelRatio, grid
  palette { name, colors[0] = transparent, names{index: name}, ramps[{name, indices dark→light}] }
  layers[] (image | group | reference; parentId tree; opacity, blendMode, visible, locked, continuous)
  frames[] { duration ms }
  cels[] { layerId, frame, imageId, x, y, opacity, zIndex }     — linked cels share an imageId
  tags[] { name, from, to, direction, repeat, color }
  slices[] { name, keys[{frame, bounds, center?, pivot?}] }
  selections { name → maskId } · clipboards { name → {imageId, x, y} }
  settings { paletteLock, missingColor, lightDirection, previewBackground, colorBudget, outlineColor }
```

`ColorResolver` turns every colour input into a pixel value: palette index, `#hex`, `transparent`, colour
name, or `ramp:<name>:<step>`. It applies `settings.missingColor` (snap with a warning, add to the
palette, or error).

### Transactions and history

Every mutation runs inside `doc.transact(label, tx => …)`:

- `tx.writeImage(id)` backs up an image the first time it is written. On commit, only the changed
  sub-rectangle is stored, as a **region patch** with before/after pixels.
- Structural edits (resize, rotate a sprite) store **replace patches** that hold private clones of the
  images.
- Metadata is stored as before/after JSON snapshots.
- Nested `transact` calls join the outer one, so a 300-op `draw` call is a single undo step.
- Any error rolls the whole transaction back.
- History is a linear undo/redo stack, limited to 300 entries and about 96 MB by default.
- Dirty tracking (images, masks, meta) drives incremental saves.

Warnings collected during a transaction come back with the tool result. Examples: a snapped colour, an
edit through linked cels, a hidden layer, a pixel clipped at the canvas edge.

### Drawing pipeline

`draw(doc, {ops, layer, frame, symmetry, ink, clip})` works in four steps:

1. Validate every op. `guardNumbers` keeps all coordinates within ±65536, and every point is checked.
2. Open the target cel. Locked layers are refused and the error gives the exact unlock call.
3. Rasterise. Shapes are clipped to the canvas, and brush strokes skip points that cannot reach it.
4. Plot through a `Writer`, which applies ink, the clip mask and symmetry, and counts written and
   clipped pixels.

Each op reports pixels written, pixels clipped and a note. An op that changes nothing always says why.

Pixel-art helpers include:

- pixel-perfect paths (no L-corners);
- 4/8-connected flood fill, with composite reference for filling under line art;
- Bayer and checker dithering for gradients and patterns;
- outline inside/outside, with a source of layer, composite or another layer;
- selout, which recolours the outline from the colour it encloses, toward the light;
- ramp shift shading;
- light-direction shading that auto-detects the outline colour;
- RotSprite rotation;
- Scale2x/3x.

### Rendering for the agent

`renderView` produces annotated previews:

- integer zoom with a pixel grid and a major grid;
- 0-indexed rulers;
- 1× and 2× insets for judging readability;
- a palette strip with indices;
- an adaptive checkerboard and backdrop.

Views: composite, silhouette, value, indexed (index label in every cell), onion (outline/tint), diff
(added/removed/recoloured), tile (3×3, no grid on the seams), filmstrip (ping-pong unrolled, baseline,
durations), trail, timing, contact, palette.

Size is budgeted. Automatic scale targets 512–1024 px, and an explicit scale is reduced (and reported)
to keep the image within 1600 px.

### Analysis

| Function | What it reports |
| --- | --- |
| `spriteStats` | Per-layer and per-frame pixel counts, bounds and colour usage |
| `paletteReport` | Usage, unused entries, near duplicates, ramps |
| `animationMetrics` | Per frame: bbox, centroid, bottom row, pixels changed vs the previous frame |
| `diffFrames` | Added/removed/recoloured counts, the best whole-image shift, an ASCII change map |
| `runLint` | 22 rules, each finding with coordinates and a fix hint; identical findings merged across frames |

The line-art rules (doubles, jaggies) only look at the outline colour, so shading clusters are not
reported.

### ASCII codec

`grid` rows use one character per pixel:

- `.` is transparent and `~` keeps the existing pixel.
- `0-9a-z…` are palette indices; `l`, `o`, `I` and `O` are left out so they are not misread.
- `c*n ` is a run, `[n]` is any index, and a legend can map other characters, including emoji.

`read_pixels` prints the same format with a column header, `07| ` row prefixes, a legend and optional
RLE. Pasting it back into `grid` reproduces the pixels exactly; 300 random sprites are round-trip
tested.

## Server

### Storage (`ProjectStore`)

```
<data>/projects/<id>/project.json      manifest: state, revision, id counters, checkpoint index
                     images/<id>.bin   header + deflated pixel values (1 B/px indexed, 4 B/px RGBA)
                     masks/<id>.bin
                     thumbnail.png
                     checkpoints/<cp>.pxc
                     exports/
```

- **Writes.** Saves are atomic (write a temp file, then rename; the manifest goes last) and
  incremental (only dirty blobs are written). On Windows a rename onto a file that another handle has
  open (a reader, antivirus, the indexer) fails with EPERM, so it is retried for up to ~2.5 s.
- **Blob cleanup.** Blobs no longer referenced are deleted. The store remembers which blobs are on
  disk, so an undo that brings an old image back writes it again.
- **Missing blobs.** These load as empty cels and produce a warning.

### Services

- **`ProjectService`**
  - Keeps a cache of open documents (see Concurrency below for the unload policy).
  - Resolves projects by id or name, with "did you mean" suggestions. A name used by several projects
    is refused with the list of ids.
  - Runs mutations one at a time per project (async mutex) and autosaves after each one.
  - Reloads a project when another process changes its manifest (by mtime), then warns.
  - Manages checkpoints. A restore validates the checkpoint first, makes an automatic backup, then
    replaces the document.
  - Renders thumbnails on the compute pool, debounced after changes.
- **`ExportService`**
  - Copies the document, then builds the export on the compute pool (`export-build.ts` is pure:
    document in, bytes out). One shared zod schema validates requests for both MCP and REST.
  - Writes into the project's `exports/` folder or an `outputDir`. `outputDir` is compared by real
    path, so symlinks cannot reach another project's files.
- **`ImportService`**
  - Imports images, animations, sprite sheets, `.aseprite`, `.pxc` and palettes.
  - Warns when colours are snapped to the palette.
  - Fits palettes to 255 entries.
  - Gives clean errors for undecodable files.

### Concurrency (many agents, one server)

Several agents — parallel subagents on one stdio connection, or many HTTP sessions — share one Node
process. The design goal: agents working on different projects never wait for each other, and agents
sharing a project see a consistent, ordered history.

```
 MCP requests ──▶ main thread (event loop)                       compute pool (worker_threads)
                  · validate, resolve project                    · render + PNG encode (priority 0)
                  · per-project mutex → mutate → save            · frames, analysis, lint (1)
                  · copy needed frames (docPayload) ───────────▶ · exports: GIF/APNG/WebP/sheets (2)
                  ◀────────────── result (PNG, files, lines) ── · thumbnails (3, background)
```

- **CPU-heavy work runs off the event loop.** Previews, exports, analysis, REST renders, thumbnails
  and checkpoint (.pxc) encoding/decoding are tasks on a `ComputePool` of worker threads
  (`PIXELCLAUS_THREADS`, default CPUs − 1, 2–8). The main thread copies just the frames a task needs
  (`docPayload`, about 1 ms for a 128×128×16 sprite) inside the read or mutation, so the copy is
  consistent, then releases the project and awaits the worker. The event loop therefore only runs short work: validation, drawing ops, and saves. Saves
  compress blob by blob and yield every ~8 ms.
- **Priorities.** The queue is ordered: previews (0) → frames/analysis (1) → exports (2) →
  thumbnails (3). Batch work (≥ 2) may occupy at most `size − 1` workers, so a preview never waits
  behind other agents' exports.
- **Timeouts and crashes.** A task timeout (120 s) is counted from the moment the worker has loaded.
  When it fires, or when a worker crashes, the job fails with an actionable error and the worker is
  replaced.
- **Locks.** There is one mutex per project. Mutations and checkpoints on different projects run
  concurrently. Reads take no lock. While this process is saving a project, readers trust the
  in-memory document; they do not mistake the new manifest mtime for an external edit, which would
  reload the project and wipe its undo history.
- **Loads are single-flight.** Concurrent first reads of a project share one load and one document.
- **Names and ids.** `project_create` refuses a name already in use (CONFLICT, with a suggested free
  name) unless `ifExists:"suffix"` is passed. The id is reserved with an exclusive `mkdir`, so
  concurrent creates never share an id across threads or processes, and a failed create releases its
  reservation. Name lookups use a 2-second listing cache that is refreshed on a miss.
- **Several processes on one data directory.** This happens, for example, when several Claude
  sessions each start their own `pixelclaus mcp`.
  - Every mutation holds a per-project lock file (`.lock`, created exclusively, broken after 60 s if
    its process crashed) from load to save. Edits from different processes are therefore applied one
    after another, with a reload in between, instead of overwriting each other.
  - The manifest is identified by a stamp of inode, mtime and size. Atomic rename-replace changes the
    inode on every save, so two saves within one timestamp tick are still told apart.
  - Saves, exports and thumbnails never create a project folder that another session or process has
    deleted.
- **Restore is atomic.** Validation, the automatic backup and the replacement run under one project
  lock, so a draw from another agent lands either in the backup or after the restore.
- **Pixel budget.** Each project may hold at most 2^28 px (about 1 GB). Creating a background on many
  frames, or copying frames past that, fails before any memory is allocated, so one agent cannot take
  down the shared server.
- **Cache policy.** Above `PIXELCLAUS_CACHE` open projects, only projects that are idle (≥
  `PIXELCLAUS_CACHE_IDLE`, default 10 min), not busy and fully saved are unloaded. A hard ceiling of
  4× the cache size bounds memory. Reloading a project whose undo history was dropped tells the agent
  why.
- **Deletes.** A delete waits for any in-flight thumbnail write, so the folder is never resurrected.

`npm run bench:agents` measures this against the built stdio server. The tests in
`test/concurrency.test.ts` and `test/compute.test.ts` pin the behaviour: a 7-agent id race, isolation,
event-loop stalls under load, undo with more projects than the cache size, readers during saves,
single-flight loads, pool parallelism, priorities, timeouts and error transport.

### MCP communication strategy

The protocol is designed for an LLM caller, where tokens and round trips are the real cost:

1. **Batch.** `draw` takes up to 2000 ops in one atomic, undoable call that triggers one disk write.
   Entity tools (`layer`, `frame`, `cel`, `tag`, …) take an `action` field, which keeps the tool count
   at 24.
2. **Text over pixels.** ASCII grids with RLE are about 1 token per pixel. `read_pixels` reads regions
   exactly, so Claude never has to guess coordinates from an image.
3. **Deltas, not state.** Mutating tools return the revision, changed-pixel counts, the dirty rect and
   warnings. Large batches are summarised by op (300 ops fit in under 3 KB).
4. **Images only on request.** Use `render`, or `draw {preview:true}` to save a round trip. Images are
   budgeted (≤ 1600 px) and always paired with JSON info.
5. **Numbers over pictures.** Lint, animation metrics and frame diffs answer "did the feet drift?"
   without an image.
6. **Compact schemas.** Integer fields are published as `{"type":"integer"}` without ±2^53 bounds, and
   shared fields are described once. The whole tool list is about 54 KB.
7. **Actionable errors.** Every error has the form `Error [CODE]: … / Hint: …`, including schema
   validation errors. A failing op is identified by its index, valid names and ranges are listed, and
   locked layers get the exact unlock call.
8. **Teach in-band.** Server `instructions`, the `guide` tool, `pixelclaus://guide/{topic}` resources
   and three workflow prompts.

### Transports

- **stdio.** `pixelclaus mcp` is for Claude Desktop and Claude Code. Logs go to stderr only.
- **Streamable HTTP.** `pixelclaus serve` serves MCP at `/mcp`, with one MCP server instance per
  session and DNS-rebinding protection. The REST API and viewer are on the same port. Every session
  shares the same project service and compute pool. Undo history is per project and shared by all
  sessions editing that project.

## Testing

| Suite | Location | Covers |
| --- | --- | --- |
| Unit / integration | `packages/*/test/*.test.ts` | engine, codecs (checked against sharp), services, MCP over an in-memory transport, HTTP, a real stdio child process, CLI |
| QA | `packages/*/test/qa/` | Written by the `qa-tester` agent: edge cases, adversarial inputs, child-process hang probes, end-to-end agent workflows |

Run `npm test` (vitest uses source aliases, so no build is needed). The CLI QA tests use the built
`dist/`.
