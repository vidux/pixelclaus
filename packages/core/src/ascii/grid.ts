/**
 * ASCII pixel grids — the lossless text channel between the agent and the canvas.
 *
 * Syntax (per row):
 * - one character per pixel; whitespace is ignored
 * - `.` = transparent, `~` = leave pixel unchanged
 * - default legend: `0-9 a-z A-Z` (without the ambiguous l o I O) map to palette indices 0..57
 * - `c*n` repeats character c n times (e.g. `.*4k*3`)
 * - `[n]` addresses palette index n directly (for indices ≥ 58)
 * - an optional row prefix like `07|` (as printed by read_pixels) is stripped
 */
import { invalidArg } from '../errors.js';

export const DEFAULT_ALPHABET = '0123456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
/** Extra symbols used by read_pixels for off-palette RGBA colours (never ambiguous with the syntax). */
export const EXTRA_SYMBOLS = '#@$%&+=!^<>{}()/\\:;,\'"`';

/** Characters that cannot be used as legend keys. */
export const RESERVED_CHARS = new Set(['*', '[', ']', '~']);

export const KEEP_CHAR = '~';
export const TRANSPARENT_CHAR = '.';

export type GridCell = { kind: 'keep' } | { kind: 'char'; ch: string } | { kind: 'index'; index: number };

export interface ParsedGrid {
  width: number;
  height: number;
  rows: GridCell[][];
}

/** read_pixels row prefix: digits, '|', then a space ("07| "). */
const ROW_PREFIX = /^\s*-?\d+\s*\|\s/;
/** read_pixels column header line: '|', space, digits only. */
const HEADER_LINE = /^\s*\|\s+\d+\s*$/;

function tokenizeRow(raw: string, rowNo: number, prefixes: boolean): GridCell[] {
  // whitespace separates tokens (so "2*3 3" is three 2s then a 3) and is otherwise ignored
  return (prefixes ? raw.replace(ROW_PREFIX, '') : raw)
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((chunk) => tokenizeChunk(chunk, rowNo));
}

/** Remove emoji/text presentation selectors so "❤️" and "❤" are the same symbol. */
export function stripVariationSelectors(s: string): string {
  return s.replace(/[\uFE0E\uFE0F]/g, '');
}

function tokenizeChunk(chunk: string, rowNo: number): GridCell[] {
  // iterate by code point so emoji / astral legend characters count as one pixel; variation selectors
  // (U+FE0E/U+FE0F, as in "❤️") are presentation hints, not pixels
  const s = Array.from(stripVariationSelectors(chunk));
  const cells: GridCell[] = [];
  let i = 0;
  while (i < s.length) {
    let cell: GridCell;
    const ch = s[i]!;
    if (ch === '[') {
      const end = s.indexOf(']', i);
      if (end < 0) throw invalidArg(`Row ${rowNo}: unterminated '[' at column ${cells.length}`);
      const num = s.slice(i + 1, end).join('');
      if (!/^\d+$/.test(num)) throw invalidArg(`Row ${rowNo}: '[${num}]' is not a palette index`);
      cell = { kind: 'index', index: parseInt(num, 10) };
      i = end + 1;
    } else if (ch === '*') {
      throw invalidArg(`Row ${rowNo}: '*' must follow a pixel character (syntax c*n, e.g. k*5)`);
    } else {
      cell = ch === KEEP_CHAR ? { kind: 'keep' } : { kind: 'char', ch };
      i++;
    }
    if (s[i] === '*') {
      const m = /^\*(\d+)/.exec(s.slice(i, i + 8).join(''));
      if (!m) throw invalidArg(`Row ${rowNo}: '*' must be followed by a count (e.g. k*5)`);
      const n = parseInt(m[1]!, 10);
      if (n > 4096) throw invalidArg(`Row ${rowNo}: run length ${n} too large`);
      for (let k = 0; k < n; k++) cells.push(cell);
      i += m[0].length;
    } else {
      cells.push(cell);
    }
  }
  return cells;
}

/** Normalise rows input (array or newline separated string) and drop blank leading/trailing lines. */
export function splitRows(rows: string | readonly string[]): string[] {
  const list = typeof rows === 'string' ? rows.split(/\r?\n/) : [...rows];
  while (list.length && list[0]!.trim() === '') list.shift();
  while (list.length && list[list.length - 1]!.trim() === '') list.pop();
  return list;
}

/** Parse an ASCII grid. Throws with exact row numbers when row widths differ. */
export function parseGrid(
  rows: string | readonly string[],
  opts: {
    /** "|" is a pixel symbol (legend key): do not strip read_pixels row prefixes/headers. */ literalPipes?: boolean;
  } = {},
): ParsedGrid {
  const prefixes = !opts.literalPipes;
  // header lines printed by read_pixels look like "   | 0123…" (no row number) — skip them
  const list = splitRows(rows).filter((l) => !prefixes || !HEADER_LINE.test(l));
  if (!list.length) throw invalidArg('Grid is empty', 'Provide rows like ["..11..", ".1221."]');
  const parsed = list.map((r, i) => tokenizeRow(r, i, prefixes));
  const width = parsed[0]!.length;
  const bad = parsed.map((r, i) => ({ i, n: r.length })).filter((x) => x.n !== width);
  if (bad.length) {
    const detail = bad
      .slice(0, 8)
      .map((b) => `row ${b.i} has ${b.n}`)
      .join(', ');
    throw invalidArg(
      `Grid rows must all have the same width: row 0 has ${width} pixel(s) but ${detail}`,
      'Count characters per row (whitespace is ignored, c*n expands to n pixels). Pad with "~" to leave pixels unchanged.',
    );
  }
  return { width, height: parsed.length, rows: parsed };
}

/** Default index for a legend character, or undefined. '.' → 0. */
export function defaultCharIndex(ch: string): number | undefined {
  if (ch === TRANSPARENT_CHAR) return 0;
  const i = DEFAULT_ALPHABET.indexOf(ch);
  return i >= 0 ? i : undefined;
}

export function defaultIndexChar(index: number): string | undefined {
  if (index === 0) return TRANSPARENT_CHAR;
  return index < DEFAULT_ALPHABET.length ? DEFAULT_ALPHABET[index] : undefined;
}

export interface SerializeOptions {
  /** Canvas x/y of the top-left cell, used for the header and row numbers. */
  originX?: number;
  originY?: number;
  rowNumbers?: boolean;
  header?: boolean;
  /** Collapse runs ≥ this length to c*n (0 = never). */
  rle?: number;
}

/** Render a grid of characters with optional column header and row prefixes. */
export function formatGrid(chars: string[][], opts: SerializeOptions = {}): string {
  const ox = opts.originX ?? 0;
  const oy = opts.originY ?? 0;
  const h = chars.length;
  const w = h ? chars[0]!.length : 0;
  const rowNumbers = opts.rowNumbers ?? true;
  const pad = rowNumbers ? String(oy + h - 1).length : 0;
  // header lines always start with '| ' so they can never be mistaken for pixel rows
  const lead = ' '.repeat(pad) + '| ';
  const lines: string[] = [];
  if (opts.header ?? true) {
    const maxX = ox + w - 1;
    if (maxX >= 100)
      lines.push(lead + Array.from({ length: w }, (_, i) => Math.floor((ox + i) / 100) % 10).join(''));
    if (maxX >= 10)
      lines.push(lead + Array.from({ length: w }, (_, i) => Math.floor((ox + i) / 10) % 10).join(''));
    lines.push(lead + Array.from({ length: w }, (_, i) => (ox + i) % 10).join(''));
  }
  // [n] tokens make rows variable-width; keep the header honest by only printing it for 1-char cells
  if (chars.some((row) => row.some((c) => c.length > 1))) lines.splice(0, lines.length);
  chars.forEach((row, y) => {
    const prefix = rowNumbers ? `${String(oy + y).padStart(pad, '0')}| ` : '';
    lines.push(prefix + (opts.rle ? rleRow(row, opts.rle) : row.join('')));
  });
  return lines.join('\n');
}

/** Run-length encode a row. A run token is followed by a space so "2*3" + "3" never reads as "2*33". */
function rleRow(row: string[], min: number): string {
  let out = '';
  let i = 0;
  while (i < row.length) {
    let j = i;
    while (j < row.length && row[j] === row[i]) j++;
    const n = j - i;
    out += n >= min ? `${row[i]}*${n} ` : row.slice(i, j).join('');
    i = j;
  }
  return out.trimEnd();
}
