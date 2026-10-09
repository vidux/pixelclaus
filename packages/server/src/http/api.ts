/**
 * REST API consumed by the viewer. All routes are read-only except DELETE project and POST export
 * (which only produces a download; nothing is written to the project).
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Express, NextFunction, Request, Response } from 'express';
import {
  isPixelClausError,
  PixelClausError,
  paletteSummary,
  parseHex,
  resolveLayer,
  summarizeDocument,
  type RenderRequest,
  type ViewMode,
  VIEW_MODES,
} from '@pixelclaus/core';
import type { AppServices } from '../app.js';
import { docPayload } from '../compute/snapshot.js';
import { framesForRender } from '../compute/tasks.js';
import { EXPORT_FORMATS, type ExportRequest } from '../services/export-service.js';
import { validateProjectId } from '../storage/project-store.js';
import { exportRequestSchema } from '../mcp/export-schema.js';

type Handler = (req: Request, res: Response) => Promise<void>;

function wrap(fn: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((e: unknown) => {
      if (isPixelClausError(e)) {
        res.status(e.code === 'NOT_FOUND' ? 404 : 400).json({ error: e.message, hint: e.hint, code: e.code });
      } else next(e);
    });
  };
}

function intParam(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** Parse a frame index from a URL; anything but an existing frame is a 404 with the valid range. */
function frameParam(v: unknown, count: number): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (typeof v !== 'string' || !/^\d+$/.test(v) || n >= count) {
    throw new PixelClausError('NOT_FOUND', `Frame ${String(v)} does not exist`, `Frames are 0..${count - 1}`);
  }
  return n;
}

function sendPng(res: Response, png: Uint8Array): void {
  res.type('png').set('Cache-Control', 'no-cache').send(Buffer.from(png));
}

export function registerApiRoutes(app: Express, s: AppServices): void {
  const { projects, exporter, compute } = s;

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, name: 'pixelclaus', dataDir: s.config.dataDir });
  });

  app.get('/api/formats', (_req, res) => {
    res.json({ export: EXPORT_FORMATS, views: VIEW_MODES });
  });

  app.get(
    '/api/projects',
    wrap(async (_req, res) => {
      res.json(await projects.list());
    }),
  );

  app.get(
    '/api/projects/:id',
    wrap(async (req, res) => {
      const id = validateProjectId(String(req.params.id));
      const checkpoints = await projects.listCheckpoints(id);
      const r = await projects.read(id, (doc) => ({
        ...summarizeDocument(doc),
        paletteColors: paletteSummary(doc.state.palette),
        checkpoints,
      }));
      res.json({ ...r.value, revision: r.revision });
    }),
  );

  app.delete(
    '/api/projects/:id',
    wrap(async (req, res) => {
      const id = await projects.delete(validateProjectId(String(req.params.id)));
      res.json({ deleted: id });
    }),
  );

  app.get(
    '/api/projects/:id/thumbnail.png',
    wrap(async (req, res) => {
      const id = validateProjectId(String(req.params.id));
      try {
        sendPng(res, new Uint8Array(await readFile(projects.store.thumbnailPath(id))));
      } catch {
        const r = await projects.read(id, (doc) => docPayload(doc, { frames: [0] }));
        const out = await compute.run(
          { kind: 'frame', doc: r.value.payload, req: { frame: 0, includeReference: false, fit: 128 } },
          r.value.transfer,
        );
        sendPng(res, out.png);
      }
    }),
  );

  /** Plain frame render: ?scale=4&layers=L1,L2&bg=%23ffffff&hidden=1 */
  app.get(
    '/api/projects/:id/frames/:frame.png',
    wrap(async (req, res) => {
      const id = validateProjectId(String(req.params.id));
      const r = await projects.read(id, (doc) => {
        const frame = frameParam(req.params.frame, doc.state.frames.length)!;
        const layers =
          typeof req.query.layers === 'string' && req.query.layers
            ? req.query.layers.split(',').map((l) => resolveLayer(doc, l).id)
            : undefined;
        return { frame, layers, ...docPayload(doc, { frames: [frame] }) };
      });
      const { frame, layers, payload, transfer } = r.value;
      const bg = typeof req.query.bg === 'string' ? parseHex(req.query.bg) : null;
      const out = await compute.run(
        {
          kind: 'frame',
          doc: payload,
          req: {
            frame,
            layers,
            includeHidden: req.query.hidden === '1',
            background: bg,
            scale: intParam(req.query.scale, 1, 1, 32),
          },
        },
        transfer,
      );
      sendPng(res, out.png);
    }),
  );

  /** Annotated preview view: ?view=composite&frame=0&tag=walk */
  app.get(
    '/api/projects/:id/view.png',
    wrap(async (req, res) => {
      const id = validateProjectId(String(req.params.id));
      const q = req.query.view;
      if (q !== undefined && !(VIEW_MODES as readonly unknown[]).includes(q)) {
        throw new PixelClausError(
          'INVALID_ARGUMENT',
          `Unknown view '${String(q)}'`,
          `Views: ${VIEW_MODES.join(', ')}`,
        );
      }
      const view = (q as ViewMode | undefined) ?? 'composite';
      const r = await projects.read(id, (doc) => {
        const renderReq: RenderRequest = {
          view,
          frame: frameParam(req.query.frame, doc.state.frames.length) ?? 0,
          tag: typeof req.query.tag === 'string' && req.query.tag ? req.query.tag : undefined,
        };
        return { renderReq, ...docPayload(doc, { frames: framesForRender(renderReq) }) };
      });
      const out = await compute.run(
        { kind: 'render', doc: r.value.payload, req: r.value.renderReq },
        r.value.transfer,
      );
      sendPng(res, out.png);
    }),
  );

  app.post(
    '/api/projects/:id/export',
    wrap(async (req, res) => {
      const id = validateProjectId(String(req.params.id));
      // downloads never write to disk: outputDir is ignored rather than rejected
      const { outputDir: _ignored, ...body } = (
        req.body && typeof req.body === 'object' ? req.body : {}
      ) as Record<string, unknown>;
      const parsed = exportRequestSchema.omit({ outputDir: true }).safeParse(body);
      if (!parsed.success) {
        res.status(400).json({
          error: 'Invalid export options',
          issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
          formats: EXPORT_FORMATS,
        });
        return;
      }
      const { preview: _p, ...safeReq } = parsed.data;
      const file = await exporter.download(id, safeReq as ExportRequest);
      res
        .type(file.mime)
        .set('Content-Disposition', `attachment; filename="${file.name.replace(/"/g, '')}"`)
        .send(Buffer.from(file.data));
    }),
  );

  app.get(
    '/api/projects/:id/exports',
    wrap(async (req, res) => {
      const id = validateProjectId(String(req.params.id));
      if (!(await projects.store.exists(id)))
        throw new PixelClausError('NOT_FOUND', `Project '${id}' not found`);
      const dir = projects.store.exportsDir(id);
      const out: Array<{ name: string; bytes: number; modified: string }> = [];
      try {
        for (const f of await readdir(dir)) {
          const st = await stat(join(dir, f));
          if (st.isFile()) out.push({ name: f, bytes: st.size, modified: st.mtime.toISOString() });
        }
      } catch {
        // no exports yet
      }
      res.json(out.sort((a, b) => b.modified.localeCompare(a.modified)));
    }),
  );

  app.get(
    '/api/projects/:id/exports/:file',
    wrap(async (req, res) => {
      const id = validateProjectId(String(req.params.id));
      const name = String(req.params.file);
      if (name.includes('/') || name.includes('\\') || name.startsWith('.')) {
        res.status(400).json({ error: 'bad file name' });
        return;
      }
      const file = join(projects.store.exportsDir(id), name);
      const st = await stat(file).catch(() => null);
      if (!st?.isFile()) {
        res.status(404).json({
          error: `Export '${name}' not found`,
          hint: `GET /api/projects/${id}/exports lists the files`,
        });
        return;
      }
      res.download(file, name);
    }),
  );

  // anything else under /api is a JSON 404 (not the viewer's HTML)
  app.use('/api', (req, res) => {
    res.status(404).json({
      error: `No API route ${req.method} ${req.originalUrl}`,
      hint: 'See GET /api/health and docs/viewer.md',
    });
  });
}

/** Final error handler: JSON instead of HTML stack traces (bad JSON bodies → 400). */
export function jsonErrors(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const e = err as { status?: number; statusCode?: number; type?: string; message?: string };
  const status = e.status ?? e.statusCode ?? 500;
  // never echo raw library messages: they can contain absolute server paths
  const message =
    e.type === 'entity.parse.failed'
      ? 'Malformed JSON body'
      : status >= 500
        ? 'Internal server error'
        : status === 404
          ? 'Not found'
          : status === 413
            ? 'Request body too large'
            : 'Bad request';
  if (status >= 500) console.error('[pixelclaus] request failed:', err);
  // MCP clients expect a JSON-RPC error envelope; REST clients get {error}
  if (req.path.startsWith('/mcp') && status < 500) {
    res.status(status).json({
      jsonrpc: '2.0',
      error: { code: e.type === 'entity.parse.failed' ? -32700 : -32600, message },
      id: null,
    });
    return;
  }
  res.status(status).json({ error: message });
}
