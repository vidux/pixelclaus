import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface WriteOptions {
  /** Create missing parent folders (default true). Project files pass false so a project deleted
   * meanwhile (by another session or process) is never recreated by a late write. */
  mkdir?: boolean;
}

/** Write a file atomically: temp file in the same directory, then rename. Returns the new file's stats. */
export async function writeFileAtomic(
  path: string,
  data: Uint8Array | string,
  opts: WriteOptions = {},
): Promise<Stats> {
  if (opts.mkdir !== false) await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, data);
    const st = await stat(tmp); // rename keeps inode, size and mtime
    await renameReplacing(tmp, path);
    return st;
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

// Windows refuses to replace a file while any handle has it open (another agent reading it, antivirus,
// the search indexer). Those handles are short-lived, so retry for up to ~2.5 s like graceful-fs does.
const RENAME_BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);

export async function renameReplacing(from: string, to: string): Promise<void> {
  for (let wait = 5; ; wait *= 2) {
    try {
      return await rename(from, to);
    } catch (e) {
      const busy = process.platform === 'win32' && RENAME_BUSY.has((e as NodeJS.ErrnoException).code ?? '');
      if (!busy || wait > 1280) throw e;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** Create a folder inside an existing one (never its parents); fine if it already exists. */
export async function mkdirIn(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
}

/**
 * Change detector for a file replaced by atomic renames: inode + mtime + size. The inode changes on
 * every rename-replace, so two saves within one timestamp tick are still told apart.
 */
export function stampOf(st: Stats): string {
  return `${st.ino}:${st.mtimeMs}:${st.size}`;
}

export async function fileStamp(path: string): Promise<string | null> {
  try {
    return stampOf(await stat(path));
  } catch {
    return null;
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function mtimeMs(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/** Simple per-key async mutex (serialises mutations of one project). */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => gate);
    this.tails.set(key, tail);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
