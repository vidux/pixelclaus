/**
 * QA recheck: CLI flag parsing (packages/server/dist/cli.js). A mistyped security flag must not be
 * silently ignored.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../helpers.js';

const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, PIXELCLAUS_DATA: '' }, timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

describe('CLI flags', () => {
  it('--restrict-paths and --data still work (regression guard)', async () => {
    const dir = tempDir();
    const r = await run(['info', '--data', dir, '--restrict-paths']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ dataDir: dir, allowAnyPath: false });
  });

  it('R20: a mistyped flag (--restrict-path) is rejected instead of silently leaving paths unrestricted', async () => {
    const r = await run(['info', '--restrict-path']);
    expect(r.code, r.stdout).toBe(2);
  });

  it('R20: --data without a value is rejected instead of silently using ~/.pixelclaus', async () => {
    const r = await run(['info', '--data']);
    expect(r.code, r.stdout).toBe(2);
  });

  it('R20: --port=8123 (equals form) is honoured or rejected, not ignored', async () => {
    const r = await run(['info', '--port=8123']);
    const ok = r.code === 2 || (r.code === 0 && JSON.parse(r.stdout).port === 8123);
    expect(ok, r.stdout).toBe(true);
  });
});
