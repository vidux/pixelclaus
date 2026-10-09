#!/usr/bin/env node
/**
 * PixelClaus CLI.
 *
 *   pixelclaus mcp   [--data DIR] [--viewer] [--port N]   MCP over stdio (Claude Desktop / Claude Code); optional viewer
 *   pixelclaus serve [--data DIR] [--host H] [--port N] [--no-mcp]   HTTP: viewer + REST API + MCP at /mcp
 *   pixelclaus info                                        print configuration
 *
 * In stdio mode stdout carries the MCP protocol only; logs go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServices } from './app.js';
import { loadConfig, type ServerConfig } from './config.js';
import { createHttpApp } from './http/app.js';
import { createMcpServer, SERVER_VERSION } from './mcp/server.js';

interface Args {
  cmd: string;
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = ['data', 'host', 'port'] as const;
const BOOL_FLAGS = ['viewer', 'no-mcp', 'restrict-paths', 'help'] as const;

/** Strict flag parsing: unknown flags, missing values and stray arguments are usage errors (exit 2). */
function parseArgs(argv: string[]): Args {
  const [cmd = 'help', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const known = [...VALUE_FLAGS, ...BOOL_FLAGS] as readonly string[];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) throw new UsageError(`Unexpected argument '${a}'`);
    const eq = a.indexOf('=');
    const key = a.slice(2, eq > 0 ? eq : undefined);
    if (!known.includes(key)) {
      const close = known.filter((k) => k.startsWith(key.slice(0, 4)) || key.startsWith(k.slice(0, 4)));
      throw new UsageError(`Unknown flag --${key}${close.length ? ` (did you mean --${close[0]}?)` : ''}`);
    }
    if ((VALUE_FLAGS as readonly string[]).includes(key)) {
      const value = eq > 0 ? a.slice(eq + 1) : rest[i + 1];
      if (value === undefined || value === '' || (eq < 0 && value.startsWith('--'))) {
        throw new UsageError(`--${key} needs a value`);
      }
      flags[key] = value;
      if (eq < 0) i++;
    } else {
      if (eq > 0) throw new UsageError(`--${key} does not take a value`);
      flags[key] = true;
    }
  }
  return { cmd, flags };
}

function overrides(flags: Args['flags']): Partial<ServerConfig> {
  const o: Partial<ServerConfig> = {};
  if (typeof flags.data === 'string') o.dataDir = flags.data;
  if (typeof flags.host === 'string') o.host = flags.host;
  if (flags.port !== undefined) {
    const port = Number(flags.port);
    if (typeof flags.port !== 'string' || !Number.isInteger(port) || port < 0 || port > 65535) {
      throw new UsageError(`--port expects an integer 0..65535 (got '${String(flags.port)}')`);
    }
    o.port = port;
  }
  if (flags['restrict-paths']) o.allowAnyPath = false;
  return o;
}

const log = (...m: unknown[]) => console.error('[pixelclaus]', ...m);

class UsageError extends Error {}

const COMMANDS = ['mcp', 'serve', 'info', 'help'];

function usage(): string {
  return `PixelClaus ${SERVER_VERSION}

Usage:
  pixelclaus mcp   [--data DIR] [--viewer] [--port N] [--restrict-paths]   MCP over stdio (+ optional viewer)
  pixelclaus serve [--data DIR] [--host H] [--port N] [--no-mcp]          HTTP: viewer + REST API + MCP at /mcp
  pixelclaus info  [--data DIR] [--port N] [--restrict-paths]             print the resolved configuration
  pixelclaus help

Flags:
  --data DIR          data directory (projects live in DIR/projects; default ~/.pixelclaus)
  --host H            HTTP bind address (default 127.0.0.1)
  --port N            HTTP port (default 7420)
  --viewer            (mcp) also start the viewer over HTTP
  --no-mcp            (serve) do not expose the MCP endpoint
  --restrict-paths    only allow import/export paths inside the data directory (default for serve)

Environment: PIXELCLAUS_DATA, PIXELCLAUS_HOST, PIXELCLAUS_PORT, PIXELCLAUS_ALLOW_ANY_PATH, PIXELCLAUS_CACHE,
             PIXELCLAUS_CACHE_IDLE, PIXELCLAUS_HISTORY, PIXELCLAUS_THREADS
`;
}

async function startHttp(services: Awaited<ReturnType<typeof createServices>>, mcp: boolean): Promise<void> {
  const { app } = createHttpApp(services, { mcp });
  const { host, port } = services.config;
  await new Promise<void>((resolve, reject) => {
    const srv = app.listen(port, host, () => resolve());
    srv.on('error', reject);
  });
  log(`viewer http://${host}:${port}/${mcp ? `  ·  MCP http://${host}:${port}/mcp` : ''}`);
}

async function main(): Promise<void> {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  switch (flags.help ? 'help' : cmd) {
    case 'mcp': {
      const services = await createServices(overrides(flags));
      void services.compute.warm().catch((e: unknown) => log(`compute workers: ${(e as Error).message}`));
      const server = createMcpServer(services);
      await server.connect(new StdioServerTransport());
      log(`MCP stdio server v${SERVER_VERSION} ready · data ${services.config.dataDir}`);
      if (flags.viewer) {
        try {
          await startHttp(services, false);
        } catch (e) {
          log(`viewer not started: ${(e as Error).message}`);
        }
      }
      break;
    }
    case 'serve': {
      const services = await createServices({ allowAnyPath: false, ...overrides(flags) });
      void services.compute.warm().catch((e: unknown) => log(`compute workers: ${(e as Error).message}`));
      await startHttp(services, !flags['no-mcp']);
      log(`data ${services.config.dataDir}`);
      break;
    }
    case 'info': {
      // read-only: resolve the configuration without creating the data directory
      const config = loadConfig(overrides(flags));
      process.stdout.write(JSON.stringify({ version: SERVER_VERSION, ...config }, null, 2) + '\n');
      break;
    }
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(usage());
      break;
    default:
      process.stderr.write(`Unknown command '${cmd}'. Commands: ${COMMANDS.join(', ')}\n\n${usage()}`);
      process.exitCode = 2;
  }
}

main().catch((e) => {
  if (e instanceof UsageError || (e instanceof Error && e.message.startsWith('Invalid '))) {
    log(e.message);
    process.exit(2);
  }
  log(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
