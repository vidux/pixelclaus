import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { defaultPoolSize } from './compute/size.js';

export interface ServerConfig {
  /** Root data directory (projects live in `<dataDir>/projects`). */
  dataDir: string;
  /** Allow reading/writing files outside `dataDir` (import/export paths). */
  allowAnyPath: boolean;
  host: string;
  port: number;
  /** Max projects kept in memory. */
  cacheSize: number;
  /** Undo history entries per project. */
  historyEntries: number;
  /**
   * Projects idle at least this long may be unloaded once more than `cacheSize` are open (unloading
   * clears undo history). Busy and recently used projects always stay in memory.
   */
  cacheIdleSeconds: number;
  /** Compute worker threads for previews, exports and analysis (0 = run on the main thread). */
  computeThreads: number;
}

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function num(
  v: string | number | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  if (v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`Invalid ${name} '${v}': expected an integer ${min}..${max}`);
  return n;
}

export function loadConfig(
  overrides: Partial<ServerConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const dataDir = resolve(
    expandHome(overrides.dataDir ?? env.PIXELCLAUS_DATA ?? join(homedir(), '.pixelclaus')),
  );
  return {
    dataDir,
    allowAnyPath: overrides.allowAnyPath ?? bool(env.PIXELCLAUS_ALLOW_ANY_PATH, true),
    host: overrides.host ?? env.PIXELCLAUS_HOST ?? '127.0.0.1',
    port: num(overrides.port ?? env.PIXELCLAUS_PORT, 7420, 'port', 0, 65535),
    cacheSize: num(overrides.cacheSize ?? env.PIXELCLAUS_CACHE, 32, 'cache size', 1, 10000),
    cacheIdleSeconds: num(
      overrides.cacheIdleSeconds ?? env.PIXELCLAUS_CACHE_IDLE,
      600,
      'cache idle seconds',
      0,
      604800,
    ),
    computeThreads: num(
      overrides.computeThreads ?? env.PIXELCLAUS_THREADS,
      defaultPoolSize(),
      'compute threads',
      0,
      64,
    ),
    historyEntries: num(overrides.historyEntries ?? env.PIXELCLAUS_HISTORY, 300, 'history size', 1, 100000),
  };
}

export function projectsDir(cfg: ServerConfig): string {
  return join(cfg.dataDir, 'projects');
}

export { expandHome, isAbsolute };
