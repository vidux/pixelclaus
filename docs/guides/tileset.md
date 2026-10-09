# Workflow: tiles & tilesets

1. project_create with width/height = tile size (8/16/32) or a grid-aligned sheet (set grid to the tile size).
2. Draw the tile; render view tile (3x3 repetition) to see seams and repeating "hot spots".
3. transform {scope:"layer", op:"offset", dx:w/2, dy:h/2} moves the seams to the centre so you can paint across them (wrap defaults to true for layer/sprite scope; cel/selection scope moves without wrapping unless wrap:true); offset back afterwards.
4. analyze kind lint rules:["tile-seams"].
5. Keep 4-8 colours per tile; avoid high-contrast single features that visibly repeat.
6. For a sheet of tiles use slices (slice {action:"set", name:"grass_0", bounds}) so exports/JSON carry tile names.
