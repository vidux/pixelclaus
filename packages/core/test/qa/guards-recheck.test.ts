/**
 * QA recheck (D6 + non-integer inputs): huge or odd numbers must never freeze or crash the engine.
 *
 * Every probe runs in a child process with a hard timeout, so an infinite loop shows up as a failing
 * test instead of hanging the vitest worker.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CORE = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
// run node directly with the tsx loader (cwd = repo root) so SIGKILL hits the busy process itself —
// the tsx CLI wrapper would leave a spinning grandchild behind on timeout
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

interface Probe {
  timedOut: boolean;
  ok?: boolean;
  err?: string;
  ms?: number;
  written?: number;
  notes?: Array<string | undefined>;
  raw: string;
}

/** Run `ops` with draw() on a fresh WxH indexed doc in a child process. */
function probe(ops: unknown[], opts: { w?: number; h?: number; timeoutMs?: number; extra?: string } = {}): Promise<Probe> {
  const dir = mkdtempSync(join(tmpdir(), 'pc-qa-probe-'));
  const script = join(dir, 'probe.mts');
  writeFileSync(join(dir, 'ops.json'), JSON.stringify(ops));
  writeFileSync(
    script,
    `import { readFileSync } from 'node:fs';
import * as core from ${JSON.stringify(pathToFileURL(CORE).href)};
const ops = JSON.parse(readFileSync(${JSON.stringify(join(dir, 'ops.json'))}, 'utf8'));
const doc = core.createDocument({ name: 'p', width: ${opts.w ?? 32}, height: ${opts.h ?? 32}, palette: 'pico-8' });
const t0 = Date.now();
try {
  ${opts.extra ?? "const r = core.draw(doc, { layer: 'Layer 1', ops }); console.log(JSON.stringify({ ok: true, ms: Date.now() - t0, written: r.written, notes: r.results.map((x) => x.note) }));"}
} catch (e) {
  console.log(JSON.stringify({ ok: false, ms: Date.now() - t0, err: String(e && e.message) }));
}
`,
  );
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', script], { cwd: ROOT, timeout: opts.timeoutMs ?? 10000, killSignal: 'SIGKILL', maxBuffer: 1 << 20 }, (err, stdout) => {
      const line = stdout.trim().split('\n').pop() ?? '';
      if (err && (err as { killed?: boolean }).killed) return resolve({ timedOut: true, raw: stdout });
      try {
        resolve({ timedOut: false, raw: stdout, ...JSON.parse(line) });
      } catch {
        resolve({ timedOut: false, ok: false, err: `no result (${String(err)})`, raw: stdout });
      }
    });
  });
}

describe('sanity of the probe harness', () => {
  it('a normal fill completes quickly', async () => {
    const r = await probe([{ op: 'fill', x: 1, y: 2, color: 3 }]);
    expect(r.timedOut).toBe(false);
    expect(r.ok, r.err).toBe(true);
    expect(r.written).toBe(32 * 32);
  }, 20000);
});

describe.concurrent('R1: fractional coordinates for flood fill / magic wand hang the engine', () => {
  // floodRegion() uses the raw seed as a typed-array index: visited[1.5] never sticks → endless stack growth
  it('fill with a fractional seed (x: 1.5) finishes (rounds or rejects) instead of looping forever', async () => {
    const r = await probe([{ op: 'fill', x: 1.5, y: 2, color: 3 }]);
    expect(r.timedOut, 'draw fill {x:1.5} did not return within 10 s').toBe(false);
  }, 20000);

  it('fill with reference:"composite" and a fractional seed finishes', async () => {
    const r = await probe([{ op: 'fill', x: 3, y: 0.25, color: 3, reference: 'composite' }]);
    expect(r.timedOut, 'draw fill {y:0.25, reference:composite} did not return within 10 s').toBe(false);
  }, 20000);

  it('select wand with a fractional seed finishes', async () => {
    const r = await probe([], {
      extra:
        "core.select(doc, { shape: 'wand', x: 2.5, y: 3, name: 'w' }); console.log(JSON.stringify({ ok: true, ms: Date.now() - t0 }));",
    });
    expect(r.timedOut, 'select wand {x:2.5} did not return within 10 s').toBe(false);
  }, 20000);
});

describe.concurrent('R2: guardNumbers only inspects the first 4096 array elements (D6 bypass)', () => {
  it('a path whose 4097th point is at 1e9 is rejected quickly instead of rasterising a 1e9-px line', async () => {
    const points: number[][] = Array.from({ length: 4096 }, (_, i) => [i % 32, 0]);
    points.push([1e9, 1e9]);
    const r = await probe([{ op: 'path', color: 3, points }]);
    expect(r.timedOut, 'path with a huge 4097th point froze the engine (> 10 s)').toBe(false);
    expect(r.ok).toBe(false);
    expect(r.err).toMatch(/out of range/);
  }, 20000);

  it('polygon with a huge vertex after index 4096 is rejected quickly', async () => {
    const points: number[][] = Array.from({ length: 4096 }, (_, i) => [i % 32, (i * 7) % 32]);
    points.push([-5e8, 5e8]);
    const r = await probe([{ op: 'polygon', color: 3, points }]);
    expect(r.timedOut, 'polygon with a huge vertex after index 4096 froze the engine').toBe(false);
    expect(r.ok).toBe(false);
  }, 20000);
});

describe.concurrent('R3: long in-range path/polygon segments crash with a stack overflow (INTERNAL, not actionable)', () => {
  // polylinePoints() does out.push(...seg) with a 131k-element segment → RangeError: Maximum call stack size exceeded
  const cases: Array<[string, unknown]> = [
    ['2-point path corner to corner', { op: 'path', color: 3, points: [[-65536, -65536], [65536, 65536]] }],
    ['closed polygon outline', { op: 'polygon', color: 3, points: [[-65536, -65536], [65536, 65536], [-65536, 65536]] }],
    ['filled polygon covering the canvas', { op: 'polygon', color: 3, fill: 4, points: [[-65536, -65536], [65536, -65536], [65536, 65536], [-65536, 65536]] }],
  ];
  for (const [label, op] of cases) {
    it(`${label}: draws the visible part (or gives a clear error), no stack overflow`, async () => {
      const r = await probe([op]);
      expect(r.timedOut).toBe(false);
      expect(r.err ?? '').not.toMatch(/Maximum call stack/);
    }, 20000);
  }
});

describe('D6 variants that are fixed (regression guards)', () => {
  const quick: Array<[string, unknown]> = [
    ['circle r=65536', { op: 'circle', cx: 16, cy: 16, r: 65536, color: 3, fill: 4 }],
    ['ellipse 65536² off-canvas', { op: 'ellipse', x: -65536, y: -65536, w: 65536, h: 65536, color: 3, fill: 4 }],
    ['rect 65536² with thickness', { op: 'rect', x: -32768, y: -32768, w: 65536, h: 65536, color: 3, thickness: 40000 }],
    ['gradient with far stops and area', { op: 'gradient', from: [-65536, -65536], to: [65536, 65536], colors: [1, 2, 3], area: { x: -65536, y: -65536, w: 65536, h: 65536 } }],
    ['pattern with absurd offsets', { op: 'pattern', pattern: 'checker', colors: [3], offsetX: 1e300, offsetY: -1e300 }],
    ['text with absurd spacing', { op: 'text', x: 0, y: 0, text: 'HELLO', color: 3, spacing: 1e300 }],
    ['stamp shifted far away', { op: 'stamp', from: { area: { x: 0, y: 0, w: 4, h: 4 } }, dx: 65536, dy: -65536 }],
    ['w beyond the guard', { op: 'rect', x: 0, y: 0, w: 100000, h: 2, fill: 3 }],
  ];
  it('each completes in < 1 s (timed inside one child process, fresh document per op)', async () => {
    const r = await probe(quick, {
      timeoutMs: 30000,
      extra: `const out = [];
  for (const [label, op] of ops) {
    const d = core.createDocument({ name: 'q', width: 32, height: 32, palette: 'pico-8' });
    core.draw(d, { layer: 'Layer 1', ops: [{ op: 'rect', x: 0, y: 0, w: 4, h: 4, fill: 3 }] });
    const t1 = Date.now();
    try { core.draw(d, { layer: 'Layer 1', ops: [op] }); out.push([label, Date.now() - t1, '']); }
    catch (e) { out.push([label, Date.now() - t1, String(e && e.message)]); }
  }
  console.log(JSON.stringify({ ok: true, ms: Date.now() - t0, notes: out.map((x) => JSON.stringify(x)) }));`,
    });
    expect(r.timedOut).toBe(false);
    const rows = (r.notes ?? []).map((x) => JSON.parse(x!) as [string, number, string]);
    expect(rows.length).toBe(quick.length);
    for (const [label, ms, err] of rows) {
      expect(ms, label).toBeLessThan(1000);
      expect(err, label).not.toMatch(/Maximum call stack|Cannot read/);
    }
  }, 60000);
});

describe.concurrent('R4: wide-brush lines are not clipped before brush expansion', () => {
  it('a width-32 line across the ±65536 range on a 32x32 canvas finishes in < 1 s', async () => {
    // strokeWithBrush expands all 131k line points by ~800 brush offsets before clipping (~5.5 s here)
    const r = await probe([{ op: 'line', from: [-65536, -65536], to: [65536, 65536], color: 3, width: 32 }], { timeoutMs: 12000 });
    expect(r.timedOut).toBe(false);
    expect(r.ok, r.err).toBe(true);
    expect(r.ms!).toBeLessThan(1000);
  }, 30000);
});
