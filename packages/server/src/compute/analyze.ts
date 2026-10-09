/**
 * Analysis text for the `analyze` tool: stats, colours, lint, animation metrics and frame diffs, formatted
 * as compact lines. Runs on a compute worker.
 */
import {
  animationMetrics,
  diffFrames,
  invalidArg,
  paletteReport,
  runLint,
  spriteStats,
  type FrameSpec,
  type LintRule,
  type SpriteDocument,
} from '@pixelclaus/core';

export interface AnalyzeRequest {
  kind: 'stats' | 'colors' | 'lint' | 'animation' | 'diff';
  rules?: string[];
  frames?: FrameSpec;
  tag?: string;
  layer?: string;
  layers?: string[];
  frameA?: number;
  frameB?: number;
}

function rect(r: { x: number; y: number; w: number; h: number } | null | undefined): string {
  return r ? `${r.x},${r.y} ${r.w}x${r.h}` : 'none';
}

export function analyzeLines(doc: SpriteDocument, req: AnalyzeRequest): string[] {
  const lines: string[] = [];
  switch (req.kind) {
    case 'stats': {
      const s = spriteStats(doc);
      lines.push(
        `${s.size} ${s.colorMode} · ${s.frames} frame(s) · content bounds ${rect(s.bounds)} · ${s.colorsUsed} colour(s) used`,
      );
      for (const l of s.layers)
        lines.push(
          `- ${l.id} "${l.path}": ${l.cels} cel(s)${l.linkedCels ? ` (${l.linkedCels} linked)` : ''}, ${l.pixels} px, bounds ${rect(l.bounds)}`,
        );
      lines.push(
        `usage (all frames): ${s.usage
          .slice(0, 48)
          .map((u) => `${u.index >= 0 ? u.index : u.color}×${u.count}`)
          .join(' ')}`,
      );
      break;
    }
    case 'colors': {
      const p = paletteReport(doc);
      lines.push(`palette "${p.name}" ${p.size} colours · unused: ${p.unused.join(',') || 'none'}`);
      lines.push(
        `used: ${p.entries
          .filter((e) => e.used)
          .map((e) => `${e.index}=${e.hex} L${e.L} ×${e.used}`)
          .join(' · ')}`,
      );
      if (p.nearDuplicates.length)
        lines.push(
          `near-duplicates (ΔE<0.03): ${p.nearDuplicates.map(([i, j, d]) => `${i}≈${j} (${d})`).join(' ')}`,
        );
      for (const rp of p.ramps)
        lines.push(`ramp ${rp.name}: ${rp.indices.map((i, k) => `${i}(L${rp.lightness[k]})`).join(' → ')}`);
      break;
    }
    case 'lint': {
      const rep = runLint(doc, {
        rules: req.rules as LintRule[] | undefined,
        frames: req.frames as FrameSpec | undefined,
        tag: req.tag,
        layer: req.layer,
      });
      lines.push(
        `lint: ${rep.summary.warnings} warning(s), ${rep.summary.infos} info · frames ${rep.checked.frames.join(',')}${rep.checked.layer ? ` · layer ${rep.checked.layer}` : ' · composite'}`,
      );
      if (!rep.findings.length) lines.push('no findings — clean');
      for (const f of rep.findings) {
        const px = f.pixels?.length ? ` at ${f.pixels.map((p) => `(${p.x},${p.y})`).join(' ')}` : '';
        lines.push(
          `- [${f.severity}] ${f.rule}${f.frame !== undefined ? ` f${f.frame}` : ''}: ${f.message}${px}${f.hint ? `\n  hint: ${f.hint}` : ''}`,
        );
      }
      break;
    }
    case 'animation': {
      const m = animationMetrics(doc, {
        frames: req.frames as FrameSpec | undefined,
        tag: req.tag,
        layers: req.layers,
      });
      lines.push(
        `${m.frames.length} frame(s) in playback order · total ${m.totalDuration}ms · bottom row range ${m.summary.baselineRange?.join('..') ?? '-'} · centroid x ${m.summary.centroidXRange?.join('..') ?? '-'} y ${m.summary.centroidYRange?.join('..') ?? '-'} · pixels ${m.summary.pixelRange.join('..')}`,
      );
      lines.push('frame | ms | bbox | pixels | centroid | bottom | changed-vs-prev');
      for (const f of m.frames)
        lines.push(
          `${f.frame} | ${f.duration} | ${rect(f.bbox)} | ${f.pixels} | ${f.centroid ? `${f.centroid.x},${f.centroid.y}` : '-'} | ${f.bottom ?? '-'} | ${f.changed ?? '-'}`,
        );
      lines.push('(first row "changed" compares with the last frame = loop seam)');
      break;
    }
    case 'diff': {
      if (req.frameA === undefined || req.frameB === undefined)
        throw invalidArg('diff needs frameA and frameB');
      const d = diffFrames(doc, req.frameA, req.frameB, { layers: req.layers });
      lines.push(
        `frames ${req.frameA} → ${req.frameB}: ${d.changed} px differ (+${d.added} added, -${d.removed} removed, ~${d.recoloured} recoloured) · bbox ${rect(d.bbox)}`,
      );
      if (d.changed) {
        const s = d.bestShift;
        lines.push(
          s.dx || s.dy
            ? `best fit: B ≈ A shifted by (${s.dx},${s.dy}) with ${s.residual} px left over (vs ${d.unshiftedResidual} unshifted)`
            : `no whole-image shift explains the change better than none (${d.unshiftedResidual} px)`,
        );
      }
      if (d.map) {
        lines.push(
          `change map from x=${d.mapOrigin!.x} ('.' empty, 'o' same, '+' added, '-' removed, '~' recoloured):`,
        );
        lines.push(d.map);
      }
      break;
    }
  }
  return lines;
}
