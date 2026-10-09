---
name: pixel-art-workflow
description: Making pixel art, sprites, animations and sprite sheets with PixelClaus, either through the pixelclaus MCP tools loaded in the session or, when they are not loaded, by scripting the built stdio server like examples/showcase.ts does. Covers the design loop (ASCII grid + legend flats, outline, shading, render, lint), animation with frame/cel/tag, palette-swap skins, exports with stable file names, and checking your own work by reading the render PNGs. Use when asked to draw or animate something with PixelClaus, to regenerate the README gallery, or to exercise the tools end to end.
---

# Making pixel art with PixelClaus

The in-tool guides are the reference (`guide` tool, or [docs/guides/](../../../docs/guides/README.md)).
This skill is the working loop that produced the README gallery. For a critique of finished art, ask
the `pixel-art-advisor` agent.

## Two ways to call the tools

- **MCP tools loaded** (`mcp__pixelclaus__*`): call them directly. Register the server with
  `claude mcp add pixelclaus -- node <repo>/packages/server/dist/cli.js mcp --viewer`.
- **Not loaded:** write a script like [examples/showcase.ts](../../../examples/showcase.ts). It starts
  `packages/server/dist/cli.js mcp --data <tmp>` with `StdioClientTransport` from
  `@modelcontextprotocol/sdk`, and has helpers you can copy: `call()` throws on `isError`, `look()`
  saves render PNGs, and `exportAs()` renames exports. Run `npm run build` first; the script uses `dist/`.

## Design loop

1. **Palette first.** `palette {action:"get"}` lists `1=#be4a2f 2=…` and the ramps. Use palette
   **indices** in legends: hex colours snap to the nearest entry with a warning. endesga-32 ramps:
   green [16,15,14,13], fire [8,10,11,12], red [7,8,9,30], gray [26…20], skin [7…3].
2. **Flats as a grid.** Draw an ASCII `grid` op with a `legend` (character → index) that holds only the
   flat colours. Leave 1 px of margin on every side. Build symmetric rows from explicit segments
   (`"ssss"+"ee"+"ssssss"+"ee"+"sss"+"S"`): miscounted rows are the most common mistake, and the tool
   only checks that all rows have the same width.
3. **Outline.** `outline {side:"outside", color:<darkest>}` traces the whole silhouette. Skip `selout`
   for art that will be shown on white *and* dark pages: it recolours outline pixels on the lit side to
   the fill colour, so a white shape disappears on a white page.
4. **Shading.** Place shadows and highlights by hand in the grid, or use `shade {mode:"light", ramp}`
   on round shapes, then fix the stray pixels it leaves (lint reports them as orphan-pixels).
5. **Look.** `render` with the composite, value and filmstrip views. From a script, write `images[0]`
   (base64 PNG) to a scratch folder and Read the file. Check symmetry, the 1× inset and the outline.
6. **Lint.** Run `analyze {kind:"lint", frames:"all"}`. Fix colour-budget warnings (≈10 colours at
   32 px, ≈6 at 16 px) by sharing colours between materials. Orphans that are deliberate highlights,
   and baseline-drift caused by an intended bob, are fine.

## Animation

- `frame {action:"duplicate", frame:0, count:N}` copies the key pose.
- `cel {action:"move", frames:[i], dy:1}` makes a bob. A small `grid` patch with `~` ("leave unchanged")
  makes a blink or other local change.
- To draw different frames in one call, put `frame` on each op.
- Timing goes in durations, not in extra frames: `frame {action:"duration", frames:"all", durations:[…]}`.
- Finish with `tag {action:"add", name, from, to}`, then check `render {view:"filmstrip", tag}`.

## Export

- `export {format:"gif"|"png"|"spritesheet"…, scale, tag|frame}`. File names get suffixes
  (`name-f0@8x.png`, `name-tag-tag@6x.gif`). Parse the `^- (.+?) \(` lines of the result to rename them.
- Palette-swap skins: `paletteVariants:[{name, palette:[…full hex list…]}]` writes one file per
  variant, in order.
- From a script, stage exports inside the output folder: moving a file from the C: temp folder to
  another drive fails with EXDEV.

## Scenes and posters

[examples/social-banner.ts](../../../examples/social-banner.ts) draws a framed 1080×1080 animated banner
(135×135 at 8×). Things that worked:

- **Seamless loops.** Choose the frame count first (30 × 100 ms = 3 s), then make every cycle divide it:
  a 10-frame hop, a 5-frame coin spin, `sin(2π·k·f/30)` bobs, and snow whose speed × 30 is a whole
  number of wraps. For a chase of N phases, make the bulb count divisible by N too. The bulb spacing
  must also divide the distance between the corner bulbs (here 9 px band, 6 px spacing, 84 bulbs).
- **Static layers once.** Create the project with all its frames, draw sky, frame, ground and text on
  frame 0, then `cel {action:"link", frames:"all"}` per static layer. Draw animated layers with one
  `draw` call per frame and `layer` on each op.
- **Big titles.** `text` (5x7), then `transform {op:"scale", factor:2, method:"scale2x"}`. Scaling
  re-centres the whole layer on the canvas, so read the new position with
  `analyze {kind:"stats", layers:[…]}` and put it back with `cel move`.
- **Extruded title.** Draw the outline first, then `select alpha` of the title layer, `select move
  {dy:2}`, and fill a layer underneath with that selection as `clip`. If you take the selection before
  the outline, the shadow shows through the letters' counters.
- **Shine.** Take a `select color` of the fill colours (not the outline), then draw a moving diagonal
  `polygon` with that selection as `clip` on a layer above.
- **Text over particles.** Give text over moving snow or stars a dark `outline`, otherwise a passing
  flake turns "O" into "Q". Keep dithered gradients away from text and particles: flat bands with a
  2-row `pattern: "checker"` transition read better, with the band edges placed between text lines.
- **Size.** The GIF encoder stores full frames: 30 frames at 1080² came to 1.4 MB, well under the
  5 MB that social networks commonly accept.

## README gallery

`npm run build && npm run showcase` redraws [docs/images/](../../../docs/images/). Output is
deterministic, so an unchanged drawing gives byte-identical files. `npm run showcase -- <out>
<previewDir>` also saves the render views the script looked at.
