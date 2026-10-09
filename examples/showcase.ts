/**
 * Draws the README gallery by driving the real `pixelclaus mcp` server over stdio: the same tool calls
 * an MCP client such as Claude makes. Build first, then:
 *
 *   npm run showcase -- [outDir=docs/images] [previewDir]
 *
 * previewDir (optional) receives the render views the "agent" looked at while drawing.
 */
import { resolve } from 'node:path';
import { connect } from './lib/mcp.js';
import {
  coinOps,
  HEART,
  ITEMS_LEGEND,
  MUSHROOM,
  POTION,
  ROBOT,
  ROBOT_BLINK,
  ROBOT_GLOW,
  ROBOT_LEGEND,
  SLIME_LEGEND,
  SLIME_REST,
  SLIME_SQUASH,
  SLIME_STRETCH,
} from './lib/sprites.js';

const OUT = resolve(process.argv[2] ?? 'docs/images');
const PREVIEW = process.argv[3] ? resolve(process.argv[3]) : undefined;
const { call, look, lint, exportAs, close } = await connect('showcase', OUT, PREVIEW);

// ---------------------------------------------------------------------------------------------------
// 1. The mascot: a robot, 32x32, idle bob + antenna glow + blink.

await call('project_create', {
  name: 'robot',
  width: 32,
  height: 32,
  palette: 'endesga-32',
  layers: ['Robot'],
  settings: { lightDirection: 'top-left', previewBackground: '#1a1c2c' },
});
await call('draw', {
  project: 'robot',
  ops: [
    { op: 'grid', rows: ROBOT, legend: ROBOT_LEGEND },
    { op: 'outline', side: 'outside', color: 24 },
  ],
});
await look('robot-composite', { project: 'robot' }, 'agent-view.png');
await look('robot-value', { project: 'robot', view: 'value' });

// idle: rest → 1 px bob → antenna glow → blink
await call('frame', { project: 'robot', action: 'duplicate', frame: 0, count: 3 });
await call('cel', { project: 'robot', action: 'move', layer: 'Robot', frames: [1], dy: 1 });
await call('draw', {
  project: 'robot',
  ops: [
    { op: 'grid', frame: 2, ...ROBOT_GLOW, legend: ROBOT_LEGEND },
    { op: 'grid', frame: 3, ...ROBOT_BLINK, legend: ROBOT_LEGEND },
  ],
});
await call('frame', {
  project: 'robot',
  action: 'duration',
  frames: 'all',
  durations: [500, 350, 700, 120],
});
await call('tag', { project: 'robot', action: 'add', name: 'idle', from: 0, to: 3 });
await look('robot-filmstrip', { project: 'robot', view: 'filmstrip', tag: 'idle' });
await lint('robot');

await exportAs('robot', ['robot.png'], { format: 'png', frame: 0, scale: 8 });
await exportAs('robot', ['robot-idle.gif'], { format: 'gif', tag: 'idle', scale: 6 });

// ---------------------------------------------------------------------------------------------------
// 2. A slime, 16x16: rest → squash → stretch (airborne) → squash, then three palette-swap skins.

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
await call('draw', {
  project: 'coin',
  ops: [
    ...(['full', 'turn', 'edge', 'turn'] as const).flatMap((pose, frame) => coinOps(frame, pose)),
    ...[0, 1, 2, 3].map((frame) => ({ op: 'outline', frame, side: 'outside', color: 7 })),
  ],
});
await call('frame', { project: 'coin', action: 'duration', frames: 'all', duration: 110 });
await look('coin-filmstrip', { project: 'coin', view: 'filmstrip', frames: 'all' });
await lint('coin');
await exportAs('coin', ['coin-spin.gif'], { format: 'gif', frames: 'all', scale: 8 });

// ---------------------------------------------------------------------------------------------------
// 4. Item icons, one per frame, exported as a sprite sheet.

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

await close();
console.log(`wrote ${OUT}`);
