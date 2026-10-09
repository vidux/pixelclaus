# Lint rules (analyze kind:"lint")

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

Identical findings on several frames are merged (frames:[…]). Findings include up to 24 pixel coordinates and a hint. Not every finding is a bug — deliberate highlights and accents are fine — but stray pixels, doubles and drift usually are. Pass rules:[…] to run a subset.
