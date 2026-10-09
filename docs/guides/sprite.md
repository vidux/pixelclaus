# Workflow: a single sprite

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

Colour rules: adjacent ramp steps ΔL ≥ 0.08 with a hue shift (shadows cooler/toward blue-purple, highlights warmer/toward yellow). Share colours between materials. The sprite must contrast with the game background (set settings.previewBackground and render against it; lint background-contrast checks this).
