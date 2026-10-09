/**
 * QA: the built CLI (packages/server/dist/cli.js).
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../helpers.js';

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, PIXELCLAUS_DATA: '', ...env }, timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

describe('CLI', () => {
  it('info --data prints the resolved configuration as JSON', async () => {
    const dir = tempDir();
    const r = await run(['info', '--data', dir]);
    expect(r.code).toBe(0);
    const cfg = JSON.parse(r.stdout);
    expect(cfg.dataDir).toBe(dir);
    expect(cfg.version).toBe('0.1.0');
    expect(cfg).toMatchObject({ host: '127.0.0.1', port: 7420, allowAnyPath: true });
  });

  it('info honours environment variables and --restrict-paths', async () => {
    const dir = tempDir();
    const r = await run(['info', '--restrict-paths'], { PIXELCLAUS_DATA: dir, PIXELCLAUS_PORT: '9999', PIXELCLAUS_CACHE: '3' });
    const cfg = JSON.parse(r.stdout);
    expect(cfg).toMatchObject({ dataDir: dir, port: 9999, cacheSize: 3, allowAnyPath: false });
  });

  it('info is read-only (does not create the data directory)', async () => {
    const dir = join(tempDir(), 'not-yet');
    await run(['info', '--data', dir]);
    expect(existsSync(dir)).toBe(false);
  });

  it('help lists every command and documented flag', async () => {
    const r = await run(['help']);
    expect(r.code).toBe(0);
    for (const s of ['mcp', 'serve', 'info', '--data', '--port', '--no-mcp', 'PIXELCLAUS_DATA']) expect(r.stdout).toContain(s);
    // --restrict-paths is accepted by the CLI but missing from the help text
    expect(r.stdout).toContain('--restrict-paths');
  });

  it('an unknown command fails with a non-zero exit code', async () => {
    const r = await run(['sevre']);
    expect(r.stdout + r.stderr).toMatch(/Usage/);
    expect(r.code).not.toBe(0);
  });

  it('invalid numeric flags are rejected (info --port abc)', async () => {
    const r = await run(['info', '--port', 'abc', '--data', tempDir()]);
    const out = r.code === 0 ? JSON.parse(r.stdout) : null;
    // today prints "port": null (NaN) and exits 0
    expect(r.code !== 0 || Number.isFinite(out.port)).toBe(true);
  });
});
