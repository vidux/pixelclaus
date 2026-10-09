/**
 * Sprite art shared by the example scripts: ASCII grids for the `grid` draw op (legend values are
 * endesga-32 palette indices) and op builders for sprites made from shape ops.
 */
type Op = Record<string, unknown>;

export const EMPTY16 = '................';

// The robot mascot, 32x32. Flats only: the outline op adds the 1 px outline around the silhouette.
export const ROBOT = [
  '................................',
  '...............BB...............',
  '..............BYBB..............',
  '..............BBBB..............',
  '...............BB...............',
  '...............MD...............',
  '...............MD...............',
  '.......LLLLLLLLLLLLLLLLLL.......',
  '......LLLLLLLLLLLLLLLLLLLL......',
  '.....LLWWMMMMMMMMMMMMMMMMDD.....',
  '.....LLWMVVVVVVVVVVVVVVMMDD.....',
  '.....LLMVVVVVVVVVVVVVVVVMDD.....',
  '....MLLMVVWEEVVVVVVWEEVVMDDD....',
  '...MMLLMVVEEEVVVVVVEEEVVMDDDD...',
  '...OOLLMVVeeeVVVVVVeeeVVMDDOO...',
  '...OOLLMVVVVVVVVVVVVVVVVMDDOO...',
  '...MMLLMVVVVVVVVVVVVVVVVMDDDD...',
  '....MLLMMVVVVVVVVVVVVVVMMDDD....',
  '.....LLMMMMMMMMMMMMMMMMMMDD.....',
  '.....LLMMMMMDDMDDMDDMMMMMDD.....',
  '.....LLMMMMMDDMDDMDDMMMMMDD.....',
  '.....LLMMMMMMMMMMMMMMMMMMDD.....',
  '......MDDDDDDDDDDDDDDDDDDD......',
  '.......DDDDDDDDDDDDDDDDDD.......',
  '.............MDDDDD.............',
  '.............MDDDDD.............',
  '........LLLLLLLLLLLLLLLL........',
  '.......LMMMMMMMYOMMMMMMMD.......',
  '.......LMMMMMMMOOMMMMMMMD.......',
  '.......LMMMMMMMMMMMMMMMMD.......',
  '................................',
  '................................',
];
// prettier-ignore
export const ROBOT_LEGEND = { L: 21, M: 22, D: 23, V: 25, E: 19, e: 18, B: 10, Y: 12, O: 10, W: 20 };
/** Patches over ROBOT (`~` leaves pixels unchanged); x/y are offsets from the sprite's top-left. */
export const ROBOT_BLINK = { x: 10, y: 12, rows: ['VVV~~~~~~VVV', 'EEE~~~~~~EEE', 'VVV~~~~~~VVV'] };
export const ROBOT_GLOW = { x: 14, y: 1, rows: ['~YY~', 'YWYY', 'YYYY', '~YY~'] };

// Slime, 16x16: rest, squash, stretch (airborne).
export const SLIME_LEGEND = { G: 14, h: 13, s: 15, W: 20, e: 26 };
export const SLIME_REST = [
  ...Array<string>(6).fill(EMPTY16),
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
export const SLIME_SQUASH = [
  ...Array<string>(8).fill(EMPTY16),
  '.....GGGGGG.....',
  '...GGGGGGGGGG...',
  '..GhWGGGGGGGGG..',
  '.GhGGeGGGGeGGGs.',
  '.GGGGeGGGGeGGGs.',
  '.sGGGGGGGGGGGss.',
  '..ssssssssssss..',
  EMPTY16,
];
export const SLIME_STRETCH = [
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
  ...Array<string>(5).fill(EMPTY16),
];

// Item icons, 16x16.
export const ITEMS_LEGEND = { R: 9, r: 8, h: 30, W: 20, k: 5, K: 6, g: 21, P: 29, p: 28, s: 3, S: 4, e: 26 };
export const HEART = [
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
export const POTION = [
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
export const MUSHROOM = [
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

/**
 * A 16x16 coin from shape ops (no grid), in one of three spin poses, with its top-left at `at`.
 * Outline not included. Put the coin on its own layer: `shade` works on the whole cel.
 */
export function coinOps(frame: number, pose: 'full' | 'turn' | 'edge', at: [number, number] = [0, 0]): Op[] {
  const [x, y] = at;
  if (pose === 'edge') {
    return [
      { op: 'rect', frame, x: x + 7, y: y + 2, w: 2, h: 12, fill: 10 },
      { op: 'line', frame, from: [x + 7, y + 3], to: [x + 7, y + 12], color: 11 },
    ];
  }
  const w = pose === 'full' ? 12 : 8;
  const ops: Op[] = [
    { op: 'ellipse', frame, x: x + (16 - w) / 2, y: y + 2, w, h: 12, fill: 11 },
    { op: 'shade', frame, mode: 'light', light: 'top-left', ramp: 'fire' },
    { op: 'rect', frame, x: x + 7, y: y + 5, w: 2, h: 6, fill: 10 },
    { op: 'pixels', frame, color: 12, points: [[x + 7, y + 5]] },
  ];
  // shade "light" is a rough first pass: hand-fix the stray rim pixels lint reported as orphans
  if (pose === 'full') {
    const rim = [
      [5, 12],
      [6, 13],
      [12, 5],
      [13, 6],
    ];
    ops.push({ op: 'pixels', frame, color: 11, points: rim.map(([px, py]) => [x + px!, y + py!]) });
  }
  return ops;
}
