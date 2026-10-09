/**
 * HTTP server: MCP over Streamable HTTP at /mcp, REST API for the viewer at /api, static viewer at /.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  hostHeaderValidation,
  localhostHostValidation,
} from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { AppServices } from '../app.js';
import { createMcpServer } from '../mcp/server.js';
import { jsonErrors, registerApiRoutes } from './api.js';

export interface HttpAppOptions {
  /** Serve the MCP endpoint (default true). */
  mcp?: boolean;
  /** Static viewer directory (default: packages/viewer/dist). */
  viewerDir?: string;
  /** Extra allowed Host header names (when binding to non-loopback hosts). */
  allowedHosts?: string[];
}

export function defaultViewerDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/http → packages/server → packages/viewer/dist ; src/http (tsx) works the same
  return resolve(here, '..', '..', '..', 'viewer', 'dist');
}

export function createHttpApp(
  services: AppServices,
  opts: HttpAppOptions = {},
): { app: Express; close: () => Promise<void> } {
  const app = express();
  app.disable('x-powered-by');
  const host = services.config.host;
  if (opts.allowedHosts?.length) app.use(hostHeaderValidation(opts.allowedHosts));
  else if (['127.0.0.1', 'localhost', '::1'].includes(host)) app.use(localhostHostValidation());
  app.use(express.json({ limit: '64mb' }));

  const sessions = new Map<string, StreamableHTTPServerTransport>();
  if (opts.mcp !== false) {
    app.post('/mcp', async (req: Request, res: Response) => {
      const sid = req.header('mcp-session-id');
      let transport = sid ? sessions.get(sid) : undefined;
      if (!transport) {
        if (sid || !isInitializeRequest(req.body)) {
          res.status(sid ? 404 : 400).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: sid ? 'Unknown session' : 'Missing session; send initialize first',
            },
            id: null,
          });
          return;
        }
        const t = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, t);
          },
        });
        t.onclose = () => {
          if (t.sessionId) sessions.delete(t.sessionId);
        };
        const server = createMcpServer(services);
        await server.connect(t);
        transport = t;
      }
      await transport.handleRequest(req, res, req.body);
    });
    const sessionRequest = async (req: Request, res: Response) => {
      const sid = req.header('mcp-session-id');
      const t = sid ? sessions.get(sid) : undefined;
      if (!t) {
        res.status(sid ? 404 : 400).send('Invalid or missing session');
        return;
      }
      await t.handleRequest(req, res);
    };
    app.get('/mcp', sessionRequest);
    app.delete('/mcp', sessionRequest);
  }

  registerApiRoutes(app, services);

  const viewerDir = opts.viewerDir ?? defaultViewerDir();
  if (existsSync(join(viewerDir, 'index.html'))) {
    app.use(express.static(viewerDir, { index: 'index.html', maxAge: '1h' }));
    app.get(/^\/(?!api|mcp).*/, (_req, res) => res.sendFile(join(viewerDir, 'index.html')));
  } else {
    app.get('/', (_req, res) =>
      res
        .type('html')
        .send(
          '<h1>PixelClaus</h1><p>The viewer is not built yet. Run <code>npm run build</code> in the repository, then reload.</p><p>API: <a href="/api/projects">/api/projects</a></p>',
        ),
    );
  }

  app.use(jsonErrors);
  return {
    app,
    close: async () => {
      for (const t of sessions.values()) await t.close();
      sessions.clear();
    },
  };
}
