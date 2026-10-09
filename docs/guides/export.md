# Export

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

import {path|data, kind:auto|image|spritesheet|aseprite|pxc|palette, project?}: without project a new project is created; with project an image becomes a new layer and a palette replaces/appends.
