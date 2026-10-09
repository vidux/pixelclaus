import { parseHex, toHex, toHex8, type Packed } from '../color/rgba.js';
import { invalidArg, PixelClausError } from '../errors.js';
import { PaletteMatcher } from '../palette/match.js';
import type { SpriteDocument, Transaction } from './document.js';
import { paletteValues } from './palette-state.js';
import { MAX_PALETTE } from './types.js';

/**
 * A colour as accepted by every tool:
 * - palette index: `5`, `"5"`
 * - hex: `"#f80"`, `"#ff8800"`, `"#ff880080"`
 * - `"transparent"` (also `"none"`, `"clear"`)
 * - a palette colour name: `"skin"`
 * - a ramp step: `"ramp:skin:2"` (0 = darkest; negative counts from the lightest end)
 */
export type ColorInput = number | string;

const TRANSPARENT_WORDS = new Set(['transparent', 'none', 'clear', 'erase', 'empty']);

/** Converts colour inputs to pixel values for a document (palette indices or packed RGBA). */
export class ColorResolver {
  private readonly doc: SpriteDocument;
  private readonly tx: Transaction | undefined;
  private values: Packed[];
  private matcher: PaletteMatcher;

  constructor(doc: SpriteDocument, tx?: Transaction) {
    this.doc = doc;
    this.tx = tx;
    this.values = paletteValues(doc.state.palette);
    this.matcher = new PaletteMatcher(this.values);
  }

  get palette(): readonly Packed[] {
    return this.values;
  }

  get paletteMatcher(): PaletteMatcher {
    return this.matcher;
  }

  /** Pixel value → RGBA colour. */
  rgba(value: number): Packed {
    if (this.doc.state.colorMode === 'indexed') return value === 0 ? 0 : (this.values[value] ?? 0);
    return value >>> 0;
  }

  /** Pixel value → palette index (exact) or -1 (RGBA mode, off-palette). */
  indexOf(value: number): number {
    if (this.doc.state.colorMode === 'indexed') return value;
    return this.matcher.exact(value);
  }

  /** Convert an RGBA colour into a pixel value honouring palette policy. */
  fromRgba(c: Packed, label?: string): number {
    if (c === 0) return 0;
    const indexed = this.doc.state.colorMode === 'indexed';
    const ex = this.matcher.exact(c);
    if (ex > 0) return indexed ? ex : c;
    if (!indexed && !this.doc.state.settings.paletteLock) return c;
    const policy = this.doc.state.settings.missingColor;
    if (policy === 'error') {
      throw new PixelClausError(
        'INVALID_ARGUMENT',
        `Colour ${toHex(c)} is not in the palette`,
        'Use a palette index, add the colour with palette action "add", or set settings.missingColor to "snap"/"add"',
      );
    }
    if (policy === 'add' && this.tx && this.values.length < MAX_PALETTE) {
      this.tx.state.palette.colors.push(toHex8(c));
      this.values = paletteValues(this.doc.state.palette);
      this.matcher = new PaletteMatcher(this.values);
      const idx = this.values.length - 1;
      this.tx.warn(`Added ${toHex(c)} to the palette as index ${idx}`);
      return indexed ? idx : c;
    }
    const n = this.matcher.nearest(c);
    if (label !== undefined) {
      this.doc.addWarning(
        `Colour ${label} is not in the palette; snapped to index ${n} (${toHex(this.values[n] ?? 0)})`,
      );
    }
    return indexed ? n : (this.values[n] ?? 0);
  }

  /** Resolve a colour input to a pixel value. */
  resolve(input: ColorInput): number {
    const idx = this.indexFromInput(input);
    if (idx !== null) return this.doc.state.colorMode === 'indexed' ? idx : (this.values[idx] ?? 0);
    const s = String(input).trim();
    const hex = parseHex(s);
    if (hex === null || !/^#|^[0-9a-f]{6}$|^[0-9a-f]{8}$/i.test(s)) {
      throw invalidArg(
        `Unknown colour '${s}'`,
        `Use a palette index (0-${this.values.length - 1}), a hex like "#ff8800", "transparent", a palette colour name${this.namesHint()}, or "ramp:<name>:<step>"`,
      );
    }
    return this.fromRgba(hex, s);
  }

  /** Resolve to a palette index if the input addresses the palette directly, else null. */
  indexFromInput(input: ColorInput): number | null {
    if (typeof input === 'number') return this.checkIndex(input);
    const s = input.trim();
    if (TRANSPARENT_WORDS.has(s.toLowerCase())) return 0;
    if (/^\d+$/.test(s)) return this.checkIndex(parseInt(s, 10));
    if (/^ramp:/i.test(s)) return this.rampStep(s);
    const named = this.byName(s);
    if (named !== null) return named;
    return null;
  }

  private checkIndex(i: number): number {
    if (!Number.isInteger(i) || i < 0 || i >= this.values.length) {
      throw invalidArg(
        `Palette index ${i} out of range`,
        `This palette has indices 0..${this.values.length - 1} (0 = transparent)`,
      );
    }
    return i;
  }

  private byName(s: string): number | null {
    const names = this.doc.state.palette.names;
    const lower = s.toLowerCase();
    for (const [k, v] of Object.entries(names)) if (v.toLowerCase() === lower) return parseInt(k, 10);
    return null;
  }

  private namesHint(): string {
    const n = Object.values(this.doc.state.palette.names);
    return n.length ? ` (${n.slice(0, 12).join(', ')})` : '';
  }

  private rampStep(s: string): number {
    const m = /^ramp:([^:]+):(-?\d+)$/i.exec(s);
    if (!m)
      throw invalidArg(
        `Bad ramp reference '${s}'`,
        'Format: ramp:<name>:<step>, e.g. ramp:skin:2 (0 = darkest)',
      );
    const ramps = this.doc.state.palette.ramps;
    const r = ramps.find((x) => x.name.toLowerCase() === m[1]!.toLowerCase());
    if (!r)
      throw invalidArg(
        `Unknown ramp '${m[1]}'`,
        `Ramps: ${ramps.map((x) => x.name).join(', ') || 'none (use palette action auto_ramps)'}`,
      );
    let step = parseInt(m[2]!, 10);
    if (step < 0) step = r.indices.length + step;
    if (step < 0 || step >= r.indices.length)
      throw invalidArg(`Ramp '${r.name}' has steps 0..${r.indices.length - 1}`);
    return r.indices[step]!;
  }

  /** Human-readable description of a pixel value. */
  describe(value: number): string {
    if (value === 0) return 'transparent';
    if (this.doc.state.colorMode === 'indexed') return `${value} (${toHex(this.values[value] ?? 0)})`;
    const i = this.matcher.exact(value);
    return i > 0 ? `${toHex(value)} [${i}]` : toHex(value);
  }
}
