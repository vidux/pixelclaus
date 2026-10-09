/**
 * Structure tools: layer, frame, cel, tag, slice, canvas.
 */
import { z } from 'zod';
import {
  addFrames,
  addLayer,
  addTag,
  clearCels,
  copyCel,
  cropCanvas,
  duplicateFrame,
  duplicateLayer,
  flatten,
  invalidArg,
  linkCels,
  mergeDown,
  moveCels,
  moveFrame,
  moveLayer,
  removeFrames,
  removeLayer,
  removeSlice,
  removeTag,
  resizeCanvas,
  resolveFrames,
  reverseFrames,
  scaleSprite,
  setCelOpacity,
  setDurations,
  setFrameNotes,
  setSlice,
  summarizeDocument,
  trimCanvas,
  tweenOffsets,
  unlinkCels,
  updateLayer,
  updateTag,
  type Anchor,
  type BlendMode,
  type FrameSpec,
  type TagDirection,
} from '@pixelclaus/core';
import { MUTATES, type Registrar } from '../context.js';
import { layerTree } from '../format.js';
import { Reply, safe, rect } from '../result.js';
import {
  anchor,
  blendMode,
  frameSpec,
  int,
  layerRef,
  point,
  projectRef,
  rectSchema,
  tagDirection,
} from '../schemas.js';

function need<T>(v: T | undefined, name: string, action: string): T {
  if (v === undefined || v === null) throw invalidArg(`action "${action}" needs "${name}"`);
  return v;
}

export const registerStructureTools: Registrar = (server, ctx) => {
  server.registerTool(
    'layer',
    {
      title: 'Layers',
      description:
        'Layer operations. add {name, type: image|group|reference, parent?, above?|below?|index?} · update {layer, name?, visible?, locked?, opacity 0-255?, blendMode?, continuous?, color?, notes?} · remove {layer} (groups remove children) · move {layer, above?|below?|parent?|index?} (index 0 = bottom among siblings) · duplicate {layer, name?} · merge_down {layer} · flatten {}. Reference layers are visible in previews but never exported.',
      inputSchema: {
        project: projectRef,
        action: z.enum(['add', 'update', 'remove', 'move', 'duplicate', 'merge_down', 'flatten']),
        layer: layerRef.optional(),
        name: z.string().optional(),
        type: z.enum(['image', 'group', 'reference']).optional(),
        parent: z.string().nullable().optional().describe('Group id/name; null = root'),
        above: z.string().optional(),
        below: z.string().optional(),
        index: int.min(0).optional(),
        opacity: int.min(0).max(255).optional(),
        blendMode: blendMode.optional(),
        visible: z.boolean().optional(),
        locked: z.boolean().optional(),
        continuous: z.boolean().optional().describe('New frames link this layer’s cels'),
        color: z.string().optional(),
        notes: z.string().optional(),
      },
      annotations: MUTATES,
    },
    safe(async (a) => {
      const res = await ctx.projects.mutate(a.project, (doc) => {
        const pos = { above: a.above, below: a.below, parent: a.parent, index: a.index };
        let msg: string;
        switch (a.action) {
          case 'add': {
            const l = addLayer(doc, {
              ...pos,
              name: a.name,
              type: a.type,
              opacity: a.opacity,
              blendMode: a.blendMode as BlendMode,
              visible: a.visible,
              locked: a.locked,
              continuous: a.continuous,
              color: a.color,
              notes: a.notes,
            });
            msg = `added ${l.type} layer ${l.id} "${l.name}"`;
            break;
          }
          case 'update': {
            const l = updateLayer(doc, need(a.layer, 'layer', a.action), {
              name: a.name,
              visible: a.visible,
              locked: a.locked,
              opacity: a.opacity,
              blendMode: a.blendMode as BlendMode,
              continuous: a.continuous,
              color: a.color,
              notes: a.notes,
            });
            msg = `updated ${l.id} "${l.name}"`;
            break;
          }
          case 'remove':
            msg = `removed ${removeLayer(doc, need(a.layer, 'layer', a.action)).join(', ')}`;
            break;
          case 'move': {
            const l = moveLayer(doc, need(a.layer, 'layer', a.action), pos);
            msg = `moved ${l.id} "${l.name}"`;
            break;
          }
          case 'duplicate': {
            const l = duplicateLayer(doc, need(a.layer, 'layer', a.action), a.name);
            msg = `duplicated → ${l.id} "${l.name}"`;
            break;
          }
          case 'merge_down': {
            const l = mergeDown(doc, need(a.layer, 'layer', a.action));
            msg = `merged into ${l.id} "${l.name}"`;
            break;
          }
          case 'flatten': {
            const l = flatten(doc, a.name);
            msg = `flattened into ${l.id} "${l.name}"`;
            break;
          }
        }
        return [msg, 'layers (top → bottom):', ...layerTree(summarizeDocument(doc).layers)];
      });
      return new Reply().lines_(res.value).line(`rev ${res.revision}`).warnings(res.warnings).build();
    }),
  );

  server.registerTool(
    'frame',
    {
      title: 'Frames / timeline',
      description:
        'Timeline. add {at?, count?, duration?, cels: empty|copy|link, source?} · duplicate {frame, count?, link?} (copies follow the frame) · remove {frames} · move {frame, to} · reverse {from, to} · duration {frames, duration ms | fps | durations[]} · notes {frame, notes}. Frames are 0-indexed; tags/cels are shifted automatically.',
      inputSchema: {
        project: projectRef,
        action: z.enum(['add', 'duplicate', 'remove', 'move', 'reverse', 'duration', 'notes']),
        at: int.min(0).optional(),
        count: int.min(1).max(500).optional(),
        frame: int.min(0).optional(),
        frames: frameSpec.optional(),
        to: int.min(0).optional(),
        from: int.min(0).optional(),
        cels: z.enum(['empty', 'copy', 'link']).optional(),
        source: int.min(0).optional(),
        link: z.boolean().optional(),
        duration: int.min(1).max(65535).optional(),
        fps: z.number().positive().max(1000).optional(),
        durations: z.array(int.min(1).max(65535)).optional(),
        notes: z.string().optional(),
      },
      annotations: MUTATES,
    },
    safe(async (a) => {
      const res = await ctx.projects.mutate(a.project, (doc) => {
        switch (a.action) {
          case 'add': {
            const fs = addFrames(doc, {
              at: a.at,
              count: a.count,
              duration: a.duration,
              cels: a.cels,
              source: a.source,
            });
            return `added frame(s) ${fs.join(',')}`;
          }
          case 'duplicate': {
            const fs = duplicateFrame(doc, need(a.frame, 'frame', a.action), {
              count: a.count,
              link: a.link,
            });
            return `duplicated frame ${a.frame} → ${fs.join(',')}${a.link ? ' (linked)' : ''}`;
          }
          case 'remove':
            return `removed ${removeFrames(doc, resolveFrames(doc.state, need(a.frames as FrameSpec | undefined, 'frames', a.action)))} frame(s)`;
          case 'move':
            moveFrame(doc, need(a.frame, 'frame', a.action), need(a.to, 'to', a.action));
            return `moved frame ${a.frame} → ${a.to}`;
          case 'reverse':
            reverseFrames(doc, need(a.from, 'from', a.action), need(a.to, 'to', a.action));
            return `reversed frames ${a.from}..${a.to}`;
          case 'duration': {
            const fs = resolveFrames(
              doc.state,
              (a.frames as FrameSpec | undefined) ?? (a.frame !== undefined ? a.frame : 'all'),
              'all',
            );
            setDurations(doc, fs, { duration: a.duration, fps: a.fps, durations: a.durations });
            return `durations: ${doc.state.frames.map((f, i) => `${i}:${f.duration}`).join(' ')}`;
          }
          case 'notes':
            setFrameNotes(doc, need(a.frame, 'frame', a.action), a.notes ?? '');
            return `notes set on frame ${a.frame}`;
        }
      });
      const total = await ctx.projects.read(
        a.project,
        (d) =>
          `${d.state.frames.length} frame(s), tags: ${d.state.tags.map((t) => `${t.name} ${t.from}-${t.to}`).join(' · ') || 'none'}`,
      );
      return new Reply()
        .line(`${res.value} · ${total.value} · rev ${res.revision}`)
        .warnings(res.warnings)
        .build();
    }),
  );

  server.registerTool(
    'cel',
    {
      title: 'Cels',
      description:
        'A cel is a layer’s image at one frame. link {layer, frames} (share one image) · unlink {layer, frames} · clear {layer, frames} (delete cel) · move {layer, frames, x?,y? | dx?,dy?} (offset whole cel — cheap motion) · opacity {layer, frames, opacity} · copy {layer, frame, toLayer?, toFrame, link?} · tween {layer, from, to, ease?} (interpolate offsets between two cels).',
      inputSchema: {
        project: projectRef,
        action: z.enum(['link', 'unlink', 'clear', 'move', 'opacity', 'copy', 'tween']),
        layer: layerRef,
        frames: frameSpec.optional(),
        frame: int.min(0).optional(),
        x: int.optional(),
        y: int.optional(),
        dx: int.optional(),
        dy: int.optional(),
        opacity: int.min(0).max(255).optional(),
        toLayer: layerRef.optional(),
        toFrame: int.min(0).optional(),
        link: z.boolean().optional(),
        from: int.min(0).optional(),
        to: int.min(0).optional(),
        ease: z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out']).optional(),
      },
      annotations: MUTATES,
    },
    safe(async (a) => {
      const res = await ctx.projects.mutate(a.project, (doc) => {
        const fs = () =>
          resolveFrames(
            doc.state,
            (a.frames as FrameSpec | undefined) ?? (a.frame !== undefined ? a.frame : undefined),
            'first',
          );
        switch (a.action) {
          case 'link':
            return `linked ${linkCels(doc, a.layer, fs())} cel(s)`;
          case 'unlink':
            return `unlinked ${unlinkCels(doc, a.layer, fs())} cel(s)`;
          case 'clear':
            return `cleared ${clearCels(doc, a.layer, fs())} cel(s)`;
          case 'move':
            return `moved ${moveCels(doc, a.layer, fs(), { x: a.x, y: a.y, dx: a.dx, dy: a.dy })} cel(s)`;
          case 'opacity':
            return `opacity set on ${setCelOpacity(doc, a.layer, fs(), need(a.opacity, 'opacity', a.action))} cel(s)`;
          case 'copy':
            copyCel(
              doc,
              { layer: a.layer, frame: need(a.frame, 'frame', a.action) },
              { layer: a.toLayer ?? a.layer, frame: need(a.toFrame, 'toFrame', a.action) },
              a.link,
            );
            return `copied ${a.layer}@${a.frame} → ${a.toLayer ?? a.layer}@${a.toFrame}${a.link ? ' (linked)' : ''}`;
          case 'tween':
            return `tweened ${tweenOffsets(doc, a.layer, need(a.from, 'from', a.action), need(a.to, 'to', a.action), a.ease)} in-between frame(s)`;
        }
      });
      return new Reply().line(`${res.value} · rev ${res.revision}`).warnings(res.warnings).build();
    }),
  );

  server.registerTool(
    'tag',
    {
      title: 'Animation tags',
      description:
        'Named frame ranges. add {name, from, to, direction?: forward|reverse|pingpong|pingpong_reverse, repeat? (0 = loop)} · update {name, newName?, from?, to?, direction?, repeat?, color?} · remove {name} · list.',
      inputSchema: {
        project: projectRef,
        action: z.enum(['add', 'update', 'remove', 'list']),
        name: z.string().optional(),
        newName: z.string().optional(),
        from: int.min(0).optional(),
        to: int.min(0).optional(),
        direction: tagDirection.optional(),
        repeat: int.min(0).optional(),
        color: z.string().optional(),
        notes: z.string().optional(),
      },
      annotations: MUTATES,
    },
    safe(async (a) => {
      if (a.action === 'list') {
        const r = await ctx.projects.read(a.project, (d) => d.state.tags);
        return new Reply()
          .line(
            r.value.length
              ? r.value
                  .map(
                    (t) => `- ${t.name} ${t.from}-${t.to} ${t.direction}${t.repeat ? ` ×${t.repeat}` : ''}`,
                  )
                  .join('\n')
              : 'no tags',
          )
          .build();
      }
      const res = await ctx.projects.mutate(a.project, (doc) => {
        const name = need(a.name, 'name', a.action);
        if (a.action === 'add') {
          const t = addTag(doc, {
            name,
            from: need(a.from, 'from', a.action),
            to: need(a.to, 'to', a.action),
            direction: a.direction as TagDirection,
            repeat: a.repeat,
            color: a.color,
            notes: a.notes,
          });
          return `added tag ${t.name} ${t.from}-${t.to} ${t.direction}`;
        }
        if (a.action === 'update') {
          const t = updateTag(doc, name, {
            newName: a.newName,
            from: a.from,
            to: a.to,
            direction: a.direction as TagDirection,
            repeat: a.repeat,
            color: a.color,
            notes: a.notes,
          });
          return `updated tag ${t.name} ${t.from}-${t.to} ${t.direction}`;
        }
        removeTag(doc, name);
        return `removed tag ${name}`;
      });
      return new Reply().line(`${res.value} · rev ${res.revision}`).warnings(res.warnings).build();
    }),
  );

  server.registerTool(
    'slice',
    {
      title: 'Slices',
      description:
        'Named regions for engines: hitboxes, 9-patch UI (center relative to bounds) and pivots (relative to bounds). set {name, bounds, center?, pivot?, frame? (key applies from this frame on), color?} · remove {name} · list.',
      inputSchema: {
        project: projectRef,
        action: z.enum(['set', 'remove', 'list']),
        name: z.string().optional(),
        bounds: rectSchema.optional(),
        center: rectSchema.optional(),
        pivot: point.optional(),
        frame: int.min(0).optional(),
        color: z.string().optional(),
        notes: z.string().optional(),
      },
      annotations: MUTATES,
    },
    safe(async (a) => {
      if (a.action === 'list') {
        const r = await ctx.projects.read(a.project, (d) => d.state.slices);
        return new Reply()
          .line(
            r.value.length
              ? r.value
                  .map(
                    (s) =>
                      `- ${s.name}: ${s.keys.map((k) => `f${k.frame} ${rect(k.bounds)}${k.center ? ` center ${rect(k.center)}` : ''}${k.pivot ? ` pivot ${k.pivot.x},${k.pivot.y}` : ''}`).join(' | ')}`,
                  )
                  .join('\n')
              : 'no slices',
          )
          .build();
      }
      const res = await ctx.projects.mutate(a.project, (doc) => {
        const name = need(a.name, 'name', a.action);
        if (a.action === 'remove') {
          removeSlice(doc, name);
          return `removed slice ${name}`;
        }
        const pv = a.pivot
          ? Array.isArray(a.pivot)
            ? { x: a.pivot[0], y: a.pivot[1] }
            : (a.pivot as { x: number; y: number })
          : undefined;
        const s = setSlice(doc, {
          name,
          bounds: need(a.bounds, 'bounds', a.action),
          center: a.center,
          pivot: pv,
          frame: a.frame,
          color: a.color,
          notes: a.notes,
        });
        return `slice ${s.name}: ${s.keys.length} key(s)`;
      });
      return new Reply().line(`${res.value} · rev ${res.revision}`).warnings(res.warnings).build();
    }),
  );

  server.registerTool(
    'canvas',
    {
      title: 'Canvas size',
      description:
        'resize {width, height, anchor?} (anchor: where existing art stays; default center) · crop {rect} · trim {padding?} (to content bounds over all frames) · scale {factor | width/height, method?: nearest|scale2x|scale3x} (whole sprite, prefer integer factors).',
      inputSchema: {
        project: projectRef,
        action: z.enum(['resize', 'crop', 'trim', 'scale']),
        width: int.min(1).max(4096).optional(),
        height: int.min(1).max(4096).optional(),
        anchor: anchor.optional(),
        rect: rectSchema.optional(),
        padding: int.min(0).optional(),
        factor: z.number().positive().optional(),
        method: z.enum(['nearest', 'scale2x', 'scale3x']).optional(),
      },
      annotations: MUTATES,
    },
    safe(async (a) => {
      const res = await ctx.projects.mutate(a.project, (doc) => {
        switch (a.action) {
          case 'resize':
            resizeCanvas(
              doc,
              need(a.width, 'width', a.action),
              need(a.height, 'height', a.action),
              (a.anchor ?? 'center') as Anchor,
            );
            break;
          case 'crop':
            cropCanvas(doc, need(a.rect, 'rect', a.action));
            break;
          case 'trim': {
            const r = trimCanvas(doc, a.padding ?? 0);
            return `trimmed to ${r.w}x${r.h} (content was at ${r.x},${r.y}; everything shifted by ${-r.x},${-r.y})`;
          }
          case 'scale':
            scaleSprite(doc, { factor: a.factor, width: a.width, height: a.height, method: a.method });
            break;
        }
        return `canvas now ${doc.state.width}x${doc.state.height}`;
      });
      return new Reply().line(`${res.value} · rev ${res.revision}`).warnings(res.warnings).build();
    }),
  );
};
