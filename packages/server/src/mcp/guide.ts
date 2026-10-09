/**
 * In-tool guidance for the agent (served by the `guide` tool, `pixelclaus://guide/{topic}` resources and
 * prompts). Distilled from docs/research/expert-advice.md.
 */
import { PRESETS } from '@pixelclaus/core';

export const SERVER_INSTRUCTIONS = `PixelClaus: a pixel-art and sprite-animation editor you operate through tools.
Conventions: coordinates are whole numbers, 0-indexed with origin top-left; rects are {x,y,w,h}; line/path endpoints are inclusive; frames are 0-indexed; palette index 0 is ALWAYS transparent ("." in ASCII grids); durations are ms.
Loop: project_create → draw (batch many ops per call; each call = one undo step) → render (composite / indexed / value / silhouette / filmstrip) + analyze lint → fix → checkpoint → export.
Write sprites ≤48px with draw op "grid" (ASCII, one char per pixel); verify exact pixels with read_pixels before claiming positions. Previews include a 1x inset: judge readability at 1x, not at zoom.
Several agents may share this server: create your own project (a name already in use is refused with CONFLICT — pick another name unless the project is yours) and pass its id in every call.
Call guide (topics: overview, ascii, sprite, animation, tileset, palettes, lint, export, ops) when unsure.`;

const presetList = PRESETS.map((p) => `- **${p.name}** (${p.colors.length}) — ${p.description}`).join('\n');

export const GUIDE: Record<string, string> = {
  overview: `# PixelClaus overview

**Conventions** — 0-indexed coords, origin top-left, x→right, y→down. Rects {x,y,w,h}. Line/path endpoints inclusive. Frames 0-indexed, ranges {from,to} inclusive. Palette index 0 = transparent; colours start at 1 (preset index + 1). Layers by id ("L3") or unique name; projects by id or name.

**Tools**
- Projects: project_create, project_list, project_get, project_update, project_delete, project_duplicate
- Safety: history (undo/redo/list), checkpoint (create/list/restore/delete — persisted snapshots)
- Structure: layer, frame, cel, tag, slice, canvas
- Pixels: draw (batch of ops), select (named masks), transform, palette
- Seeing: render (PNG views), read_pixels (exact ASCII), analyze (stats/colors/lint/animation/diff)
- Files: export, import

**Efficient loop**
1. Plan size, palette, light direction (settings.lightDirection) and preview background.
2. One draw call per logical step with many ops (they are atomic: any error rolls back the whole call).
3. render view composite (default) → check the 1x inset; view value for contrast; view silhouette for readability.
4. analyze kind lint → fix findings; checkpoint before risky edits.
5. export (png/gif/apng/webp/spritesheet/aseprite…).

Results always include \`rev\`, pixel counts and warnings (snapped colours, linked cels, hidden/locked layers). Read warnings.

**Working alongside other agents** — one server can serve many agents at once (parallel subagents, several sessions over HTTP). Each agent should create its own project and always pass the id returned by project_create. A name that is already in use (maybe by another agent) is refused with CONFLICT and a suggested free name; continue an existing project only if it is yours (ifExists:"suffix" gives an automatic id such as "hero-2" instead). Projects never block each other; calls on the same project run one at a time. Undo history is per project and shared by everyone editing it.`,

  ascii: `# ASCII pixel grids (draw op "grid", read_pixels)

One character per pixel, rows top→bottom. Whitespace is ignored.
- \`.\` transparent (index 0) · \`~\` leave pixel unchanged
- default alphabet = palette indices: \`0-9\` → 0-9, then \`a b c d e f g h i j k m n p q r s t u v w x y z A B C D E F G H J K L M N P Q R S T U V W X Y Z\` → 10-57 (no l, o, I, O)
- \`c*n\` repeats c n times: \`.*3k*4.\` = \`...kkkk.\`
- \`[n]\` palette index n (any index, e.g. \`[63]\`)
- \`legend: {"k": 25, "s": "#f4b41b"}\` overrides chars (any single non-space char except * [ ] ~)
- row prefixes like \`07| \` and header lines starting with \`|\` (read_pixels output) are accepted, so you can paste a readback, edit it and write it back.
- mode "replace" (default) writes "." as transparent; mode "overlay" skips "." (draw on top).

Every row must have the same width — errors name the exact rows. Use x/y to write a sub-region (patch) instead of rewriting the sprite.

Example (8x8 coin) using a legend so the art is readable — o outline, d dark, m mid, h highlight:
\`\`\`json
{"op":"grid","x":0,"y":0,
 "legend":{"o":"#3b1f0f","d":"#b86f50","m":"#f4b41b","h":"#fff6d3"},
 "rows":["..oooo..",
         ".odmmdo.",
         "odmhhmdo",
         "odmhmmdo",
         "odmmmmdo",
         "oddmmddo",
         ".oddddo.",
         "..oooo.."]}
\`\`\`
Hex legend colours resolve to the palette (snapped with a warning when missing); prefer palette indices or colour names (\`"skin"\`) for exact control.
Tips: keep grids ≤ 48 px wide (longer rows get miscounted); use rect/ellipse/fill for big areas, grid for details; read_pixels a region before editing it.`,

  sprite: `# Workflow: a single sprite

1. **Create** — project_create {name, width, height, palette:"endesga-32"|"pico-8"|…, settings:{lightDirection:"top-left", previewBackground:"#1a1c2c"}}. Leave 2-4 px margin for animation.
   Sizes: characters 16x16, 16x24, 32x32, 32x48, 48x48, 64x64 · tiles 8/16/32 · icons 16/24/32 · portraits 32-128.
2. **Silhouette** — one dark colour (grid op or ellipse/rect/polygon). render view silhouette + look at the 1x inset. Iterate until the pose/shape reads at 1x. Leave 1 px of room on every side if you will add an outside outline.
3. **Flats** — 3-5 big colour regions painted over the silhouette with ink:"inside" (alpha lock: only existing pixels change, the shape stays exact). render view value: regions must separate by lightness, not just hue.
4. **Shadows by hand** — decide the light (settings.lightDirection) and place hard-edged shadow shapes one ramp step darker on the far side of each form (rect/polygon/grid with ink:"inside", or shade {mode:"shift", amount:-1, clip}). shade {mode:"light"} is only a rough first pass — always correct it by hand. Then add small highlights on light-facing edges. Avoid pillow shading (light in the middle, dark all around).
5. **Outline** — either outline {side:"outside", color} (GROWS the shape by 1 px on every side — needs the margin from step 2) or outline {side:"inside", color} (recolours the shape's own edge pixels, size unchanged — usual for tight 16 px sprites). Use the darkest shade of the dominant ramp, not pure #000000 (unless 1-bit style).
6. **Selout** — after the outline exists, draw op selout recolours each outline pixel from the colour it encloses (darker on the shadow side, lighter toward the light, gaps opened toward the light). selout never adds pixels; it only recolours an existing outline.
7. **Anti-aliasing** — manual, only on interior curves/colour boundaries, never against transparency.
8. **Cleanup** — analyze kind lint; remove stray/orphan pixels, fix doubles/jaggies, stay within the colour budget (16px: 3-5 + outline · 32px: 5-9 · 64px: 10-18). checkpoint.
9. **Export** — export png scale 1 and 4; spritesheet for engines.

Colour rules: adjacent ramp steps ΔL ≥ 0.08 with a hue shift (shadows cooler/toward blue-purple, highlights warmer/toward yellow). Share colours between materials. The sprite must contrast with the game background (set settings.previewBackground and render against it; lint background-contrast checks this).`,

  animation: `# Workflow: animation

**Model** — frames have durations (ms); tags name ranges {from,to} with direction forward|reverse|pingpong|pingpong_reverse and repeat (0 = loop). Cels are a layer's image at a frame; linked cels share one image (edit once, all frames change — results warn you). Continuous layers link new frames automatically.

**Steps**
1. Draw the key pose on frame 0. Put static parts (body, background props) and moving parts (arms, hair, FX) on separate layers.
2. frame {action:"duplicate", frame:0, count:N} copies frames. Keep static layers shared: mark them continuous (layer {action:"update", continuous:true}) before adding frames, or link existing cels with cel {action:"link"} — then an edit on one frame updates all of them.
3. Key poses first (e.g. contact L / contact R; anticipation / strike / recovery) with long holds, then breakdowns, then in-betweens. Add an in-between only where analyze kind animation (or render view diff) shows a part jumping more than 2 px between neighbouring frames.
4. Move whole parts with cel {action:"move", dx, dy} (cheap, exact) or draw op stamp {from:{frame}, dx, dy}; interpolate offsets with cel {action:"tween"}.
5. Timing via durations, not frame count: frame {action:"duration", frames, durations:[…]}.
6. tag {action:"add", name:"walk", from, to}.

**Typical cycles** — sprites animate in place (treadmill): the character's position does not advance; the game moves it. At 16-32 px use the low end of each frame count; bigger sprites get more in-betweens.
- idle: 2-4 frames @ 180-250 ms, 1 px bob
- walk: 4 @ 120 ms (contact, down, passing, up) · 6 @ 100 · 8 @ 80
- run: 6-8 @ 60-80 ms, lean 1-2 px, one airborne frame
- attack: anticipation 120-180 → smear 40-60 → strike hold 80-120 → recovery 2×100
- jump: crouch 100 · launch 60 · rise · apex · fall · land/squash 80 (separate tags)
- hit: 2-3 @ 70-90 with 1-2 px knockback, flash via palette · death: 4-8 @ 100-150, last 400+

**Principles** — 1-frame anticipation; one smear frame for fast motion; squash/stretch ≤ 1 px at 16 px (2 px at 32); feet on the same baseline row on contact frames; secondary motion (hair, cape) lags 1 frame; key-pose silhouettes must differ; sub-pixel motion = shift an edge pixel one ramp step instead of moving it.

**You cannot watch playback** — use instead:
- render view filmstrip {tag, baseline:<feet row>} — all frames side by side with ms; ping-pong unrolled
- render view onion {frame, onion:{prev:1, next:1, mode}} — mode "outline" (default): current frame dimmed, previous frame's silhouette edge red, next blue (overlaps stay visible); mode "tint": red/blue ghosts under the current frame
- render view diff {frame, compareFrame} — added magenta, removed cyan, recoloured yellow + counts; analyze kind diff gives the numbers, the best-fit shift and an ASCII change map
- render view trail — centroid path · render view timing — duration bars
- analyze kind animation {tag} — per-frame bbox, centroid, bottom row, changed pixels (most reliable)
- analyze kind lint — baseline-drift, frame-jitter, size-drift`,

  tileset: `# Workflow: tiles & tilesets

1. project_create with width/height = tile size (8/16/32) or a grid-aligned sheet (set grid to the tile size).
2. Draw the tile; render view tile (3x3 repetition) to see seams and repeating "hot spots".
3. transform {scope:"layer", op:"offset", dx:w/2, dy:h/2} moves the seams to the centre so you can paint across them (wrap defaults to true for layer/sprite scope; cel/selection scope moves without wrapping unless wrap:true); offset back afterwards.
4. analyze kind lint rules:["tile-seams"].
5. Keep 4-8 colours per tile; avoid high-contrast single features that visibly repeat.
6. For a sheet of tiles use slices (slice {action:"set", name:"grass_0", bounds}) so exports/JSON carry tile names.`,

  palettes: `# Palettes & colour

- Indexed sprites (default) store palette indices: changing a palette colour recolours every pixel that uses it (palette swap). RGBA sprites store colours; with settings.paletteLock (default true) written colours snap to the palette.
- Unknown hex colours follow settings.missingColor: "snap" (nearest + warning, default), "add" (append to palette), "error".
- palette actions: get · presets · load_preset {name, strategy:"nearest"|"index"} · set {colors} · set_colors [{index,color,name}] · add · remove {indices, replacement} · sort {by} · remap {mapping} · generate_ramp {base, steps, name} (OKLCH hue-shifted) · set_ramps · auto_ramps · adjust {hue,saturation,lightness…} · extract {max} (RGBA → palette).
- Ramps (ordered dark→light index lists) drive shade, selout and "ramp:<name>:<step>" colour refs.
- Name colours (set_colors name) and use names in ops: color:"skin".
- export paletteVariants:[{name, palette}] renders the same sprite with several palettes (skins).

Presets (index in PixelClaus = preset index + 1):
${presetList}`,

  lint: `# Lint rules (analyze kind:"lint")

Pixel cleanliness
- stray-pixels — isolated pixel with no same-layer neighbour
- orphan-pixels — interior pixel whose colour has no same-colour neighbour (noise)
- doubles — 2x2 clumps / L-corners in 1-px LINE ART (only the outline colour is analysed: settings.outlineColor, else the dominant darker edge colour)
- jaggies — irregular run lengths (3-1-3) along a line-art edge going one direction
- detail-density (info) — too many interior pixels differ from their neighbours (over-detailed / noisy at this size)
Colour
- semi-transparent · off-palette (RGBA) · near-duplicate-colors · color-budget (settings.colorBudget or a size default) · unused-palette · rare-colors
- ramp-contrast — adjacent ramp steps with ΔL < 0.05 or no hue shift
- black-outline — pure #000 outline (fine for 1-bit/retro styles)
- background-contrast — silhouette edge too close in lightness to settings.previewBackground (the sprite will vanish in game)
Shading
- pillow-shading — light in the middle and dark all around instead of a consistent light direction
- banding — parallel, equal-width colour steps aligned with each other
- outline-gaps — breaks in the outline (needs settings.outlineColor)
Animation (multi-frame)
- baseline-drift (feet row moves) · frame-jitter (bbox wobbles without intent) · size-drift (area changes > tolerance)
Opt-in: tile-seams (edges that do not match when tiled) · symmetry.

Identical findings on several frames are merged (frames:[…]). Findings include up to 24 pixel coordinates and a hint. Not every finding is a bug — deliberate highlights and accents are fine — but stray pixels, doubles and drift usually are. Pass rules:[…] to run a subset.`,

  export: `# Export

export {format, …}: files go to the project's exports folder unless outputDir is given. Integer scale 1-16 only (nearest neighbour).
- png / webp (lossless) / jpg (needs background matte, defaults to white) — frame, layers, splitLayers, trim, background
- gif — ≤ 256 colours (quantised with a warning), 1-bit alpha, delays rounded to 10 ms, < 20 ms clamped
- apng / webp_animated — full alpha, exact ms timing (better previews than GIF)
- frames — PNG sequence (tag or frames)
- spritesheet — sheet {layout: horizontal|vertical|grid|rows (one row per tag)|packed, columns, padding, border, extrude, trim, mergeDuplicates, powerOfTwo, splitLayers, json: aseprite-hash|aseprite-array|texturepacker|none, filename:"{title}-{tag}-{tagframe:00}"}
- aseprite — .aseprite with layers, groups, linked cels, tags, slices, palette
- pxc — PixelClaus native single-file backup
- palette — paletteFormat hex|gpl|pal|act
Animated formats accept tag (ping-pong unrolled) or splitTags:true (one file per tag); loops default to the tag's repeat (0 = forever).

import {path|data, kind:auto|image|spritesheet|aseprite|pxc|palette, project?}: without project a new project is created; with project an image becomes a new layer and a palette replaces/appends.`,

  ops: `# draw ops cheat sheet

Call shape: draw {project, layer, frame, ops:[…], symmetry?, ink?, clip?, preview?}. Every op may override layer/frame/ink/clip.
- pixels {points:[[x,y],[x,y,color]], color}
- grid {x,y, rows:[…], legend?, mode?} — see guide ascii
- line {from:[x,y], to:[x,y], color, width?, brush?}
- path {points:[…], color, closed?, pixelPerfect?=true}
- rect {x,y,w,h, color?(outline), fill?, thickness?} · ellipse {x,y,w,h, color?, fill?} · circle {cx,cy,r, color?, fill?} · polygon {points, color?, fill?}
- fill {x,y, color, contiguous?=true, tolerance?, connectivity?, reference?:"composite"}
- replace_color {from, to, scope?: cel|layer|frame|sprite}
- gradient {from, to, colors:[ramp…], type?: linear|radial, dither?: bayer4|bayer2|bayer8|checker|none, area?}
- pattern {pattern: checker|checker-2|lines-h|lines-v|diagonal|diagonal-alt|grid|dots|bricks|bayer-25|bayer-50|bayer-75|["10","01"], colors:[on, off?], area?}
- outline {color, side?: outside (grows the shape 1 px) | inside (recolours edge pixels), connectivity?, source?} · selout {light?, source?} (recolours an EXISTING outline from what it encloses — run it after outline)
- shade {mode?:"shift" (default), amount?: -1 (default) | +1 | n, area?|clip?, ramp?} · shade {mode:"light", light?, depth?, outline?} (rough first pass; refine by hand)
- erase {area|points} · clear {} · copy {name, area, source?: layer|composite} · paste {name, x?, y?}
- stamp {from:{layer?,frame?,area?}, dx?,dy? | x?,y?, flipX?, flipY?, mode?} — copy pixels between frames/layers
- text {x,y,text,color,font?: 5x7|3x5}
- adjust {hue°, saturation, lightness, brightness, contrast (−1..1), invert, desaturate} · quantize {dither?}
Ink: replace | behind (only empty pixels) | inside (alpha lock) | blend. Symmetry {x:true} mirrors left/right.
Coordinates, sizes, frames and counts are whole numbers (15.5 is rejected — round it yourself) within ±65536. Shapes may extend past the canvas; only the visible part is drawn. An op that changes no pixels is reported with a note.`,
};

export const GUIDE_TOPICS = Object.keys(GUIDE);
