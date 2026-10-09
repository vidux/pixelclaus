/**
 * Multi-agent benchmark against a real `pixelclaus mcp` stdio process: N agents build their own asset
 * concurrently over one connection (as parallel Claude subagents do), while a probe agent keeps making
 * small calls. Reports total time and latency per tool; the probe numbers show whether agents block
 * each other.
 *
 *   npm run bench:agents -- [agents=7] [size=128] [frames=16] [cli=packages/server/dist/cli.js]
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const [n = '7', sz = '128', fr = '16', cliArg] = process.argv.slice(2);
const AGENTS = Number(n);
const SIZE = Number(sz);
const FRAMES = Number(fr);
const CLI = resolve(cliArg ?? 'packages/server/dist/cli.js');

const data = mkdtempSync(join(tmpdir(), 'pixelclaus-bench-'));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [CLI, 'mcp', '--data', data],
  stderr: 'ignore',
});
const client = new Client({ name: 'bench', version: '1' });
await client.connect(transport);

const timings: Record<string, number[]> = {};
async function call(tool: string, args: Record<string, unknown>, bucket = tool): Promise<number> {
  const t0 = performance.now();
  const r = (await client.callTool({ name: tool, arguments: args }, undefined, {
    timeout: 600_000,
  })) as CallToolResult;
  const ms = performance.now() - t0;
  (timings[bucket] ??= []).push(ms);
  if (r.isError) throw new Error(`${tool}: ${JSON.stringify(r.content).slice(0, 300)}`);
  return ms;
}

async function agent(i: number): Promise<void> {
  const p = `asset-${i}`;
  await call('project_create', {
    name: p,
    width: SIZE,
    height: SIZE,
    frames: FRAMES,
    layers: ['Body', 'FX'],
  });
  for (let f = 0; f < FRAMES; f++) {
    await call(
      'draw',
      {
        project: p,
        layer: 'Body',
        frame: f,
        ops: [
          { op: 'ellipse', x: 4 + (f % 4), y: 8, w: SIZE - 16, h: SIZE - 20, fill: 13, color: 15 },
          { op: 'gradient', from: [0, 0], to: [SIZE, SIZE], colors: [12, 13, 14], ink: 'inside' },
          { op: 'outline', color: 26, side: 'inside' },
        ],
        preview: f % 4 === 0,
      },
      f % 4 === 0 ? 'draw+preview' : 'draw',
    );
  }
  await call('render', { project: p, view: 'filmstrip' });
  await call('analyze', { project: p, kind: 'lint' });
  await call('export', { project: p, format: 'gif', scale: 4 });
  await call('export', { project: p, format: 'spritesheet', scale: 2 });
  await call('export', { project: p, format: 'apng', scale: 4 });
}

await call('project_create', { name: 'probe', width: 16, height: 16 });
await call('render', { project: 'probe' }); // warm-up
for (const k of Object.keys(timings)) delete timings[k];

let done = false;
const t0 = performance.now();
const work = Promise.all(Array.from({ length: AGENTS }, (_, i) => agent(i))).finally(() => (done = true));
const probe = (async () => {
  while (!done) {
    await call('project_get', { project: 'probe' }, 'probe:project_get');
    await call(
      'draw',
      { project: 'probe', ops: [{ op: 'pixels', points: [[1, 1]], color: 3 }] },
      'probe:draw',
    );
    await new Promise((r) => setTimeout(r, 25));
  }
})();
await work;
const total = performance.now() - t0;
await probe;
await client.close();
rmSync(data, { recursive: true, force: true });

const pct = (a: number[], q: number) =>
  a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))]!;
console.log(
  `${AGENTS} agents · ${SIZE}x${SIZE} · ${FRAMES} frames · total ${(total / 1000).toFixed(1)} s · ${CLI}`,
);
console.log('tool                 n    p50     p95     max');
for (const [k, v] of Object.entries(timings)) {
  const f = (x: number) => `${x.toFixed(0)}ms`.padStart(7);
  console.log(
    `${k.padEnd(18)} ${String(v.length).padStart(3)} ${f(pct(v, 0.5))} ${f(pct(v, 0.95))} ${f(Math.max(...v))}`,
  );
}
