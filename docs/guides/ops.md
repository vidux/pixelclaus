# draw ops cheat sheet

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
Coordinates, sizes, frames and counts are whole numbers (15.5 is rejected — round it yourself) within ±65536. Shapes may extend past the canvas; only the visible part is drawn. An op that changes no pixels is reported with a note.
