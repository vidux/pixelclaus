# PixelClaus overview

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

Results always include `rev`, pixel counts and warnings (snapped colours, linked cels, hidden/locked layers). Read warnings.

**Working alongside other agents** — one server can serve many agents at once (parallel subagents, several sessions over HTTP). Each agent should create its own project and always pass the id returned by project_create. A name that is already in use (maybe by another agent) is refused with CONFLICT and a suggested free name; continue an existing project only if it is yours (ifExists:"suffix" gives an automatic id such as "hero-2" instead). Projects never block each other; calls on the same project run one at a time. Undo history is per project and shared by everyone editing it.
