# PixelClaus — guidance for Claude (developer mode)

PixelClaus is an agent-first pixel-art & sprite-animation editor exposed over MCP. You (Claude) are both the
**developer** of this repo and the **end user** of its MCP tools. This file is for working *on* the codebase.
For using the tools, call the `guide` MCP tool or read `docs/guides/`.

## Layout

```
packages/core      @pixelclaus/core     pure TS engine: model, history, commands, drawing, render, analysis (NO deps, NO Node APIs)
packages/formats   @pixelclaus/formats  codecs: PNG/APNG/GIF/.aseprite/sprite sheets/palettes/.pxc (browser-safe, uses fflate)
packages/server    @pixelclaus/server   storage, services, MCP tools (stdio + HTTP), REST API, CLI (Node)
packages/viewer    @pixelclaus/viewer   static web UI (Vite, vanilla TS) — consumes REST API only
examples/          scripts that drive the built MCP server (README gallery: npm run showcase)
docs/              design spec, research, guides, devlog
```

Dependency direction is strictly `viewer → (HTTP) → server → formats → core`. Never import Node built-ins in
`core` or `formats` (ESLint + `architecture.test.ts` enforce this).

## Commands

```bash
npm install            # once
npm run build          # tsc -b for core/formats/server + vite build for viewer
npm test               # vitest (src via aliases; the CLI tests start the CLI, so build once first)
npm run lint           # eslint
npm run typecheck      # tsc -b + viewer tsc
npm run dev            # HTTP server (MCP at /mcp + viewer + REST) via tsx
npm run mcp            # stdio MCP server (after build)
npm run docs           # regenerate docs/mcp-tools.md + docs/guides/ from the live tool definitions
npm run bench:agents   # multi-agent benchmark against the built stdio server (args: agents size frames)
npm run showcase       # redraw docs/images/ through the built stdio server (args: outDir previewDir)
```

## Code conventions

- TypeScript strict, ESM, `.js` extensions in relative imports (NodeNext).
- One concept per module; keep files < ~400 lines. Export public API through each package's `src/index.ts`.
- Core mutations **must** go through `doc.transact(label, tx => …)`. Never mutate `doc.state` or a
  `PixelBuffer` outside a transaction (history/undo and dirty tracking depend on it). Use `tx.writeImage(id)`
  before writing pixels.
- Throw `PixelClausError(code, message, hint?)` for user-facing errors; hints should tell the agent what to do
  next (e.g. list valid layer names).
- Coordinates: 0-indexed, top-left origin, rects `{x,y,w,h}`, inclusive line endpoints, inclusive frame ranges.
- Palette index 0 is always transparent.
- MCP tool handlers stay thin: validate (zod) → call a service/core command → format a compact result.
- Integer tool fields use the shared `int` schema (`mcp/schemas.ts`), never `z.number().int()` (it bloats the
  JSON Schema with ±2^53 bounds).
- CPU-heavy, read-only work (rendering/PNG encoding, exports, analysis) never runs on the main thread:
  copy what it needs with `docPayload(doc, {frames})` inside `projects.read`/`mutate`, then
  `ctx.compute.run({kind, …})` (add new kinds in `compute/tasks.ts`). Several agents share one process.
- Every new feature needs tests in the package's `test/` folder.

## Workflow rules for this repo

1. Update `docs/devlog.md` after each completed task (date, what, why, follow-ups).
2. Commit after each main step with a descriptive message.
3. Keep `docs/` in sync when changing public behaviour: run `npm run docs` after touching tool schemas,
   descriptions or `mcp/guide.ts` (a test fails when the generated docs are stale); update
   `docs/architecture.md`, `docs/formats.md`, `docs/viewer.md` by hand.
4. Agents in `.claude/agents/`: `pixel-art-advisor` (read-only domain expert) and `qa-tester`
   (tests only — never edits source; may add tests under `packages/*/test/qa/`).
5. Skills in `.claude/skills/`: `add-feature` (where each kind of change goes), `pixel-art-workflow`
   (drawing with the tools), `windows-portability` (Windows-only failures), `release-check` (before a
   PR or release). Update a skill when its steps or file pointers stop matching the code.
