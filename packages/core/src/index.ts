/**
 * @pixelclaus/core — pure TypeScript pixel-art engine.
 *
 * Layers of the API:
 * - model:   SpriteDocument (state + images + history), createDocument, lookups, colour resolution
 * - ops:     commands that mutate a document inside undoable transactions
 * - render:  compositing, annotated previews and feedback views
 * - analysis: stats, lint, animation metrics
 * - ascii:   lossless text pixel I/O
 */
export * from './errors.js';
export * from './util/geometry.js';

export * from './color/rgba.js';
export * from './color/oklab.js';
export * from './color/hsl.js';
export * from './color/blend.js';

export * from './buffer/pixel-buffer.js';
export * from './buffer/mask.js';
export * from './buffer/raster.js';

export * from './model/types.js';
export * from './model/history.js';
export * from './model/document.js';
export * from './model/create.js';
export * from './model/palette-state.js';
export * from './model/lookup.js';
export * from './model/colors.js';
export * from './model/summary.js';

export * from './palette/presets.js';
export * from './palette/match.js';
export * from './palette/ramps.js';
export * from './palette/quantize.js';

export * from './draw/dither.js';
export * from './draw/shapes.js';
export * from './draw/fill.js';
export * from './draw/gradient.js';
export * from './draw/writer.js';
export * from './draw/target.js';
export * from './draw/effects.js';

export * from './transform/buffer.js';

export * from './ops/draw-types.js';
export * from './ops/points.js';
export * from './ops/draw.js';
export * from './ops/selection.js';
export * from './ops/layers.js';
export * from './ops/frames.js';
export * from './ops/cels.js';
export * from './ops/tags-slices.js';
export * from './ops/palette.js';
export * from './ops/transform.js';
export * from './ops/canvas.js';
export * from './ops/project.js';

export * from './render/font.js';
export * from './render/composite.js';
export * from './render/preview.js';
export * from './render/views.js';

export * from './analysis/metrics.js';
export * from './analysis/lint.js';
export * from './analysis/stats.js';
export * from './analysis/diff.js';

export * from './ascii/grid.js';
export * from './ascii/readback.js';
