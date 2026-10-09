import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const NODE =
  /from\s+['"](node:[^'"]+|fs|path|os|zlib|crypto|buffer|child_process|http|https|url|util|stream|sharp|express)['"]/;

describe('architecture', () => {
  it('core has no runtime dependencies and no Node APIs', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'core/package.json'), 'utf8'));
    expect(pkg.dependencies ?? {}).toEqual({});
    for (const f of files(join(root, 'core/src'))) {
      const src = readFileSync(f, 'utf8');
      expect(NODE.test(src), f).toBe(false);
      expect(/@pixelclaus\/(formats|server)/.test(src), f).toBe(false);
      expect(/\bprocess\.(env|argv|cwd)|\bBuffer\.(from|alloc)|\brequire\(/.test(src), f).toBe(false);
    }
  });

  it('formats is browser-safe and only depends on core + fflate', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'formats/package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@pixelclaus/core', 'fflate']);
    for (const f of files(join(root, 'formats/src'))) {
      const src = readFileSync(f, 'utf8');
      expect(NODE.test(src), f).toBe(false);
      expect(/@pixelclaus\/server/.test(src), f).toBe(false);
    }
  });

  it('modules stay reasonably small', () => {
    for (const pkg of ['core', 'formats', 'server']) {
      for (const f of files(join(root, `${pkg}/src`))) {
        const lines = readFileSync(f, 'utf8').split('\n').length;
        expect(lines, f).toBeLessThan(700);
      }
    }
  });
});
