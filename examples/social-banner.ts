/**
 * An animated, framed 1080x1080 social banner (3 s loop) drawn entirely through `pixelclaus mcp` tool calls:
 * a 135x135 sprite exported at 8x. Marquee bulbs chase around the frame, snow falls, the title shines,
 * and the gallery sprites idle, bounce, spin and float. Build first, then:
 *
 *   npm run banner -- [outDir=examples] [previewDir]
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

const OUT = resolve(process.argv[2] ?? 'examples');
const PREVIEW = process.argv[3] ? resolve(process.argv[3]) : undefined;
const { call, look, lint, exportAs, close } = await connect('banner', OUT, PREVIEW);

const P = 'social-banner';
const SIZE = 135; // × 8 = 1080 px
const FRAMES = 30; // × 100 ms = 3 s; every cycle below divides 30, so the loop is seamless
const PANEL = { x: 9, y: 9, w: 117, h: 117 }; // inside the 9 px frame band
const GROUND = 93; // first row of the snow ground
const STATIC = ['Sky', 'Ground', 'Props', 'TitleShadow', 'Title', 'Subtitle', 'Text', 'Frame'];

type Op = Record<string, unknown>;
const on = (layer: string, ops: Op[]): Op[] => ops.map((o) => ({ layer, ...o }));
const wave = (f: number, cycles: number, phase = 0) =>
  Math.sin(2 * Math.PI * (cycles * (f / FRAMES) + phase));

await call('project_create', {
  name: P,
  width: SIZE,
  height: SIZE,
  palette: 'endesga-32',
  frames: FRAMES,
  frameDuration: 100,
  layers: [
    'Sky',
    'Snow',
    'Ground',
    'Shadows',
    'Props',
    'Slime',
    'Heart',
    'Coin',
    'Robot',
    'TitleShadow',
    'Title',
    'Shine',
    'Subtitle',
    'Text',
    'Frame',
    'Bulbs',
  ],
  settings: { lightDirection: 'top-left' },
});

// ---------------------------------------------------------------------------------------------------
// Static layers, drawn once on frame 0 and then linked to every frame.

await call('draw', {
  project: P,
  frame: 0,
  ops: [
    // night sky in three bands, lighter towards the horizon, with 2-row checker transitions;
    // the band edges sit below the title and between subtitle and ground so no text straddles one
    ...on('Sky', [
      { op: 'rect', x: PANEL.x, y: PANEL.y, w: PANEL.w, h: GROUND - PANEL.y, fill: 26 },
      { op: 'rect', x: PANEL.x, y: 49, w: PANEL.w, h: GROUND - 49, fill: 25 },
      { op: 'rect', x: PANEL.x, y: 74, w: PANEL.w, h: GROUND - 74, fill: 24 },
      { op: 'pattern', pattern: 'checker', colors: [25, 26], area: { x: PANEL.x, y: 47, w: PANEL.w, h: 2 } },
      { op: 'pattern', pattern: 'checker', colors: [24, 25], area: { x: PANEL.x, y: 72, w: PANEL.w, h: 2 } },
    ]),
    // snow ground with a bumpy top edge
    ...on('Ground', [
      { op: 'rect', x: PANEL.x, y: GROUND, w: PANEL.w, h: PANEL.y + PANEL.h - GROUND, fill: 20 },
      {
        op: 'gradient',
        from: [0, 119],
        to: [0, PANEL.y + PANEL.h - 1],
        colors: [20, 21],
        area: { x: PANEL.x, y: 119, w: PANEL.w, h: PANEL.y + PANEL.h - 119 },
      },
      {
        op: 'pixels',
        color: 20,
        points: Array.from({ length: PANEL.w }, (_, i) => PANEL.x + i)
          .filter((x) => x % 11 < 5)
          .map((x) => [x, GROUND - 1]),
      },
    ]),
    // props standing in the snow
    ...on('Props', [
      { op: 'grid', x: 34, y: GROUND - 14, rows: POTION, legend: ITEMS_LEGEND },
      { op: 'grid', x: 101, y: GROUND - 14, rows: MUSHROOM, legend: ITEMS_LEGEND },
      { op: 'outline', side: 'outside', color: 7 },
    ]),
    // frame: dark edge, gold trim, red band for the bulbs, gold trim, dark edge
    ...on('Frame', [
      { op: 'rect', x: 0, y: 0, w: SIZE, h: SIZE, color: 26 },
      { op: 'rect', x: 1, y: 1, w: SIZE - 2, h: SIZE - 2, color: 11 },
      { op: 'rect', x: 2, y: 2, w: SIZE - 4, h: SIZE - 4, color: 8, thickness: 5 },
      { op: 'rect', x: 7, y: 7, w: SIZE - 14, h: SIZE - 14, color: 10 },
      { op: 'rect', x: 8, y: 8, w: SIZE - 16, h: SIZE - 16, color: 26 },
    ]),
    // text: the subtitle gets a dark outline so falling snow never touches its letters
    ...on('Subtitle', [
      { op: 'text', x: 22, y: 49, text: 'PIXEL ART FOR AI AGENTS', color: 21, font: '3x5' },
      { op: 'outline', side: 'outside', color: 26 },
    ]),
    ...on('Text', [
      { op: 'text', x: 18, y: 103, text: 'DRAWN WITH MCP TOOL CALLS', color: 24, font: '3x5' },
      { op: 'text', x: 14, y: 113, text: 'GITHUB.COM/VIDUX/PIXELCLAUS', color: 8, font: '3x5' },
    ]),
    // title at 1x for now; scaled below
    ...on('Title', [
      { op: 'text', x: 45, y: 40, text: 'PIXEL', color: 12, font: '5x7' },
      { op: 'text', x: 45, y: 49, text: 'CLAUS', color: 12, font: '5x7' },
    ]),
  ],
});

// Title: 2x with scale2x (smooth diagonals), then put it where it belongs (scaling re-centres the layer).
await call('transform', {
  project: P,
  scope: 'cel',
  layer: 'Title',
  frames: [0],
  op: 'scale',
  factor: 2,
  method: 'scale2x',
});
const stats = await call('analyze', { project: P, kind: 'stats', layers: ['Title'] });
const bounds = /Title[^\n]*?bounds[^\d]*(\d+),\s*(\d+)/.exec(stats.text);
if (!bounds) throw new Error(`no Title bounds in:\n${stats.text}`);
await call('cel', {
  project: P,
  action: 'move',
  layer: 'Title',
  frames: [0],
  dx: 22 - Number(bounds[1]),
  dy: 13 - Number(bounds[2]),
});
// gold two-tone fill and a dark outline, then a 2-row extrusion cut from the outlined shape
await call('draw', {
  project: P,
  frame: 0,
  layer: 'Title',
  ops: [
    { op: 'rect', x: 0, y: 20, w: SIZE, h: 7, fill: 11, ink: 'inside' },
    { op: 'rect', x: 0, y: 38, w: SIZE, h: 7, fill: 11, ink: 'inside' },
    { op: 'outline', side: 'outside', color: 7 },
  ],
});
await call('select', { project: P, action: 'alpha', layer: 'Title', name: 'title-shadow' });
await call('select', { project: P, action: 'move', name: 'title-shadow', dx: 0, dy: 2 });
await call('draw', {
  project: P,
  frame: 0,
  layer: 'TitleShadow',
  ops: [{ op: 'rect', x: 0, y: 0, w: SIZE, h: SIZE, fill: 8, clip: 'title-shadow' }],
});
// the shine sweeps over the gold only, not the outline
await call('select', { project: P, action: 'color', color: 12, layer: 'Title', name: 'gold' });
await call('select', { project: P, action: 'color', color: 11, layer: 'Title', name: 'gold', mode: 'add' });

for (const layer of STATIC) {
  await call('cel', { project: P, action: 'link', layer, frames: 'all' });
}
await look('banner-static', { project: P, frame: 0 });

// ---------------------------------------------------------------------------------------------------
// Animated layers, one draw call per frame.

// 84 bulbs on the band's centre line (every 6 px), clockwise from the top-left corner
const bulbs: Array<[number, number]> = [];
for (let k = 0; k < 21; k++) bulbs.push([4 + 6 * k, 4]);
for (let k = 0; k < 21; k++) bulbs.push([130, 4 + 6 * k]);
for (let k = 0; k < 21; k++) bulbs.push([130 - 6 * k, 130]);
for (let k = 0; k < 21; k++) bulbs.push([4, 130 - 6 * k]);

function bulbPoints(f: number): Array<[number, number, number]> {
  return bulbs.flatMap(([x, y], i): Array<[number, number, number]> => {
    const phase = (((i - f) % 3) + 3) % 3; // 0 = lit, 2 = lit last frame, 1 = off
    if (phase === 1) return [[x, y, 7]];
    const [core, glow] = phase === 0 ? [20, 12] : [11, 10];
    return [
      [x, y, core],
      [x - 1, y, glow],
      [x + 1, y, glow],
      [x, y - 1, glow],
      [x, y + 1, glow],
    ];
  });
}

// snow: three depths (speed, colour); every flake travels a whole number of wraps in 30 frames
let seed = 7;
const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const flakes = [
  ...Array.from({ length: 16 }, () => ({ v: 2, wrap: 60, color: 23 })),
  ...Array.from({ length: 14 }, () => ({ v: 3, wrap: 90, color: 22 })),
  ...Array.from({ length: 10 }, () => ({ v: 4, wrap: 120, color: 20 })),
].map((d) => ({
  ...d,
  x: PANEL.x + 1 + Math.floor(random() * (PANEL.w - 2)),
  y: Math.floor(random() * d.wrap),
  p: random(),
}));

// the subtitle (x 22..112, y 49..53) plus a 2 px margin: a flake diagonal to a letter's corner slips past
// the outline and reads as part of the glyph ("FOR" turns into "FQR")
const NO_SNOW = { x0: 20, x1: 114, y0: 47, y1: 55 };

function snowPoints(f: number): Array<[number, number, number]> {
  const pts: Array<[number, number, number]> = [];
  for (const s of flakes) {
    const x = s.x + Math.round(wave(f, 1, s.p));
    for (let copy = 0; copy * s.wrap < GROUND - PANEL.y; copy++) {
      const y = PANEL.y + ((s.y + s.v * f) % s.wrap) + copy * s.wrap;
      const nearText = x >= NO_SNOW.x0 && x <= NO_SNOW.x1 && y >= NO_SNOW.y0 && y <= NO_SNOW.y1;
      if (y < GROUND - 1 && !nearText) pts.push([x, y, s.color]);
    }
  }
  return pts;
}

// slime: a 1 s hop, three times — rest, squash, take-off, apex, fall, landing squash
const SLIME_HOP: Array<[string[], number]> = [
  [SLIME_REST, 0],
  [SLIME_REST, 0],
  [SLIME_REST, 0],
  [SLIME_SQUASH, 0],
  [SLIME_STRETCH, 3],
  [SLIME_STRETCH, 0],
  [SLIME_STRETCH, -2],
  [SLIME_STRETCH, 0],
  [SLIME_SQUASH, 0],
  [SLIME_REST, 0],
];
const COIN_SPIN = ['full', 'full', 'turn', 'edge', 'turn'] as const;
// the robot's antenna pulses once a second and it blinks once per loop
const robotPatch = (p: { x: number; y: number; rows: string[] }, bob: number): Op => ({
  op: 'grid',
  x: 86 + p.x,
  y: 12 + bob + p.y,
  rows: p.rows,
  legend: ROBOT_LEGEND,
});

for (let f = 0; f < FRAMES; f++) {
  const [slime, slimeDy] = SLIME_HOP[f % 10]!;
  const airborne = slime === SLIME_STRETCH;
  const bob = f % 10 >= 5 ? 1 : 0;
  const heartY = 58 + Math.round(2 * wave(f, 2));
  const coinY = 60 + Math.round(2 * wave(f, 2, 0.5));
  const shineX = 22 + 9 * f;
  await call('draw', {
    project: P,
    frame: f,
    ops: [
      ...on('Bulbs', [{ op: 'pixels', points: bulbPoints(f) }]),
      ...on('Snow', [{ op: 'pixels', points: snowPoints(f) }]),
      ...on('Shadows', [
        { op: 'ellipse', x: airborne ? 17 : 15, y: GROUND, w: airborne ? 10 : 14, h: 3, fill: 21 },
        { op: 'ellipse', x: 36, y: GROUND, w: 12, h: 3, fill: 21 },
        { op: 'ellipse', x: 103, y: GROUND, w: 12, h: 3, fill: 21 },
      ]),
      ...on('Slime', [
        { op: 'grid', x: 14, y: GROUND - 15 + slimeDy, rows: slime, legend: SLIME_LEGEND },
        { op: 'outline', side: 'outside', color: 16 },
      ]),
      ...on('Heart', [
        { op: 'grid', x: 56, y: heartY, rows: HEART, legend: ITEMS_LEGEND },
        { op: 'outline', side: 'outside', color: 7 },
      ]),
      ...on('Coin', [
        ...coinOps(f, COIN_SPIN[f % 5]!, [78, coinY]).map(({ frame: _, ...op }) => op),
        { op: 'outline', side: 'outside', color: 7 },
      ]),
      ...on('Robot', [
        { op: 'grid', x: 86, y: 12 + bob, rows: ROBOT, legend: ROBOT_LEGEND },
        ...(f % 10 < 3 ? [robotPatch(ROBOT_GLOW, bob)] : []),
        ...(f === 22 || f === 23 ? [robotPatch(ROBOT_BLINK, bob)] : []),
        { op: 'outline', side: 'outside', color: 24 },
      ]),
      // a diagonal shine across the title in the first 1.2 s
      ...(shineX < 120
        ? on('Shine', [
            {
              op: 'polygon',
              points: [
                [shineX, 10],
                [shineX + 4, 10],
                [shineX - 32, 46],
                [shineX - 36, 46],
              ],
              fill: 20,
              clip: 'gold',
            },
          ])
        : []),
    ],
  });
}

await look('banner-f0', { project: P, frame: 0 });
await look('banner-f4', { project: P, frame: 4 });
await look('banner-film', { project: P, view: 'filmstrip', frames: { from: 0, to: 9 } });
await lint(P);
const notes = await exportAs(P, ['social-banner.gif'], { format: 'gif', frames: 'all', scale: 8 });
console.log(notes.join('\n'));
await close();
console.log(`wrote ${OUT}`);
