/**
 * Pixel-art lint: automated checks for common mistakes. Each finding has a rule id, severity, message,
 * optional pixel locations and a fix hint aimed at the agent.
 */
import { N4, N8 } from '../buffer/mask.js';
import type { Raster } from '../buffer/raster.js';
import { deltaEPacked, hueDelta, lightness, packedToOklch } from '../color/oklab.js';
import { parseHex, toHex, type Packed } from '../color/rgba.js';
import type { SpriteDocument } from '../model/document.js';
import { resolveFrames, resolveLayer, resolveTag } from '../model/lookup.js';
import { paletteValues } from '../model/palette-state.js';
import { PaletteMatcher } from '../palette/match.js';
import { compositeFrame } from '../render/composite.js';
import { animationMetrics } from './metrics.js';
import type { Point } from '../util/geometry.js';
import { bandingCheck, lineChecks, pillowCheck } from './lint-shape.js';
import {
  defaultBudget,
  LINT_RULES,
  MAX_PIXELS,
  opaque,
  OPT_IN_RULES,
  sample,
  type LintFinding,
  type LintReport,
  type LintRequest,
  type LintRule,
  type Severity,
} from './lint-types.js';

export * from './lint-types.js';

function frameChecks(
  doc: SpriteDocument,
  r: Raster,
  frame: number,
  rules: Set<LintRule>,
  out: LintFinding[],
): void {
  const W = r.width;
  const H = r.height;
  const pal = paletteValues(doc.state.palette);
  const matcher = new PaletteMatcher(pal);

  if (rules.has('stray-pixels')) {
    const hits: Point[] = [];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (opaque(r, x, y) && N8.every(([dx, dy]) => !opaque(r, x + dx, y + dy))) hits.push({ x, y });
    if (hits.length)
      out.push({
        rule: 'stray-pixels',
        severity: 'warning',
        frame,
        count: hits.length,
        pixels: sample(hits),
        message: `${hits.length} isolated pixel(s) with no opaque neighbour`,
        hint: 'Erase them or connect them to the shape',
      });
  }

  if (rules.has('orphan-pixels')) {
    const hits: Point[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = r.get(x, y);
        if (c === 0) continue;
        if (N4.some(([dx, dy]) => !opaque(r, x + dx, y + dy))) continue; // silhouette edge — usually outline/AA
        if (N8.some(([dx, dy]) => r.get(x + dx, y + dy) === c)) continue;
        hits.push({ x, y });
      }
    }
    if (hits.length) {
      out.push({
        rule: 'orphan-pixels',
        severity: hits.length > 6 ? 'warning' : 'info',
        frame,
        count: hits.length,
        pixels: sample(hits),
        message: `${hits.length} interior pixel(s) whose colour appears in none of the 8 neighbours (noise / pillow artefacts)`,
        hint: 'Keep only deliberate highlights; otherwise merge into a neighbouring colour cluster',
      });
    }
  }

  if (rules.has('doubles') || rules.has('jaggies')) {
    const oc = doc.state.settings.outlineColor;
    lineChecks(r, frame, rules, out, oc !== null ? (pal[oc] ?? null) : null);
  }

  if (rules.has('semi-transparent')) {
    let n = 0;
    const hits: Point[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const a = r.data[(y * W + x) * 4 + 3]!;
        if (a > 0 && a < 255) {
          n++;
          if (hits.length < MAX_PIXELS) hits.push({ x, y });
        }
      }
    }
    if (n)
      out.push({
        rule: 'semi-transparent',
        severity: 'warning',
        frame,
        count: n,
        pixels: hits,
        message: `${n} semi-transparent pixel(s); GIF/indexed exports will threshold them`,
        hint: 'Use fully opaque colours (check layer/cel opacity and palette alpha)',
      });
  }

  if (rules.has('off-palette') && doc.state.colorMode === 'rgba') {
    let n = 0;
    const hits: Point[] = [];
    const colors = new Set<Packed>();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = r.get(x, y);
        if (c !== 0 && (c & 255) === 255 && matcher.exact(c) < 0) {
          n++;
          colors.add(c);
          if (hits.length < MAX_PIXELS) hits.push({ x, y });
        }
      }
    }
    if (n)
      out.push({
        rule: 'off-palette',
        severity: 'warning',
        frame,
        count: n,
        pixels: hits,
        message: `${n} pixel(s) in ${colors.size} colour(s) not in the palette (${[...colors]
          .slice(0, 6)
          .map((c) => toHex(c))
          .join(', ')})`,
        hint: 'Use draw op "quantize" or add the colours to the palette',
      });
  }

  const counts = new Map<Packed, number>();
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = r.get(x, y);
      if (c !== 0) counts.set(c, (counts.get(c) ?? 0) + 1);
    }

  if (rules.has('color-budget')) {
    const budget = doc.state.settings.colorBudget ?? defaultBudget(doc.state.width, doc.state.height);
    if (counts.size > budget) {
      out.push({
        rule: 'color-budget',
        severity: 'warning',
        frame,
        count: counts.size,
        message: `${counts.size} colours used; budget for this size is ${budget}`,
        hint: 'Merge similar shades; reuse ramp colours across materials (set settings.colorBudget to change the target)',
      });
    }
  }

  if (rules.has('rare-colors') && counts.size > 3) {
    const rare = [...counts.entries()].filter(([, n]) => n < 3);
    if (rare.length >= 2)
      out.push({
        rule: 'rare-colors',
        severity: 'info',
        frame,
        count: rare.length,
        message: `${rare.length} colour(s) used on fewer than 3 pixels: ${rare
          .slice(0, 8)
          .map(([c, n]) => `${matcher.exact(c) >= 0 ? matcher.exact(c) : toHex(c)}×${n}`)
          .join(' ')}`,
        hint: 'Rare colours often add noise; replace with an existing neighbour colour unless they are deliberate accents',
      });
  }

  // silhouette edge analysis
  const edge: Point[] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (opaque(r, x, y) && N4.some(([dx, dy]) => !opaque(r, x + dx, y + dy))) edge.push({ x, y });

  if (rules.has('outline-gaps') && doc.state.settings.outlineColor !== null && edge.length) {
    const oc = pal[doc.state.settings.outlineColor] ?? 0;
    const gaps = edge.filter((p) => {
      const c = r.get(p.x, p.y);
      return c !== oc && deltaEPacked(c, oc) > 0.12;
    });
    if (gaps.length)
      out.push({
        rule: 'outline-gaps',
        severity: 'warning',
        frame,
        count: gaps.length,
        pixels: sample(gaps),
        message: `${gaps.length} silhouette-edge pixel(s) are not the outline colour (index ${doc.state.settings.outlineColor})`,
        hint: 'Close the outline (draw op outline) or use selout deliberately',
      });
  }

  if (rules.has('black-outline') && edge.length > 8 && pal.length > 3) {
    const black = edge.filter((p) => r.get(p.x, p.y) >>> 8 === 0).length;
    if (black / edge.length > 0.6)
      out.push({
        rule: 'black-outline',
        severity: 'info',
        frame,
        count: black,
        message: `${Math.round((100 * black) / edge.length)}% of the silhouette edge is pure #000000`,
        hint: 'A dark tinted outline (darkest colour of the dominant ramp) or selout usually reads better',
      });
  }

  if (rules.has('background-contrast') && doc.state.settings.previewBackground && edge.length) {
    const bg = parseHex(doc.state.settings.previewBackground);
    if (bg !== null) {
      const bgL = lightness(bg);
      const close = edge.filter((p) => Math.abs(lightness(r.get(p.x, p.y)) - bgL) < 0.12);
      if (close.length / edge.length > 0.4) {
        out.push({
          rule: 'background-contrast',
          severity: 'warning',
          frame,
          count: close.length,
          pixels: sample(close),
          message: `${Math.round((100 * close.length) / edge.length)}% of the silhouette edge is within ΔL 0.12 of the background ${doc.state.settings.previewBackground}`,
          hint: 'Darken/lighten the outline (or selout) so the sprite separates from the game background',
        });
      }
    }
  }

  if (rules.has('detail-density') && Math.max(W, H) <= 48) {
    let busy = 0;
    let total = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const c = r.get(x, y);
        if (c === 0) continue;
        const nb = N4.map(([dx, dy]) => r.get(x + dx, y + dy)).filter((v) => v !== 0);
        if (nb.length < 4) continue;
        total++;
        if (nb.filter((v) => v !== c).length >= 3) busy++;
      }
    if (total >= 16 && busy / total > 0.35)
      out.push({
        rule: 'detail-density',
        severity: 'info',
        frame,
        count: busy,
        message: `${Math.round((100 * busy) / total)}% of interior pixels differ from 3+ of their neighbours (noisy / over-detailed)`,
        hint: 'At small sizes favour larger flat clusters; judge at the 1x inset',
      });
  }

  if (rules.has('pillow-shading')) pillowCheck(r, frame, out, doc.state.settings.lightDirection);
  if (rules.has('banding')) bandingCheck(r, frame, out);

  if (rules.has('tile-seams') && W > 2 && H > 2) {
    // compare the gradient across the wrap seam with the tile's own interior gradient (adaptive)
    const Lv = (x: number, y: number) => {
      const c = r.get(x, y);
      return c === 0 ? -0.5 : lightness(c);
    };
    let gx = 0;
    let gy = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x + 1 < W; x++) gx += Math.abs(Lv(x + 1, y) - Lv(x, y));
    for (let x = 0; x < W; x++) for (let y = 0; y + 1 < H; y++) gy += Math.abs(Lv(x, y + 1) - Lv(x, y));
    gx /= H * (W - 1);
    gy /= W * (H - 1);
    let sx = 0;
    let sy = 0;
    for (let y = 0; y < H; y++) sx += Math.abs(Lv(0, y) - Lv(W - 1, y));
    for (let x = 0; x < W; x++) sy += Math.abs(Lv(x, 0) - Lv(x, H - 1));
    sx /= H;
    sy /= W;
    const bad = [
      sx > 2 * gx + 0.04 ? `left↔right seam ΔL ${sx.toFixed(2)} vs interior ${gx.toFixed(2)}` : '',
      sy > 2 * gy + 0.04 ? `top↔bottom seam ΔL ${sy.toFixed(2)} vs interior ${gy.toFixed(2)}` : '',
    ].filter(Boolean);
    if (bad.length)
      out.push({
        rule: 'tile-seams',
        severity: 'warning',
        frame,
        count: bad.length,
        message: `Tile edges do not continue across the wrap: ${bad.join('; ')}`,
        hint: 'Check render view "tile" and use transform offset (wrap) to paint across the seam',
      });
  }

  if (rules.has('symmetry')) {
    let mism = 0;
    const hits: Point[] = [];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < Math.floor(W / 2); x++) {
        if (r.get(x, y) !== r.get(W - 1 - x, y)) {
          mism++;
          if (hits.length < MAX_PIXELS) hits.push({ x, y });
        }
      }
    if (mism)
      out.push({
        rule: 'symmetry',
        severity: 'info',
        frame,
        count: mism,
        pixels: hits,
        message: `${mism} pixel pair(s) differ from their horizontal mirror`,
        hint: 'Intentional asymmetry (light direction) is fine; otherwise redraw with draw symmetry {x:true}',
      });
  }
}

function paletteChecks(
  doc: SpriteDocument,
  rasters: Raster[],
  rules: Set<LintRule>,
  out: LintFinding[],
): void {
  const pal = paletteValues(doc.state.palette);
  const used = new Set<number>();
  const matcher = new PaletteMatcher(pal);
  for (const r of rasters)
    for (let i = 0; i < r.data.length; i += 4) {
      if (r.data[i + 3] === 0) continue;
      const c = ((r.data[i]! << 24) | (r.data[i + 1]! << 16) | (r.data[i + 2]! << 8) | r.data[i + 3]!) >>> 0;
      const ix = matcher.exact(c);
      if (ix > 0) used.add(ix);
    }
  if (rules.has('unused-palette')) {
    const unused = pal.map((_, i) => i).filter((i) => i > 0 && !used.has(i));
    if (unused.length && pal.length > 2)
      out.push({
        rule: 'unused-palette',
        severity: 'info',
        count: unused.length,
        message: `${unused.length} palette entr${unused.length === 1 ? 'y is' : 'ies are'} unused: ${unused.slice(0, 32).join(',')}${unused.length > 32 ? '…' : ''}`,
        hint: 'Fine while designing; prune with palette action "remove" before export if you want a tight palette',
      });
  }
  if (rules.has('near-duplicate-colors')) {
    const pairs: string[] = [];
    const list = [...used];
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        if (deltaEPacked(pal[list[i]!]!, pal[list[j]!]!) < 0.03) pairs.push(`${list[i]}≈${list[j]}`);
      }
    if (pairs.length)
      out.push({
        rule: 'near-duplicate-colors',
        severity: 'warning',
        count: pairs.length,
        message: `Nearly identical colours in use: ${pairs.slice(0, 10).join(', ')}`,
        hint: 'Merge them (palette action "remove" with replacement) — viewers cannot tell them apart',
      });
  }
  if (rules.has('ramp-contrast')) {
    const issues: string[] = [];
    for (const ramp of doc.state.palette.ramps) {
      let flatHue = 0;
      let steps = 0;
      for (let k = 1; k < ramp.indices.length; k++) {
        const a = pal[ramp.indices[k - 1]!];
        const b = pal[ramp.indices[k]!];
        if (!a || !b) continue;
        const la = packedToOklch(a);
        const lb = packedToOklch(b);
        if (Math.abs(lb.L - la.L) < 0.05)
          issues.push(
            `${ramp.name}: ${ramp.indices[k - 1]}→${ramp.indices[k]} ΔL ${(lb.L - la.L).toFixed(3)}`,
          );
        if (la.C > 0.04 && lb.C > 0.04) {
          steps++;
          if (Math.abs(hueDelta(la.h, lb.h)) < 3) flatHue++;
        }
      }
      if (steps >= 2 && flatHue === steps)
        issues.push(`${ramp.name}: no hue shift between steps (looks muddy)`);
    }
    if (issues.length)
      out.push({
        rule: 'ramp-contrast',
        severity: 'info',
        count: issues.length,
        message: `Ramp issues: ${issues.slice(0, 8).join('; ')}`,
        hint: 'Adjacent ramp steps want ΔL ≥ 0.08 and some hue shift (shadows cooler, highlights warmer); see palette action "generate_ramp"',
      });
  }
}

/** Identical findings on several frames are reported once with the list of frames. */
function mergeAcrossFrames(findings: LintFinding[]): LintFinding[] {
  const out: LintFinding[] = [];
  const index = new Map<string, LintFinding>();
  for (const f of findings) {
    if (f.frame === undefined) {
      out.push(f);
      continue;
    }
    const key = `${f.rule}|${f.message}|${JSON.stringify(f.pixels ?? [])}`;
    const prev = index.get(key);
    if (prev) {
      prev.frames!.push(f.frame);
      continue;
    }
    const copy: LintFinding = { ...f, frames: [f.frame] };
    index.set(key, copy);
    out.push(copy);
  }
  for (const f of out) if (f.frames && f.frames.length === 1) delete f.frames;
  return out;
}

export function runLint(doc: SpriteDocument, req: LintRequest = {}): LintReport {
  const rules = new Set<LintRule>(
    req.rules?.length ? req.rules : LINT_RULES.filter((r) => !OPT_IN_RULES.includes(r)),
  );
  const layerId = req.layer ? resolveLayer(doc, req.layer).id : null;
  const frames = req.tag
    ? (() => {
        const t = resolveTag(doc.state, req.tag!);
        return Array.from({ length: t.to - t.from + 1 }, (_, i) => t.from + i);
      })()
    : resolveFrames(doc.state, req.frames, 'all');
  const findings: LintFinding[] = [];
  const rasters = frames.map((f) =>
    compositeFrame(doc, { frame: f, isolate: layerId ? [layerId] : undefined, includeReference: false }),
  );
  rasters.forEach((r, i) => frameChecks(doc, r, frames[i]!, rules, findings));
  paletteChecks(doc, rasters, rules, findings);
  if (
    frames.length > 1 &&
    (rules.has('baseline-drift') || rules.has('frame-jitter') || rules.has('size-drift'))
  ) {
    const groups = req.tag ? [req.tag] : doc.state.tags.length ? doc.state.tags.map((t) => t.name) : [null];
    for (const g of groups) {
      const m = animationMetrics(
        doc,
        g
          ? { tag: g, layers: layerId ? [layerId] : undefined }
          : { frames, layers: layerId ? [layerId] : undefined },
      );
      const label = g ? `tag '${g}'` : 'all frames';
      const cyc = !g || /idle|walk|run|cycle|loop|breath|bob|fly|swim/i.test(g);
      if (rules.has('baseline-drift') && cyc && m.summary.baselineRange) {
        const [lo, hi] = m.summary.baselineRange;
        const airborne = /run|jump|hop|fly/i.test(g ?? '');
        const offFrames = m.frames.filter((f) => f.bottom !== null && f.bottom !== hi);
        // runs/jumps legitimately leave the ground for a frame or two (≤ 2 px on ≤ half the frames)
        const tolerated = airborne && hi - lo <= 2 && offFrames.length <= m.frames.length / 2;
        if (hi - lo > 0 && /idle|walk|run/i.test(g ?? 'idle') && !tolerated) {
          const off = offFrames.map((f) => `${f.frame}(${f.bottom})`);
          findings.push({
            rule: 'baseline-drift',
            severity: 'warning',
            count: off.length,
            message: `Lowest opaque row varies ${lo}..${hi} in ${label}: ${off.slice(0, 10).join(', ')}`,
            hint: 'Feet should touch the same row on contact frames; a 1 px bob on passing frames is fine if intended',
          });
        }
      }
      if (rules.has('frame-jitter') && m.summary.centroidXRange && g && /idle|breath/i.test(g)) {
        const [lo, hi] = m.summary.centroidXRange;
        if (hi - lo > 1.5)
          findings.push({
            rule: 'frame-jitter',
            severity: 'warning',
            message: `Horizontal centroid moves ${(hi - lo).toFixed(1)} px in ${label}`,
            hint: 'Idle animations should stay anchored; check for accidental shifts with render view "diff"',
          });
      }
      if (rules.has('size-drift')) {
        const px = m.frames.map((f) => f.pixels).filter((n) => n > 0);
        if (px.length > 1) {
          const sorted = [...px].sort((a, b) => a - b);
          const med = sorted[Math.floor(sorted.length / 2)]!;
          const bad = m.frames.filter((f) => f.pixels > 0 && Math.abs(f.pixels - med) / med > 0.2);
          if (bad.length)
            findings.push({
              rule: 'size-drift',
              severity: 'info',
              count: bad.length,
              message: `Pixel count deviates >20% from the median (${med}) in ${label}: ${bad
                .slice(0, 10)
                .map((f) => `${f.frame}(${f.pixels})`)
                .join(', ')}`,
              hint: 'Large volume changes between frames read as the character growing/shrinking unless they are smears or squash/stretch',
            });
        }
      }
    }
  }
  const merged = mergeAcrossFrames(findings);
  const sev = (s: Severity) => merged.filter((f) => f.severity === s).length;
  return {
    findings: merged,
    checked: { frames, rules: [...rules], layer: layerId },
    summary: { errors: sev('error'), warnings: sev('warning'), infos: sev('info') },
  };
}
