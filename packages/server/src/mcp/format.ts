/**
 * Human/agent-readable summaries of documents.
 */
import {
  paletteSummary,
  summarizeDocument,
  type DocumentSummary,
  type LayerSummary,
  type SpriteDocument,
} from '@pixelclaus/core';
import type { CheckpointInfo } from '../storage/project-store.js';

function ranges(nums: readonly number[]): string {
  if (!nums.length) return '-';
  const out: string[] = [];
  let a = nums[0]!;
  let b = a;
  for (const n of nums.slice(1)) {
    if (n === b + 1) b = n;
    else {
      out.push(a === b ? `${a}` : `${a}-${b}`);
      a = b = n;
    }
  }
  out.push(a === b ? `${a}` : `${a}-${b}`);
  return out.join(',');
}

/** Layer tree, top → bottom (like an editor's layer panel). */
export function layerTree(layers: readonly LayerSummary[]): string[] {
  const byParent = new Map<string | null, LayerSummary[]>();
  for (const l of layers) byParent.set(l.parentId, [...(byParent.get(l.parentId) ?? []), l]);
  const out: string[] = [];
  const rec = (pid: string | null, depth: number) => {
    const kids = [...(byParent.get(pid) ?? [])].reverse();
    for (const l of kids) {
      const flags = [
        l.type !== 'image' ? l.type : '',
        l.visible ? '' : 'hidden',
        l.locked ? 'locked' : '',
        l.isBackground ? 'background' : '',
        l.continuous ? 'continuous' : '',
        l.opacity !== 255 ? `opacity ${l.opacity}` : '',
        l.blendMode !== 'normal' ? l.blendMode : '',
      ].filter(Boolean);
      const cels =
        l.type === 'group'
          ? ''
          : ` cels ${ranges(l.celFrames)}${l.links.length ? ` linked ${l.links.map((g) => `[${ranges(g)}]`).join('')}` : ''}`;
      out.push(
        `${'  '.repeat(depth)}- ${l.id} "${l.name}"${flags.length ? ` (${flags.join(', ')})` : ''}${cels}`,
      );
      if (l.type === 'group') rec(l.id, depth + 1);
    }
  };
  rec(null, 0);
  return out;
}

function durationsLine(d: readonly number[]): string {
  if (d.every((x) => x === d[0])) return `${d.length} × ${d[0]}ms`;
  return d.map((x, i) => `${i}:${x}`).join(' ');
}

export function overviewLines(
  doc: SpriteDocument,
  opts: { palette?: boolean; checkpoints?: CheckpointInfo[]; revision?: number } = {},
): string[] {
  const s: DocumentSummary = summarizeDocument(doc);
  const lines: string[] = [];
  lines.push(
    `project "${s.name}" id=${s.id} ${s.width}x${s.height} ${s.colorMode} · frames ${s.frameCount} (${s.totalDuration}ms) · rev ${opts.revision ?? s.revision}`,
  );
  lines.push(`durations: ${durationsLine(s.durations)}`);
  lines.push('layers (top → bottom):');
  lines.push(...(layerTree(s.layers).length ? layerTree(s.layers) : ['  (none)']));
  if (s.tags.length)
    lines.push(
      `tags: ${s.tags.map((t) => `${t.name} ${t.from}-${t.to} ${t.direction}${t.repeat ? ` ×${t.repeat}` : ''}`).join(' · ')}`,
    );
  if (s.slices.length) lines.push(`slices: ${s.slices.map((x) => x.name).join(', ')}`);
  lines.push(
    `palette: ${s.palette.name} (${s.palette.size} colours + transparent 0)${s.palette.ramps.length ? ` ramps ${s.palette.ramps.join(' ')}` : ''}`,
  );
  if (opts.palette) {
    lines.push(
      'colours: ' +
        paletteSummary(doc.state.palette)
          .slice(1)
          .map((c) => `${c.index}=${c.hex}${c.name ? `(${c.name})` : ''}`)
          .join(' '),
    );
  }
  if (s.selections.length) lines.push(`selections: ${s.selections.join(', ')}`);
  if (s.clipboards.length) lines.push(`clipboards: ${s.clipboards.join(', ')}`);
  const st = s.settings;
  lines.push(
    `settings: light ${st.lightDirection} · paletteLock ${st.paletteLock} · missingColor ${st.missingColor}${st.previewBackground ? ` · previewBackground ${st.previewBackground}` : ''}${st.colorBudget ? ` · colorBudget ${st.colorBudget}` : ''}${st.outlineColor !== null ? ` · outlineColor ${st.outlineColor}` : ''}`,
  );
  lines.push(
    `history: ${s.history.undo} undo / ${s.history.redo} redo${s.history.last ? ` (last: ${s.history.last})` : ''}`,
  );
  if (opts.checkpoints?.length)
    lines.push(`checkpoints: ${opts.checkpoints.map((c) => `"${c.name}"`).join(', ')}`);
  if (s.notes) lines.push(`notes: ${s.notes}`);
  return lines;
}
