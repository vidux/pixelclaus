/**
 * Draws the README gallery by driving the real `pixelclaus mcp` server over stdio: the same tool calls
 * an MCP client such as Claude makes. Build first, then:
 *
 *   npm run showcase -- [outDir=docs/images] [previewDir]
 *
 * previewDir (optional) receives the render views the "agent" looked at while drawing.
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const OUT = resolve(process.argv[2] ?? 'docs/images');
const PREVIEW = process.argv[3] ? resolve(process.argv[3]) : undefined;
const data = mkdtempSync(join(tmpdir(), 'pixelclaus-showcase-'));
mkdirSync(OUT, { recursive: true });
if (PREVIEW) mkdirSync(PREVIEW, { recursive: true });

const client = new Client({ name: 'showcase', version: '1' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [resolve('packages/server/dist/cli.js'), 'mcp', '--data', data],
    stderr: 'inherit',
  }),
);

async function call(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ text: string; images: string[] }> {
  const r = (await client.callTool({ name: tool, arguments: args })) as CallToolResult;
  const text = r.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n');
  if (r.isError) throw new Error(`${tool} failed:\n${text}`);
  const images = r.content.flatMap((c) => (c.type === 'image' ? [c.data] : []));
  return { text, images };
}

/** Save what the agent sees (render views): to the preview folder, or to OUT as `keep` for the README. */
async function look(name: string, args: Record<string, unknown>, keep?: string): Promise<void> {
  const { text, images } = await call('render', args);
  const png = Buffer.from(images[0]!, 'base64');
  if (keep) writeFileSync(join(OUT, keep), png);
  if (!PREVIEW) return;
  writeFileSync(join(PREVIEW, `${name}.png`), png);
  writeFileSync(join(PREVIEW, `${name}.txt`), text);
}

async function lint(project: string): Promise<void> {
  const { text } = await call('analyze', { project, kind: 'lint', frames: 'all' });
  console.log(`--- lint ${project}\n${text}`);
}

/** Export, then move the written files to OUT under stable names (exports add frame/tag/scale suffixes). */
async function exportAs(project: string, names: string[], args: Record<string, unknown>): Promise<void> {
  const staging = mkdtempSync(join(OUT, '.export-')); // same drive as OUT, so rename works
  const { text } = await call('export', { project, outputDir: staging, ...args });
  const files = [...text.matchAll(/^- (.+?) \(/gm)].map((m) => m[1]!);
  if (files.length !== names.length) throw new Error(`expected ${names.length} file(s):\n${text}`);
  files.forEach((f, i) => renameSync(f, join(OUT, names[i]!)));
  rmSync(staging, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------------
// 1. The mascot: Pixel Claus, 32x32, idle bob + blink.
//    Flats only in the grid; the outline op adds the 1 px outline around the whole silhouette.

const CLAUS = [
  '................................',
  '........................WWW.....',
  '.......................WWWWW....',
  '..................RRRRWWWWWw....',
  '..............hhRRRRRRWWWww.....',
  '...........hhhRRRRRRRRRwww......',
  '.........hhRRRRRRRRRRRRr........',
  '........hRRRRRRRRRRRRRRrr.......',
  '.......hRRRRRRRRRRRRRRRRrr......',
  '......hRRRRRRRRRRRRRRRRRRrr.....',
  '......RRRRRRRRRRRRRRRRRRRrr.....',
  '.....WWWWWWWWWWWWWWWWWWWWWWW....',
  '.....WWWWWWWWWWWWWWWWWWWWWww....',
  '.....wwwwwwwwwwwwwwwwwwwwwgg....',
  '.......ssssssssssssssssss.......',
  '.......sssstesssssstesssS.......',
  '.......sssseesssssseesssS.......',
  '.......sscccsssnnssscccsS.......',
  '.......sWWWWWWWnnWWWWWWWS.......',
  '......WWWWWWWWWWWWWWWWWWWW......',
  '.....WWWWWWWWWmmmmWWWWWWWWW.....',
  '.....WWWWWWWWWWWWWWWWWWWWww.....',
  '.....WWWWWWWWWWWWWWWWWWWwww.....',
  '.....wWWWWWWWWWWWWWWWWWwwww.....',
  '......wWWWWWWWWWWWWWWWwwww......',
  '.......wwWWWWWWWWWWWwwww........',
  '........gwwWWWWWWWwwwg..........',
  '.........gwwwWWWWwwwg...........',
  '...........ggwwwwgg.............',
  '.............gggg...............',
  '................................',
  '................................',
];
// prettier-ignore
const CLAUS_LEGEND = { R: 9, r: 8, h: 30, W: 20, w: 21, g: 22, s: 4, S: 5, c: 30, e: 26, t: 20, n: 5, m: 8 };

await call('project_create', {
  name: 'pixel-claus',
  width: 32,
  height: 32,
  palette: 'endesga-32',
  layers: ['Claus'],
  settings: { lightDirection: 'top-left', previewBackground: '#1a1c2c' },
});
await call('draw', {
  project: 'pixel-claus',
  ops: [
    { op: 'grid', rows: CLAUS, legend: CLAUS_LEGEND },
    { op: 'outline', side: 'outside', color: 7 },
  ],
});
await look('claus-composite', { project: 'pixel-claus' }, 'agent-view.png');
await look('claus-value', { project: 'pixel-claus', view: 'value' });

// idle: rest → 1 px bob → rest → blink
await call('frame', { project: 'pixel-claus', action: 'duplicate', frame: 0, count: 3 });
await call('cel', { project: 'pixel-claus', action: 'move', layer: 'Claus', frames: [1], dy: 1 });
await call('draw', {
  project: 'pixel-claus',
  frame: 3,
  ops: [{ op: 'grid', x: 11, y: 15, rows: ['ss~~~~~~ss', 'ee~~~~~~ee'], legend: CLAUS_LEGEND }],
});
await call('frame', {
  project: 'pixel-claus',
  action: 'duration',
  frames: 'all',
  durations: [500, 350, 700, 120],
});
await call('tag', { project: 'pixel-claus', action: 'add', name: 'idle', from: 0, to: 3 });
await look('claus-filmstrip', { project: 'pixel-claus', view: 'filmstrip', tag: 'idle' });
await lint('pixel-claus');

await exportAs('pixel-claus', ['pixel-claus.png'], { format: 'png', frame: 0, scale: 8 });
await exportAs('pixel-claus', ['pixel-claus-idle.gif'], { format: 'gif', tag: 'idle', scale: 6 });

// ---------------------------------------------------------------------------------------------------
// 2. A slime, 16x16: rest → squash → stretch (airborne) → squash, then three palette-swap skins.

const SLIME_LEGEND = { G: 14, h: 13, s: 15, W: 20, e: 26 };
const EMPTY16 = '................';
const SLIME_REST = [
  ...Array(6).fill(EMPTY16),
  '......GGGG......',
  '....GGGGGGGG....',
  '...GhWGGGGGGG...',
  '..GhWGGGGGGGGG..',
  '..GhGeGGGGeGGs..',
  '..GGGeGGGGeGGs..',
  '..GGGGGGGGGGGs..',
  '..sGGGGGGGGGss..',
  '...ssssssssss...',
  EMPTY16,
];
const SLIME_SQUASH = [
  ...Array(8).fill(EMPTY16),
  '.....GGGGGG.....',
  '...GGGGGGGGGG...',
  '..GhWGGGGGGGGG..',
  '.GhGGeGGGGeGGGs.',
  '.GGGGeGGGGeGGGs.',
  '.sGGGGGGGGGGGss.',
  '..ssssssssssss..',
  EMPTY16,
];
const SLIME_STRETCH = [
  EMPTY16,
  '......GGGG......',
  '.....GGGGGG.....',
  '....GhWGGGGG....',
  '....GhWGGGGG....',
  '....GhGGGGGs....',
  '....GeGGGGes....',
  '....GeGGGGes....',
  '....GGGGGGGs....',
  '....sGGGGGss....',
  '.....ssssss.....',
  ...Array(5).fill(EMPTY16),
];

await call('project_create', { name: 'slime', width: 16, height: 16, layers: ['Slime'], frames: 4 });
await call('draw', {
  project: 'slime',
  ops: [SLIME_REST, SLIME_SQUASH, SLIME_STRETCH, SLIME_SQUASH].flatMap((rows, frame) => [
    { op: 'grid', frame, rows, legend: SLIME_LEGEND },
    { op: 'outline', frame, side: 'outside', color: 16 },
  ]),
});
await call('frame', { project: 'slime', action: 'duration', frames: 'all', durations: [320, 90, 240, 110] });
await call('tag', { project: 'slime', action: 'add', name: 'bounce', from: 0, to: 3 });
await look(
  'slime-filmstrip',
  { project: 'slime', view: 'filmstrip', tag: 'bounce', baseline: 15 },
  'agent-filmstrip.png',
);
await lint('slime');

// palette swap: the same indices with the green ramp (indices 13 light … 16 darkest) replaced
const { text: palette } = await call('palette', { project: 'slime', action: 'get' });
const colours = [...palette.matchAll(/\b(\d+)=(#[0-9a-f]{6})/g)].map((m) => m[2]!);
const withGreenRamp = (ramp: string[]) => colours.map((c, i) => (i >= 12 && i <= 15 ? ramp[i - 12]! : c));
await exportAs('slime', ['slime-green.gif', 'slime-blue.gif', 'slime-pink.gif'], {
  format: 'gif',
  tag: 'bounce',
  scale: 8,
  paletteVariants: [
    { name: 'green', palette: 'endesga-32' },
    { name: 'blue', palette: withGreenRamp(['#2ce8f5', '#0099db', '#124e89', '#262b44']) },
    { name: 'pink', palette: withGreenRamp(['#f6757a', '#b55088', '#68386c', '#3e2731']) },
  ],
});

// ---------------------------------------------------------------------------------------------------
// 3. A spinning coin from shape ops (no grids): full → three-quarter → edge → three-quarter.

await call('project_create', { name: 'coin', width: 16, height: 16, layers: ['Coin'], frames: 4 });
const coinFace = (frame: number, w: number) => [
  { op: 'ellipse', frame, x: (16 - w) / 2, y: 2, w, h: 12, fill: 11 },
  { op: 'shade', frame, mode: 'light', light: 'top-left', ramp: 'fire' },
  { op: 'rect', frame, x: 7, y: 5, w: 2, h: 6, fill: 10 },
  { op: 'pixels', frame, color: 12, points: [[7, 5]] },
];
await call('draw', {
  project: 'coin',
  ops: [
    ...coinFace(0, 12),
    ...coinFace(1, 8),
    { op: 'rect', frame: 2, x: 7, y: 2, w: 2, h: 12, fill: 10 },
    { op: 'line', frame: 2, from: [7, 3], to: [7, 12], color: 11 },
    ...coinFace(3, 8),
    // shade "light" is a rough first pass: hand-fix the stray rim pixels lint reported as orphans
    {
      op: 'pixels',
      frame: 0,
      color: 11,
      points: [
        [5, 12],
        [6, 13],
        [12, 5],
        [13, 6],
      ],
    },
    ...[0, 1, 2, 3].map((frame) => ({ op: 'outline', frame, side: 'outside', color: 7 })),
  ],
});
await call('frame', { project: 'coin', action: 'duration', frames: 'all', duration: 110 });
await look('coin-filmstrip', { project: 'coin', view: 'filmstrip', frames: 'all' });
await lint('coin');
await exportAs('coin', ['coin-spin.gif'], { format: 'gif', frames: 'all', scale: 8 });

// ---------------------------------------------------------------------------------------------------
// 4. Item icons, one per frame, exported as a sprite sheet.

const ITEMS_LEGEND = { R: 9, r: 8, h: 30, W: 20, k: 5, K: 6, g: 21, P: 29, p: 28, s: 3, S: 4, e: 26 };
const HEART = [
  EMPTY16,
  EMPTY16,
  EMPTY16,
  '...RRR....RRR...',
  '..RhhRR..RRRRR..',
  '..RhRRRRRRRRRr..',
  '..RRRRRRRRRRRr..',
  '..RRRRRRRRRRrr..',
  '...RRRRRRRRrr...',
  '....RRRRRRrr....',
  '.....RRRRrr.....',
  '......RRrr......',
  '.......Rr.......',
  EMPTY16,
  EMPTY16,
  EMPTY16,
];
const POTION = [
  EMPTY16,
  '......kkkk......',
  '......kkKK......',
  '.......gg.......',
  '.......gg.......',
  '......gggg......',
  '....gggggggg....',
  '...gPPPPPPPPg...',
  '..gPWPPPPPPPpg..',
  '..gPWPPPPPPPpg..',
  '..gPPPPPPPPPpg..',
  '..gPPPPPPPPppg..',
  '...gPPPPPPppg...',
  '....gppppppg....',
  EMPTY16,
  EMPTY16,
];
const MUSHROOM = [
  EMPTY16,
  EMPTY16,
  '......RRRR......',
  '....RRRRRRRR....',
  '...RRWWRRRRRR...',
  '..RRWWWRRRWWRr..',
  '..RRRWRRRRWWRr..',
  '.RRRRRRRRRRRRrr.',
  '.RRWWRRRRRRRrrr.',
  '.rrrrrrrrrrrrrr.',
  '.....ssssss.....',
  '.....sesseS.....',
  '.....sssssS.....',
  '......SSSS......',
  EMPTY16,
  EMPTY16,
];

await call('project_create', { name: 'items', width: 16, height: 16, layers: ['Item'], frames: 3 });
await call('draw', {
  project: 'items',
  ops: [HEART, POTION, MUSHROOM].flatMap((rows, frame) => [
    { op: 'grid', frame, rows, legend: ITEMS_LEGEND },
    { op: 'outline', frame, side: 'outside', color: 7 },
  ]),
});
await look('items-filmstrip', { project: 'items', view: 'filmstrip', frames: 'all' });
await lint('items');
await exportAs('items', ['items.png'], {
  format: 'spritesheet',
  frames: 'all',
  scale: 6,
  sheet: { layout: 'horizontal', padding: 2, json: 'none' },
});

await client.close();
rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
console.log(`wrote ${OUT}`);
