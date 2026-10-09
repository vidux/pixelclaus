---
name: add-feature
description: Adding or changing a PixelClaus feature end to end - a core command, an MCP tool or tool parameter, a draw op, a lint rule, a compute-worker task, an export or import format, a REST route or viewer change, or guide text. Lists the files to touch in each package, the conventions the tests and lint enforce (transactions, PixelClausError hints, the shared int schema, browser-safe core/formats, heavy work on the compute pool), and the closing steps (tests, npm run docs, hand-written docs, devlog). Use when implementing or modifying functionality in packages/core, formats, server or viewer.
---

# Adding a feature to PixelClaus

Read [CLAUDE.md](../../../CLAUDE.md) first: it holds the conventions. This skill says *where* each kind of
change goes. Dependencies only point one way: `viewer → (HTTP) → server → formats → core`.

## Where things go

| Change | Files |
| --- | --- |
| **Core command** | `packages/core/src/ops/<area>.ts`. Mutate only inside `doc.transact(label, (tx) => …)`, call `tx.writeImage(id)` before writing pixels, and throw `invalidArg(msg, hint)` / `notFound(…)` from `errors.ts`. Export it from `packages/core/src/index.ts`. Pattern: `setCelOpacity` in `ops/cels.ts`. |
| **MCP tool or parameter** | `packages/server/src/mcp/tools/{project,structure,pixels,view,io}.ts`: `server.registerTool(name, {title, description, inputSchema, annotations}, safe(async (a) => …))`. Annotations: `READ_ONLY`, `MUTATES` or `DESTRUCTIVE` from `mcp/context.ts`. Mutate through `ctx.projects.mutate(a.project, (doc) => …)`, read through `ctx.projects.read`, and reply with `new Reply().line(…).line(\`rev ${res.revision}\`).warnings(res.warnings).build()`. A new registrar is wired up in `mcp/server.ts`. |
| **Schema pieces** | `packages/server/src/mcp/schemas.ts`: `int`, `projectRef`, `layerRef`, `frameSpec`, `rectSchema`, `point`, colour refs. Integer fields use `int`, never `z.number().int()` (that adds ±2^53 bounds to the JSON Schema). |
| **Draw op** | Type: the `DrawOp` union in `core/src/ops/draw-types.ts`. Behaviour: a `case` in `core/src/ops/draw.ts` (or `draw-ops-extra.ts`). Schema: the `drawOp` discriminated union in `server/src/mcp/schemas.ts`. Then add a line to the `ops` cheat sheet in `server/src/mcp/guide.ts`. The docs table is generated from the schema. |
| **Lint rule** | Add the id to `LINT_RULES` in `core/src/analysis/lint-types.ts` (and to `OPT_IN_RULES` if it should not run by default). Implement it in `analysis/lint.ts` as an `if (rules.has('id')) {…}` block: findings carry coordinates (at most `MAX_PIXELS`) and a hint that says what to do. Describe it in the `lint` topic of `guide.ts`. The MCP enum follows automatically (`lintRule = z.enum(LINT_RULES)`). |
| **Heavy read-only work** (render, encode, analyze) | Never run it on the main thread. Add a `kind` to `ComputeTask` and a `case` in `server/src/compute/tasks.ts`. In the handler: `const r = await ctx.projects.read(id, (doc) => docPayload(doc, {frames}))`, then `ctx.compute.run({kind, doc: r.value.payload, …}, r.value.transfer)`. Pattern: `render` in `mcp/tools/view.ts`. |
| **Export format** | Codec in `packages/formats/src/` (browser-safe: no `node:*`, no sharp; ESLint and `architecture.test.ts` enforce this), exported from its `index.ts`. Add the format to `EXPORT_FORMATS` and the `switch` in `server/src/services/export-build.ts`; the MCP schema (`mcp/export-schema.ts`) and REST `/api/formats` pick it up. Viewer options: `packages/viewer/src/views/export-dialog.ts`. Hand-written docs: `docs/formats.md` and the `export` topic in `guide.ts`. |
| **Import** | `server/src/services/import-service.ts`. Node-only decoding (sharp) lives in `services/raster-codecs.ts`. Pass sharp buffers, not file paths: libvips keeps files locked on Windows. |
| **REST / viewer** | Routes in `server/src/http/api.ts`, UI in `packages/viewer/src/`. Update `docs/viewer.md` by hand. |
| **Storage** | `server/src/storage/`. Replace files atomically: `writeFileAtomic`, or your own temp file plus `renameReplacing` (both in `fs-utils.ts`). A plain `fs.rename` onto a file that a reader has open fails on Windows. |

## Writing tool descriptions

The description and parameter `.describe()` strings are the agent's whole manual. Keep them compact:
list the actions as `add {a, b?} · update {…} · remove {…}`, state units (ms, px, 0-indexed, inclusive
ranges), and make errors actionable. A `PixelClausError` hint should name the next step, for example
the valid layer names.

## Tests

- Unit tests go in the package's `test/` folder (`packages/<pkg>/test/*.test.ts`); vitest runs them
  from `src` through aliases.
- Tool tests: `mcpClient()` from `packages/server/test/helpers.ts` gives an in-memory MCP client with
  `call(name, args)` → `{text, images, isError}`. `tools-coverage.test.ts` walks every action of the
  structure and pixel tools. Render, analyze, export, import, history and checkpoints are tested in
  `mcp.test.ts`, `export-import.test.ts` and `service.test.ts`. Extend the file closest to your change.
- `packages/*/test/qa/` belongs to the `qa-tester` agent. Ask it to exercise the new feature rather
  than editing its tests by hand. The exception is fixing a broken harness, such as a portability bug.
- Write portable tests: see the `windows-portability` skill.

## Closing steps (every feature)

1. `npm run docs` after touching tool schemas, descriptions or `guide.ts`. `hardening.test.ts` fails
   when `docs/mcp-tools.md` or `docs/guides/` are stale.
2. Update `docs/architecture.md`, `docs/formats.md` or `docs/viewer.md` by hand when public
   behaviour changes.
3. `npm run lint && npm run typecheck && npm run build && npm test`. The CLI tests start the built
   CLI, so build before testing.
4. Append a devlog entry (`/devlog`): date, what, why, tests, follow-ups.
5. Keep modules under ~400 lines and one concept each. Split before a file grows past that.
