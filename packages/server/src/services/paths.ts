import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { PixelClausError } from '@pixelclaus/core';
import { expandHome, type ServerConfig } from '../config.js';

/**
 * Resolve a user-supplied path. Relative paths resolve against `base`. When `allowAnyPath` is off,
 * the result must stay inside the data directory.
 */
export function resolveUserPath(cfg: ServerConfig, p: string, base: string): string {
  const expanded = expandHome(p.trim());
  const full = isAbsolute(expanded) ? resolve(expanded) : resolve(join(base, expanded));
  if (!cfg.allowAnyPath) {
    // real paths: a symlink inside the data directory must not lead outside it
    const rel = relative(realPathDeep(cfg.dataDir), realPathDeep(full));
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new PixelClausError(
        'INVALID_ARGUMENT',
        `Path '${p}' is outside the PixelClaus data directory`,
        `This server only reads/writes inside ${cfg.dataDir} (set PIXELCLAUS_ALLOW_ANY_PATH=1 to allow other locations)`,
      );
    }
  }
  return full;
}

/** realpath of the deepest existing ancestor + the not-yet-existing rest (target folders may not exist yet). */
export function realPathDeep(p: string): string {
  const rest: string[] = [];
  let cur = resolve(p);
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

export function safeFileStem(s: string): string {
  return (
    s
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'export'
  );
}
