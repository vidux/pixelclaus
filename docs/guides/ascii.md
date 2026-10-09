# ASCII pixel grids (draw op "grid", read_pixels)

One character per pixel, rows top→bottom. Whitespace is ignored.
- `.` transparent (index 0) · `~` leave pixel unchanged
- default alphabet = palette indices: `0-9` → 0-9, then `a b c d e f g h i j k m n p q r s t u v w x y z A B C D E F G H J K L M N P Q R S T U V W X Y Z` → 10-57 (no l, o, I, O)
- `c*n` repeats c n times: `.*3k*4.` = `...kkkk.`
- `[n]` palette index n (any index, e.g. `[63]`)
- `legend: {"k": 25, "s": "#f4b41b"}` overrides chars (any single non-space char except * [ ] ~)
- row prefixes like `07| ` and header lines starting with `|` (read_pixels output) are accepted, so you can paste a readback, edit it and write it back.
- mode "replace" (default) writes "." as transparent; mode "overlay" skips "." (draw on top).

Every row must have the same width — errors name the exact rows. Use x/y to write a sub-region (patch) instead of rewriting the sprite.

Example (8x8 coin) using a legend so the art is readable — o outline, d dark, m mid, h highlight:
```json
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
```
Hex legend colours resolve to the palette (snapped with a warning when missing); prefer palette indices or colour names (`"skin"`) for exact control.
Tips: keep grids ≤ 48 px wide (longer rows get miscounted); use rect/ellipse/fill for big areas, grid for details; read_pixels a region before editing it.
