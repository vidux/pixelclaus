/**
 * Palette file formats: .hex (Lospec), .gpl (GIMP), .pal (JASC), .act (Adobe).
 */
import { invalidArg } from '@pixelclaus/core';
import { utf8Decode, utf8Encode } from './bytes.js';

export type PaletteFormat = 'hex' | 'gpl' | 'pal' | 'act';

export interface PaletteFile {
  name: string;
  /** '#rrggbb' colours (transparent entry not included). */
  colors: string[];
  names?: Array<string | undefined>;
  /** ACT transparency index (0-based into `colors`) when the file declares one. */
  transparentIndex?: number;
}

const h2 = (n: number) => n.toString(16).padStart(2, '0');
const toHex = (r: number, g: number, b: number) => `#${h2(r)}${h2(g)}${h2(b)}`;
function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function writePalette(p: PaletteFile, format: PaletteFormat): Uint8Array {
  switch (format) {
    case 'hex':
      return utf8Encode(p.colors.map((c) => c.replace('#', '').slice(0, 6)).join('\n') + '\n');
    case 'gpl': {
      const lines = ['GIMP Palette', `Name: ${p.name}`, 'Columns: 16', '#'];
      p.colors.forEach((c, i) => {
        const [r, g, b] = rgb(c);
        const name = p.names?.[i];
        lines.push(
          `${String(r).padStart(3)} ${String(g).padStart(3)} ${String(b).padStart(3)}${name ? `\t${name}` : ''}`,
        );
      });
      return utf8Encode(lines.join('\n') + '\n');
    }
    case 'pal': {
      const lines = ['JASC-PAL', '0100', String(p.colors.length), ...p.colors.map((c) => rgb(c).join(' '))];
      return utf8Encode(lines.join('\r\n') + '\r\n');
    }
    case 'act': {
      const out = new Uint8Array(772);
      p.colors.slice(0, 256).forEach((c, i) => out.set(rgb(c), i * 3));
      const n = Math.min(256, p.colors.length);
      out[768] = n >> 8;
      out[769] = n & 255;
      out[770] = 0xff;
      out[771] = 0xff;
      return out;
    }
  }
}

export function detectPaletteFormat(bytes: Uint8Array, filename = ''): PaletteFormat {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'act') return 'act';
  const head = utf8Decode(bytes.subarray(0, 16));
  if (head.startsWith('GIMP Palette')) return 'gpl';
  if (head.startsWith('JASC-PAL')) return 'pal';
  if (ext === 'hex' || ext === 'txt' || ext === 'gpl' || ext === 'pal') return 'hex';
  // binary 768/772-byte files without a known extension are Adobe colour tables
  const textual = [...bytes.subarray(0, 64)].every(
    (b) =>
      b === 10 ||
      b === 13 ||
      b === 35 ||
      (b >= 48 && b <= 57) ||
      (b >= 65 && b <= 70) ||
      (b >= 97 && b <= 102),
  );
  if (!textual && (bytes.length === 768 || bytes.length === 772)) return 'act';
  return 'hex';
}

/** Read a palette file; throws INVALID_ARGUMENT when it holds no colours (never returns an empty palette). */
export function readPalette(bytes: Uint8Array, filename = 'palette'): PaletteFile {
  const p = parsePalette(bytes, filename);
  if (!p.colors.length) {
    throw invalidArg(
      `No colours found in '${filename}'`,
      'Supported: .hex (one rrggbb per line), .gpl (GIMP Palette), .pal (JASC-PAL text; binary RIFF .pal is not supported), .act (Adobe)',
    );
  }
  return p;
}

function parsePalette(bytes: Uint8Array, filename: string): PaletteFile {
  const format = detectPaletteFormat(bytes, filename);
  const name =
    filename
      .replace(/\.[^.]+$/, '')
      .split(/[\\/]/)
      .pop() || 'palette';
  if (format === 'act') {
    const available = Math.min(256, Math.floor(bytes.length / 3));
    // 772-byte files carry a big-endian count (0 = 256) and a transparency index (0xffff = none)
    const declared = bytes.length >= 772 ? (bytes[768]! << 8) | bytes[769]! : 0;
    const n = Math.min(available, declared || 256);
    const colors: string[] = [];
    for (let i = 0; i < n; i++) colors.push(toHex(bytes[i * 3]!, bytes[i * 3 + 1]!, bytes[i * 3 + 2]!));
    const ti = bytes.length >= 772 ? (bytes[770]! << 8) | bytes[771]! : 0xffff;
    return ti < n ? { name, colors, transparentIndex: ti } : { name, colors };
  }
  const text = utf8Decode(bytes);
  const lines = text.split(/\r?\n/);
  if (format === 'gpl') {
    const colors: string[] = [];
    const names: Array<string | undefined> = [];
    let pname = name;
    for (const line of lines.slice(1)) {
      const t = line.trim();
      if (t.startsWith('Name:')) pname = t.slice(5).trim();
      if (!t || t.startsWith('#') || /^(Name|Columns):/.test(t)) continue;
      const m = /^(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/.exec(t);
      if (m) {
        colors.push(toHex(+m[1]!, +m[2]!, +m[3]!));
        names.push(m[4] || undefined);
      }
    }
    return { name: pname, colors, names };
  }
  if (format === 'pal') {
    const n = parseInt(lines[2] ?? '0', 10);
    const colors = lines.slice(3, 3 + n).map((l) => {
      const [r, g, b] = l.trim().split(/\s+/).map(Number);
      return toHex(r ?? 0, g ?? 0, b ?? 0);
    });
    return { name, colors };
  }
  const colors = lines
    .map((l) => l.trim().replace(/^#/, ''))
    .filter((l) => /^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(l))
    .map((l) => `#${l.slice(0, 6).toLowerCase()}`);
  return { name, colors };
}
