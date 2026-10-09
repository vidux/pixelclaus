# Palettes & colour

- Indexed sprites (default) store palette indices: changing a palette colour recolours every pixel that uses it (palette swap). RGBA sprites store colours; with settings.paletteLock (default true) written colours snap to the palette.
- Unknown hex colours follow settings.missingColor: "snap" (nearest + warning, default), "add" (append to palette), "error".
- palette actions: get · presets · load_preset {name, strategy:"nearest"|"index"} · set {colors} · set_colors [{index,color,name}] · add · remove {indices, replacement} · sort {by} · remap {mapping} · generate_ramp {base, steps, name} (OKLCH hue-shifted) · set_ramps · auto_ramps · adjust {hue,saturation,lightness…} · extract {max} (RGBA → palette).
- Ramps (ordered dark→light index lists) drive shade, selout and "ramp:<name>:<step>" colour refs.
- Name colours (set_colors name) and use names in ops: color:"skin".
- export paletteVariants:[{name, palette}] renders the same sprite with several palettes (skins).

Presets (index in PixelClaus = preset index + 1):
- **pico-8** (16) — PICO-8 fantasy console, 16 colours. Bright, high contrast, great default.
- **sweetie-16** (16) — Sweetie 16 by GrafxKid. Soft, versatile 16-colour palette.
- **db16** (16) — DawnBringer 16. Classic balanced 16-colour palette.
- **db32** (32) — DawnBringer 32. The standard general-purpose 32-colour palette.
- **endesga-32** (32) — Endesga 32. Rich, saturated, very popular for games.
- **resurrect-64** (64) — Resurrect 64 by Kerrie Lake. Large, harmonious 64-colour palette.
- **aap-64** (64) — AAP-64 by Adigun Polack. 64 colours with long natural ramps.
- **apollo** (46) — Apollo by AdamCYounis. 46 colours organised in clean ramps.
- **lospec500** (42) — Lospec 500 collaborative palette, 42 colours.
- **vinik24** (24) — Vinik 24. Muted, painterly 24-colour palette.
- **nes** (55) — NES (2C02) approximate palette, unique colours.
- **c64** (16) — Commodore 64 (Pepto) 16 colours.
- **cga** (16) — IBM CGA full 16-colour palette.
- **zx-spectrum** (15) — ZX Spectrum 15 unique colours (normal + bright).
- **gameboy** (4) — Original Game Boy (DMG) 4 greens, dark → light.
- **kirokaze-gameboy** (4) — Kirokaze Game Boy, 4 colours with a purple shadow.
- **2bit-demichrome** (4) — 2-bit Demichrome, 4 neutral tones.
- **1bit** (2) — Black and white.
- **grayscale-8** (8) — 8 evenly spaced grays.
- **slso8** (8) — SLSO8, 8 colours from deep blue to cream.
- **ammo-8** (8) — Ammo-8, 8 greens.
- **nyx8** (8) — Nyx8, 8 moody colours.
- **oil-6** (6) — Oil 6, 6 soft colours.
- **twilight-5** (5) — Twilight 5, 5 colours.
