/**
 * Project tools: create, list, get, update, delete, duplicate, history, checkpoint, guide.
 */
import { z } from 'zod';
import { convertColorMode, invalidArg, presetNames, slugify, updateProject } from '@pixelclaus/core';
import { DESTRUCTIVE, MUTATES, READ_ONLY, type Registrar } from '../context.js';
import { overviewLines } from '../format.js';
import { GUIDE, GUIDE_TOPICS } from '../guide.js';
import { Reply, safe } from '../result.js';
import { color, int, lightDirection, projectRef, rectSchema } from '../schemas.js';

const settingsSchema = z
  .object({
    paletteLock: z.boolean().optional().describe('RGBA sprites: snap written colours to the palette'),
    missingColor: z
      .enum(['snap', 'add', 'error'])
      .optional()
      .describe('What happens with colours not in the palette'),
    lightDirection: lightDirection.optional(),
    previewBackground: z
      .string()
      .nullable()
      .optional()
      .describe('"#rrggbb" backdrop for previews (null = checkerboard)'),
    colorBudget: int.positive().nullable().optional(),
    outlineColor: int.positive().nullable().optional().describe('Palette index of the outline colour'),
  })
  .describe('Sprite settings');

export const registerProjectTools: Registrar = (server, ctx) => {
  server.registerTool(
    'guide',
    {
      title: 'PixelClaus guide',
      description: `Read usage guidance. Topics: ${GUIDE_TOPICS.join(', ')}. Start with "overview"; "ascii" before writing grids; "sprite"/"animation"/"tileset" for workflows.`,
      inputSchema: { topic: z.enum(GUIDE_TOPICS as [string, ...string[]]).optional() },
      annotations: READ_ONLY,
    },
    safe(async ({ topic }) => new Reply().line(GUIDE[topic ?? 'overview']!).build()),
  );

  server.registerTool(
    'project_create',
    {
      title: 'Create project',
      description:
        'Create a sprite project. Defaults: indexed colour, palette "endesga-32", one layer "Layer 1", one 100ms frame. palette = preset name or list of hex colours (index 1..n; 0 is always transparent). background adds an opaque bottom "Background" layer. Returns the overview (layer ids, palette). ' +
        'Names are unique: if the name (or its id) is already used — maybe by another agent — this fails with CONFLICT unless ifExists:"suffix" (then the id gets a suffix such as hero-2; use the returned id in every call).',
      inputSchema: {
        name: z.string().min(1),
        width: int.min(1).max(4096),
        height: int.min(1).max(4096),
        colorMode: z.enum(['indexed', 'rgba']).optional(),
        palette: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(`Preset (${presetNames().join(', ')}) or hex list`),
        background: color.optional(),
        layers: z
          .array(z.string())
          .optional()
          .describe('Image layer names bottom → top (default ["Layer 1"])'),
        frames: int.min(1).max(2000).optional(),
        frameDuration: int.min(1).max(65535).optional().describe('ms (default 100)'),
        settings: settingsSchema.optional(),
        notes: z.string().optional(),
        ifExists: z
          .enum(['error', 'suffix'])
          .optional()
          .describe('Name already used: "error" (default) or "suffix" (new id like hero-2)'),
      },
      annotations: MUTATES,
    },
    safe(async ({ ifExists, ...a }) => {
      const { id, doc } = await ctx.projects.create(
        { ...a, background: a.background ?? undefined, settings: a.settings as never },
        { ifExists: ifExists ?? 'error' },
      );
      const reply = new Reply().line(`created ${id}`);
      if (id !== slugify(a.name)) {
        // another project (maybe another agent's) already uses this name/id: make the id unmissable
        reply.line(
          `NOTE: '${slugify(a.name)}' was taken, so this project's id is '${id}'. Pass project: "${id}" in every call — the name alone may refer to another project.`,
        );
      }
      return reply
        .lines_(overviewLines(doc, { palette: true, revision: 1 }))
        .warnings(doc.drainWarnings())
        .build();
    }),
  );

  server.registerTool(
    'project_list',
    {
      title: 'List projects',
      description: 'List all projects (newest first): id, name, size, frames, layers, tags.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    safe(async () => {
      const list = await ctx.projects.list();
      if (!list.length) return new Reply().line('no projects yet — create one with project_create').build();
      const r = new Reply().line(`${list.length} project(s):`);
      for (const p of list)
        r.line(
          `- ${p.id} "${p.name}" ${p.width}x${p.height} ${p.colorMode} · ${p.frames} frame(s) · ${p.layers} layer(s)${p.tags.length ? ` · tags ${p.tags.join(',')}` : ''} · modified ${p.modified.slice(0, 16)}`,
        );
      return r.build();
    }),
  );

  server.registerTool(
    'project_get',
    {
      title: 'Project overview',
      description:
        'Structure of a project: size, layers (top → bottom, ids, flags, cel frames, linked cels), frame durations, tags, slices, palette, selections, settings, history, checkpoints. Set palette:true to list every palette colour.',
      inputSchema: { project: projectRef, palette: z.boolean().optional() },
      annotations: READ_ONLY,
    },
    safe(async ({ project, palette }) => {
      const cps = await ctx.projects.listCheckpoints(project);
      const res = await ctx.projects.read(project, (doc) => doc);
      return new Reply()
        .lines_(overviewLines(res.value, { palette, checkpoints: cps, revision: res.revision }))
        .warnings(res.notices)
        .build();
    }),
  );

  server.registerTool(
    'project_update',
    {
      title: 'Update project',
      description:
        'Rename, edit notes/settings/grid/pixel ratio, or convert colour mode (colorMode + dither; indexed→rgba is lossless, rgba→indexed maps to nearest palette colours).',
      inputSchema: {
        project: projectRef,
        name: z.string().optional(),
        notes: z.string().optional(),
        settings: settingsSchema.optional(),
        grid: rectSchema.optional().describe('Editor grid (x/y offset, w/h cell size)'),
        pixelRatio: z.object({ x: int.min(1), y: int.min(1) }).optional(),
        colorMode: z.enum(['indexed', 'rgba']).optional(),
        dither: z.enum(['none', 'bayer2', 'bayer4', 'bayer8', 'floyd-steinberg']).optional(),
      },
      annotations: MUTATES,
    },
    safe(async (a) => {
      const res = await ctx.projects.mutate(a.project, (doc) => {
        updateProject(doc, {
          name: a.name,
          notes: a.notes,
          settings: a.settings as never,
          grid: a.grid,
          pixelRatio: a.pixelRatio,
        });
        const changed = a.colorMode ? convertColorMode(doc, a.colorMode, a.dither) : 0;
        return { changed, doc, lines: [] as string[] };
      });
      res.value.lines = overviewLines(res.value.doc, { revision: res.revision });
      return new Reply()
        .line(
          `updated · rev ${res.revision}${a.colorMode ? ` · ${res.value.changed} pixel value(s) converted` : ''}`,
        )
        .lines_(res.value.lines)
        .warnings(res.warnings)
        .build();
    }),
  );

  server.registerTool(
    'project_delete',
    {
      title: 'Delete project',
      description:
        'Permanently delete a project folder (including checkpoints and exports). Requires confirm:true.',
      inputSchema: { project: projectRef, confirm: z.literal(true) },
      annotations: DESTRUCTIVE,
    },
    safe(async ({ project }) => new Reply().line(`deleted ${await ctx.projects.delete(project)}`).build()),
  );

  server.registerTool(
    'project_duplicate',
    {
      title: 'Duplicate project',
      description: 'Copy a project (current state, no history) under a new name.',
      inputSchema: { project: projectRef, name: z.string().optional() },
      annotations: MUTATES,
    },
    safe(async ({ project, name }) => {
      const { id, doc } = await ctx.projects.duplicate(project, name);
      return new Reply().line(`duplicated → ${id} "${doc.state.name}"`).build();
    }),
  );

  server.registerTool(
    'history',
    {
      title: 'Undo / redo',
      description:
        'undo or redo N steps (each draw/structure call is one step), or list recent steps. History lives in server memory and is shared by every session editing the same project (undo can revert another client’s step — check list first); it resets when the server restarts or the files change on disk. Use checkpoint for durable restore points.',
      inputSchema: {
        project: projectRef,
        action: z.enum(['undo', 'redo', 'list']),
        steps: int.min(1).max(100).optional(),
      },
      annotations: MUTATES,
    },
    safe(async ({ project, action, steps }) => {
      if (action === 'list') {
        const res = await ctx.projects.read(project, (doc) => ({
          undo: doc.history.listUndo(15),
          redo: doc.history.listRedo(15),
        }));
        const r = new Reply().line(
          `undo stack (newest first): ${res.value.undo.map((e) => e.label).join(' | ') || '(empty)'}`,
        );
        return r
          .line(`redo stack: ${res.value.redo.map((e) => e.label).join(' | ') || '(empty)'}`)
          .warnings(res.notices)
          .build();
      }
      const res = await ctx.projects.history(project, action, steps ?? 1);
      if (!res.value.length) return new Reply().line(`nothing to ${action}`).warnings(res.warnings).build();
      return new Reply()
        .line(`${action === 'undo' ? 'undid' : 'redid'}: ${res.value.join(' | ')} · rev ${res.revision}`)
        .warnings(res.warnings)
        .build();
    }),
  );

  server.registerTool(
    'checkpoint',
    {
      title: 'Checkpoints',
      description:
        'Durable named snapshots stored with the project. create before risky edits; restore brings the whole project back (an automatic backup checkpoint is made first; undo history is cleared).',
      inputSchema: {
        project: projectRef,
        action: z.enum(['create', 'list', 'restore', 'delete']),
        name: z.string().optional().describe('Checkpoint name (create) or name/id (restore, delete)'),
      },
      annotations: MUTATES,
    },
    safe(async ({ project, action, name }) => {
      switch (action) {
        case 'create': {
          const cp = await ctx.projects.createCheckpoint(project, name);
          return new Reply()
            .line(`checkpoint "${cp.name}" (${cp.id}) saved at rev ${cp.revision}, ${cp.bytes} bytes`)
            .build();
        }
        case 'list': {
          const list = await ctx.projects.listCheckpoints(project);
          if (!list.length) return new Reply().line('no checkpoints').build();
          return new Reply()
            .lines_(list.map((c) => `- "${c.name}" ${c.id} rev ${c.revision} ${c.created.slice(0, 19)}`))
            .build();
        }
        case 'restore': {
          if (!name) throw invalidArg('restore needs name');
          const r = await ctx.projects.restoreCheckpoint(project, name);
          return new Reply()
            .line(`restored "${r.restored.name}"; previous state saved as "${r.backup.name}"`)
            .build();
        }
        case 'delete': {
          if (!name) throw invalidArg('delete needs name');
          const cp = await ctx.projects.deleteCheckpoint(project, name);
          return new Reply().line(`deleted checkpoint "${cp.name}"`).build();
        }
      }
    }),
  );
};
