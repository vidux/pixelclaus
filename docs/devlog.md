# PixelClaus Devlog

Trackable log of completed tasks. Newest entries at the bottom. Format: date · task · what · why · tests · follow-ups.

---

## 2026-10-06 · T1 Expert consultation

- **What:** Consulted a read-only pixel-art master agent (fable model). Captured advice in
  `docs/research/expert-advice.md`.
- **Key takeaways adopted:** true indexed storage with palette index 0 = transparent; named checkpoints;
  ASCII grid as the primary lossless I/O; "numbers over pictures" feedback (metrics tables, lint);
  preview defaults (512-768 px, grid, rulers, 1x inset, palette strip); filmstrip/onion/diff views;
  shade-along-ramp tool; OKLCH ramp generator; Aseprite JSON hash/array atlases; GIF caveats.
- **Deferred (expert: low value for agents):** tilemaps, spray/smudge/blur, custom brushes, lasso, hq2x/xBR.

## 2026-10-06 · T2 Architecture & scaffold

- **What:** `docs/design/spec.md`; npm workspaces (`core`, `formats`, `server`, `viewer`); TS 6 project
  references; vitest with src aliases; ESLint 10 + typescript-eslint (browser-safety rule for core/formats);
  Prettier; `CLAUDE.md`; `.claude/` (settings, `pixel-art-advisor` + `qa-tester` agents, `/devlog` command).
- **Why:** TypeScript 6.0.3 instead of 7.x because typescript-eslint supports `<6.1`. Monorepo keeps
  `@pixelclaus/core` dependency-free and reusable by a future browser UI.
- **User decisions:** zip delivery, stdio + Streamable HTTP, project-folder storage, Aseprite import+export.

## 2026-10-06 · T3 Core engine (@pixelclaus/core)

- **What:** document model (`SpriteState` JSON + image/mask stores), transactional history (region patches,
  metadata snapshots, rollback, nested joins), colour resolution (index/hex/name/ramp refs; snap/add/error
  policies), 23 draw ops, selections, layers/groups/merge/flatten, frames/cels/tags/slices, palettes
  (24 presets, OKLCH ramps, detection, median cut), transforms (RotSprite, scale2x/3x, wrap offset), canvas
  ops, compositor (19 blend modes), annotated previews + 12 feedback views, lint (20 rules), metrics, ASCII I/O.
- **Why:** palette index 0 is reserved transparent → Aseprite files with transparent index 0 map 1:1;
  preset indices are "preset index + 1" (documented). Light shading auto-detects outlines so they are not
  highlighted (found via visual check of rendered previews).
- **Tests:** 96 core tests (colour, document/history, draw ops, structure, palette/transform/canvas).

## 2026-10-06 · T4 Formats (@pixelclaus/formats)

- **What:** PNG encoder (auto indexed 1/2/4/8-bit, adaptive filters) + full decoder (all types, Adam7);
  APNG (changed-rect frames, shared palette); GIF89a encoder/decoder (LZW, 1-bit alpha, cs delays with
  warnings); `.aseprite` read/write (layers, groups, linked cels, tags + user data, palettes, slices);
  sprite sheets (5 layouts, trim/dedupe/padding/extrude/POT/scale, Aseprite hash/array + TexturePacker);
  palette files (.hex/.gpl/.pal/.act); native `.pxc` container and image blobs.
- **Fix found by tests:** CRC32 was missing the final XOR.
- **Tests:** 19 format tests (round-trips through our own decoders; sharp cross-checks come with the server).

## 2026-10-06 · T5 Storage & services

- **What:** `ProjectStore` (project folders, atomic temp+rename writes, incremental dirty-image saves, GC of
  unreferenced blobs, thumbnails, `.pxc` checkpoints), `ProjectService` (LRU cache, id/name resolution with
  "did you mean", per-project async mutex, autosave after every mutation, reload when another process
  changed the manifest, checkpoint restore with automatic backup), `ExportService`, `ImportService`,
  sharp adapters (JPEG 4:4:4, lossless WebP, animated WebP, decoding any input).
- **Why:** stdio MCP processes come and go (Claude Desktop restarts them) while the viewer may run in another
  process — the manifest mtime check + revision counter keeps them consistent without a database.

## 2026-10-06 · T6 MCP server

- **What:** 24 tools (`guide`, `project_*`, `history`, `checkpoint`, `layer`, `frame`, `cel`, `tag`, `slice`,
  `canvas`, `draw`, `select`, `transform`, `palette`, `render`, `read_pixels`, `analyze`, `export`, `import`),
  server instructions, guide resources (`pixelclaus://guide/{topic}`), project resources, 3 prompts,
  stdio + Streamable HTTP (session per client, DNS-rebinding protection), CLI (`mcp`, `serve`, `info`).
- **Communication strategy:** batched atomic `draw` ops; ASCII grids with RLE and `[n]`; readback that
  round-trips; compact text results with rev/dirty rect/warnings; optional inline previews; numbers-first
  analysis; actionable errors (op index, hints, suggestions).
- **Optimisation:** zod `.int()` emits ±2^53 bounds into JSON Schema — removed them and de-duplicated
  per-op descriptions: draw schema 32 KB → 16.6 KB, whole tool list 73 KB → 53 KB.
- **Tests:** 34 server tests (service, export/import verified with sharp, MCP in-memory workflow over all
  tools, REST + MCP over HTTP, real stdio child process).

## 2026-10-06 · T7 Viewer

- **What:** `@pixelclaus/viewer` (Vite, vanilla TS, 18.7 KB JS): project grid with thumbnails, filter,
  live refresh (polls revisions every 3 s so Claude's edits appear while you watch), delete with confirm;
  project page with pixel-perfect canvas player (tags incl. ping-pong, step, zoom, backdrop), frame strip
  with durations and tag bars, layer panel (top → bottom, groups, per-layer thumbnails, preview-only
  visibility toggles, opacity/blend/linked badges), details + palette swatches; export dialog for every
  format with per-format options and a list of files Claude exported. Dark/light themes, mobile layout.
- **Verified:** Playwright screenshots (desktop dark, export dialog, mobile light) and a real download.

## 2026-10-06 · T8 Tests & lint

- **What:** ESLint clean (browser-safety rule fixed to match exact module names), architecture tests
  (core has zero deps and no Node APIs; formats only core + fflate), render/analysis/ASCII round-trip
  tests, colour-math/quantisation/transform tests, tool-coverage tests for every action of palette,
  select, layer, frame, cel, tag, slice, canvas and transform.
- **Bugs found by tests:** `tag update` failed when optional fields were omitted (undefined overwrote
  existing values); `doubles` lint missed staircase L-corners (now uses a 2x2-block test).
- **Status:** 179 tests passing; coverage ~84% statements / 88% lines.

## 2026-10-06 · T9 Expert review + QA pass, fixes

- **Expert review** (`pixel-art-advisor`, read-only) of the agent-facing surface. Fixed all MUST items:
  selout could erase an outline when the fill was already the darkest step; checkerboard period matched
  the pixel grid (read as pixels) → fixed 8 px checks with lower contrast; tile view hid seams under grid
  lines → no grid in tile view; sprite workflow in the guide contradicted itself → rewritten (flats with
  `ink:"inside"`, hand-placed shadows, outline inside/outside explained, selout as a separate step);
  `shade` without a mode silently shifted the whole cel → documented default + explicit result note;
  `offset` wrapped for every scope → wraps only for layer/sprite scope; pillow-shading fired on any
  outlined sprite → outline band excluded, asymmetry test. SHOULD/NICE items done: new lint rules
  `background-contrast` and `detail-density`; doubles/jaggies analyse only line art (outline colour);
  onion `outline` mode (neighbour silhouettes on top) as default; `analyze kind:"diff"` with best-fit
  shift and an ASCII change map; preview backdrop-clash warning; `rust` and nyx8 ramps; ramp floors.
- **QA pass** (`qa-tester`, tests only): 9 test files / 260 tests under `packages/*/test/qa/`, 1 critical +
  10 major defects + ~25 minor, all fixed:
  - D1 undo after GC lost images on disk → store tracks blobs on disk and re-writes any referenced blob
    that is missing; missing blobs on load now produce a warning instead of a silent blank cel.
  - D2 redo restored later pixels → replace patches keep a private clone (`after.clone()`).
  - D3 export could overwrite `project.json` → `outputDir` inside the projects root is refused unless it
    is the project's own exports folder.
  - D4/D5 ASCII readback: `?` collision and `2*33` RLE ambiguity → `[n]` cells, RLE runs end with a space,
    code-point tokenising (emoji legends), `|` reserved.
  - D6 huge shapes froze the server → shapes are clipped to the canvas, numbers guarded to ±65536.
  - D7 checkpoint restore name collision → random suffix, validation before the backup is made.
  - D8 outline/selout on an empty layer did nothing → `source` option (layer/composite/named layer) and
    "no pixels changed" notes on every silent op.
  - D9 out-of-range frames → errors in export, REST (404) and previews.
  - D10 sheet dedupe merged different trimmed shapes → hash includes size.
  - D11 REST export unvalidated → shared strict zod schema (`mcp/export-schema.ts`) for MCP and REST,
    JSON error handler (malformed JSON → 400, no stack traces).
  - Minor: draw replies grouped for large batches (300 ops < 3 KB); preview follows the frame actually
    drawn; contact/indexed/filmstrip views capped at 1024 px; lint merges identical findings across
    frames; import warns when colours are snapped and returns INVALID_ARGUMENT for undecodable files;
    tag colours validated; accents stripped in ids (`Ñandú` → `nandu`); untagged sheet frames numbered;
    GPL names / `.hex` detection; CLI exits 2 on unknown commands, documents `--restrict-paths`, `info`
    is read-only, numeric flags/env vars validated; history tool documents that undo is shared by all
    sessions on a project; spec lint list updated (`aa-halo` deferred).
- **Tests edited outside my own:** one QA precondition (the Hero example relied on outline-on-empty-layer
  behaviour that is now an explicit `source`) and one regex escape in `http-qa` for ESLint; semantics
  unchanged. My own new tests: `core/test/analysis-extra.test.ts`, `server/test/review-fixes.test.ts`.
- **Status:** 454 tests passing (incl. 260 QA), ESLint and typecheck clean.

## 2026-10-06 · T9b QA re-verification pass

- **Re-check by `qa-tester`** (8 new `*-recheck.test.ts` files, 109 tests, adversarial variants of D1–D11 and
  an end-to-end agent run exporting all 11 formats and re-importing .aseprite/.pxc pixel-exact). D1, D2,
  D4, D5, D8, D10 confirmed fixed; new findings fixed:
  - R1 (critical) fractional fill/wand seeds looped forever → seeds rounded in `floodRegion`; rect masks
    round too. R17: integer fields now validated server-side by an `int` schema (zod refinement published
    as plain `{"type":"integer"}` — no ±2^53 bounds, tool list 55 KB).
  - R2 (critical) `guardNumbers` skipped points after index 4096 → checks every element and more fields.
  - R3/R4 long in-range paths overflowed the stack / wide strokes took 5-10 s → no spread push; brush
    strokes skip points outside the reachable area (canvas ± one canvas size, so off-centre symmetry
    still works).
  - R7 symlinks could reach another project's `project.json` → real-path checks (`realPathDeep`) for
    export targets and restricted-path mode.
  - R9/R10/R11/R6 palette files: empty/unknown files are errors (art untouched); 256-colour ACT fitted
    to 255 entries (transparency entry and duplicates dropped first, with warnings); GPL names kept on
    replace and new-project imports (`setPalette({names})`, `createDocument({paletteNames})`); corrupt
    ACT counts clamped.
  - R14/R16 huge outputs: sheet padding/border/columns bounded, sheets ≤ 16384 px per side, export
    scale × size ≤ 16384, `Raster` refuses > 128 Mpx; render views reduce an explicit scale to stay
    ≤ 1600 px (`info.scaleReduced`).
  - R8 checkpoint restore reads/decodes the file before making the backup; blank names refused.
  - R12/R15 REST: `view.png` validates frame/view; unknown `/api/*`, missing projects/files are JSON 404s;
    REST errors never echo library messages or absolute paths; JSON-RPC envelopes only on `/mcp`.
  - R18 stamp validates the source frame and notes an empty source; R5 `|` legend keys are pixels;
    R19 endesga `rust` ramp re-picked (ΔL ≥ 0.10 per step); R20 strict CLI flags (`--k=v`, typo
    suggestions, missing values → exit 2).
  - UX notes: schema-validation errors now share the `Error [CODE]: … Hint:` format (patched SDK
    `createToolError`, pinned by tests); `read_pixels format:"json"` returns only rows; emoji legends
    ignore U+FE0F; import notes added frames and rejects fully off-canvas placement.
- **Own tests:** `core/test/robustness.test.ts`, `server/test/hardening.test.ts`.
- **Status:** 584 tests passing (36 files), ESLint/tsc/prettier clean, build OK.

## 2026-10-06 · T10 Final documentation and release

- **What:** README (features, install, Claude Desktop / Claude Code / HTTP setup, CLI, env vars, a sample
  agent session, docs index); `docs/architecture.md` (packages, document model, transactions, drawing
  pipeline, rendering budget, analysis, ASCII codec, storage, services, MCP communication strategy,
  transports, testing); `docs/formats.md` (every export/import format and option); `docs/viewer.md`
  (viewer usage, REST API, security notes); spec synced with the implementation.
- **Generated docs:** `npm run docs` (`packages/server/scripts/gen-docs.ts`) writes `docs/mcp-tools.md`
  (all 24 tools with parameter tables, a per-op table for `draw`, resources, prompts, error format) and
  `docs/guides/*.md` from the live server definition; a test fails when they go stale.
- **Verified:** clean build, ESLint, typecheck, Prettier; 586 tests across 36 files; an end-to-end stdio
  session against the built CLI (create → grid draw with preview → lint → duplicate/stamp frames → tag →
  timing → animation metrics → filmstrip → read_pixels → checkpoint → gif/apng/spritesheet/aseprite/
  animated-webp exports → validation error format).
- **Follow-ups (not done):** a drawing UI on top of `@pixelclaus/core`; `aa-halo` lint; checking
  `.aseprite` output against real Aseprite; tilemap layers; per-session undo scopes for shared HTTP
  servers.

## 2026-10-07 · T11 Many agents on one server

- **Report:** with 6-7 agents building different assets on one MCP server, agents were blocked until
  others finished.
- **Reproduced** (`npm run bench:agents`, built stdio server, 7 agents × 128×128 × 16 frames + a probe
  agent): every render/export/lint ran on the single event loop, so one agent's 4× GIF export froze
  everyone for 1-4 s. The probe's `project_get` p95 was 2.7 s (19 calls in the whole run); event-loop
  stalls reached 1.5 s. The tests also found three correctness bugs:
  - 7 concurrent `project_create {name:"Hero"}` all got id `hero`, so every agent edited the same
    project (non-atomic id allocation).
  - Viewer polling or other reads during a save made the service mistake its own new manifest for an
    external edit: it reloaded the project, wiped undo and warned "changed outside this session".
  - With more active projects than the cache size, LRU eviction silently dropped undo history; two
    concurrent first loads created two documents.
- **Fixes:**
  - `compute/`: a worker-thread pool (`PIXELCLAUS_THREADS`, default CPUs − 1, 2–8) for previews,
    exports, analysis, REST renders and thumbnails. Frame-scoped document copies (`docPayload`),
    priorities (previews first; batch work leaves one worker free), task timeout counted from worker
    ready, crash recovery, errors keep code/hint across threads, workers warmed at CLI start.
    `export-build.ts` and `compute/analyze.ts` are pure modules the workers run.
  - Atomic id reservation (exclusive `mkdir`, released on failure). The `project_create` reply flags
    suffixed ids, and a name shared by several projects is refused instead of resolving to one of them.
  - `ProjectService`: single-flight loads; readers trust in-flight saves (the entry is refreshed
    before the project is marked as writing); busy/recent projects are never unloaded (idle ≥ 10 min,
    hard cap 4× cache, default cache 32) and a notice explains a cleared undo; thumbnails are
    debounced on the pool, and deletes wait for in-flight thumbnail writes.
- **Result (same benchmark, 2-core sandbox):** probe `project_get` p95 **27 ms** (284 calls), max
  80 ms; event-loop stalls < 100 ms. Total wall time is CPU-bound on 2 cores (≈10 s either way); with
  more cores, exports run in parallel.
- **Tests:** `server/test/concurrency.test.ts` (id race, isolation, event-loop stalls < 400 ms under
  load, undo with more projects than the cache size, reads during saves, single-flight loads, 7 HTTP
  sessions) and `server/test/compute.test.ts` (payloads, worker/inline equivalence, parallelism,
  priorities, timeouts, error transport). The stall test fails with `PIXELCLAUS_THREADS=0` (2 s stall)
  and the race tests fail on the previous `ProjectService`. 601 tests pass.
- **Docs:** README "Many agents at once", architecture "Concurrency", guide/server instructions tell
  agents to use their own project id, CLAUDE.md rule for heavy work.

## 2026-10-07 · T11b QA concurrency pass and fixes

- **QA (`qa-tester`, 3 new files under `server/test/qa/*-concurrency-qa.test.ts`, 20 tests).**
  Confirmed working: 7 sessions hammering one project (draw, undo/redo, flips, checkpoints, exports,
  renders), frame add/remove races, delete during work, two processes, pool load (49 renders + 21
  exports + failing tasks), cache under 7 agents. Found and now fixed:
  - C1: an export in flight recreated a deleted project's folder → exports into the project folder
    check that the project still exists and never create its parents.
  - C2: a lowercase name shared by two projects silently opened another agent's project →
    `project_create` now refuses a name already in use (CONFLICT, suggests a free name);
    `ifExists:"suffix"` keeps automatic ids with the NOTE.
  - C3: a draw accepted during a checkpoint restore could be lost → backup and replacement run under
    one lock.
  - C4: the eviction notice claimed "idle" when the hard cap evicted → reason-specific notices.
- **Remaining risks from the report, also addressed:**
  - Cross-process change detection used mtime only → inode:mtime:size stamps. There is also a
    per-project `.lock` file around every mutation, so edits from several `pixelclaus mcp` processes
    on one data dir are serialised and never lost (verified: without the lock, the new test loses
    edits).
  - Saves never recreate a deleted project.
  - A per-project pixel budget (2^28 px) is checked before allocating, for backgrounds on many frames
    and for copying frames.
  - Huge ellipses/circles (r = 65536 on a 32 px canvas) now take 10-45 ms instead of 600 ms; only
    visible points are stored.
  - Name lookups use a 2 s listing cache, refreshed on a miss.
  - Checkpoint encoding/decoding (.pxc) runs on the compute pool (`pxc-encode` / `pxc-decode`), and
    saves compress blob by blob, yielding every ~8 ms. Checkpoints, restores and duplicates of a
    256×256 × 48-frame × 2-layer project no longer stall other agents.
- **Tests:** QA's two name tests were adapted to the new create default (marked "[developer, T11b]"),
  as was my own 7-agent "Hero" test (one success + 6 CONFLICTs; the suffix mode is covered
  separately). New tests cover stamps, fallback slugs, the name cache, no-resurrect saves, cross-process
  locks (including a stale lock) and the pixel budget. Test helpers warm the shared compute pool once,
  so timing tests don't pay the worker start from TypeScript sources. 630 tests pass (3 consecutive
  full runs). Final benchmark: probe `project_get` p95 22 ms / max 45 ms while 7 agents build assets.

## 2026-10-09 · Name, Windows fixes and GitHub release prep

- **What:** Names are now PixelClaus / `@pixelclaus/*` / `pixelclaus` (CLI, MCP server, `pixelclaus://`
  URIs) / `PIXELCLAUS_*` / `~/.pixelclaus`; the native backup format is `.pxc` (magic `PXC1`, image
  blobs `PXI1`). Added MIT `LICENSE`, `.gitattributes` (LF), CI (`.github/workflows/ci.yml`: Linux +
  Windows, Node 22/24), package metadata (author, repository), a new README (gallery, install, usage
  guide, troubleshooting) and `examples/showcase.ts` (`npm run showcase`), which draws the README images
  through the built stdio server.
- **Windows fixes:** atomic saves retry a rename that EPERM/EACCES/EBUSY refuses while another handle has
  the file open (`fs-utils.ts`, ~2.5 s); the dev compute worker uses `module.registerHooks()` where it
  exists (Node 26 deprecates `register()`, DEP0205). Tests: junctions instead of symlinks (no admin
  needed), file-URL import in the probe harness, `basename()`/drive-letter-aware path regexes, sharp
  reads buffers (libvips kept exported files locked), rm retries, and a failed write no longer leaves
  the "reads during saves" loop spinning.
- **Why:** publish on GitHub; the suite failed 8-19 tests on Windows, all environmental except the save
  retry, which was a real bug for several agents on one Windows machine.
- **Tests:** 630/630 pass, 3 consecutive full runs on Windows / Node 26; typecheck, lint, format clean.
- **Follow-ups:** `engines` is now `>=22.12` (Vitest 5 and Vite 8 need it).

## 2026-10-09 · Project skills for contributors

- **What:** `.claude/skills/` now ships four skills: `add-feature` (files to touch for a core command,
  tool, draw op, lint rule, compute task, export/import format, REST/viewer), `pixel-art-workflow`
  (drawing with the tools or a script, as in `examples/showcase.ts`), `windows-portability` (each
  Windows failure seen so far and where it is fixed) and `release-check` (CI gate, docs, secrets,
  clean-copy `npm ci`, smoke tests) with `check-links.mjs`, a Node link/anchor/image checker for
  Markdown. Listed in CLAUDE.md and the README; the read-only checks are allowed in `.claude/settings.json`.
- **Also:** thumbnail writes use `renameReplacing` too (a plain rename silently skipped the update on
  Windows while the viewer was reading the file); ESLint gives every `.mjs` Node globals.
- **Why:** other developers using Claude Code get the same workflows without re-deriving them.
- **Tests:** 630/630; lint, format, typecheck, build clean; link checker 0 problems, and it reports a
  missing file, a missing anchor and a missing image when given broken links.
