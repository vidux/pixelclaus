/**
 * Built-in palette presets (colours only; index 0 transparent is added when loaded).
 * Ramps are auto-detected on load unless authored here.
 */
export interface PalettePreset {
  name: string;
  description: string;
  colors: readonly string[];
  /** Authored ramps as indices into `colors` (0-based, dark → light). */
  ramps?: ReadonlyArray<{ name: string; colors: readonly number[] }>;
}

const split = (s: string): string[] =>
  s
    .trim()
    .split(/\s+/)
    .map((h) => `#${h.toLowerCase()}`);

export const PRESETS: readonly PalettePreset[] = [
  {
    name: 'pico-8',
    description: 'PICO-8 fantasy console, 16 colours. Bright, high contrast, great default.',
    colors: split(
      '000000 1d2b53 7e2553 008751 ab5236 5f574f c2c3c7 fff1e8 ff004d ffa300 ffec27 00e436 29adff 83769c ff77a8 ffccaa',
    ),
    ramps: [
      { name: 'gray', colors: [0, 5, 6, 7] },
      { name: 'red', colors: [2, 8, 14, 15] },
      { name: 'orange', colors: [4, 9, 10] },
      { name: 'green', colors: [1, 3, 11] },
      { name: 'blue', colors: [1, 13, 12] },
      { name: 'skin', colors: [4, 9, 15, 7] },
    ],
  },
  {
    name: 'sweetie-16',
    description: 'Sweetie 16 by GrafxKid. Soft, versatile 16-colour palette.',
    colors: split(
      '1a1c2c 5d275d b13e53 ef7d57 ffcd75 a7f070 38b764 257179 29366f 3b5dc9 41a6f6 73eff7 f4f4f4 94b0c2 566c86 333c57',
    ),
    ramps: [
      { name: 'warm', colors: [0, 1, 2, 3, 4] },
      { name: 'green', colors: [0, 7, 6, 5] },
      { name: 'blue', colors: [0, 8, 9, 10, 11] },
      { name: 'gray', colors: [0, 15, 14, 13, 12] },
    ],
  },
  {
    name: 'db16',
    description: 'DawnBringer 16. Classic balanced 16-colour palette.',
    colors: split(
      '140c1c 442434 30346d 4e4a4e 854c30 346524 d04648 757161 597dce d27d2c 8595a1 6daa2c d2aa99 6dc2ca dad45e deeed6',
    ),
  },
  {
    name: 'db32',
    description: 'DawnBringer 32. The standard general-purpose 32-colour palette.',
    colors: split(
      '000000 222034 45283c 663931 8f563b df7126 d9a066 eec39a fbf236 99e550 6abe30 37946e 4b692f 524b24 323c39 3f3f74 306082 5b6ee1 639bff 5fcde4 cbdbfc ffffff 9badb7 847e87 696a6a 595652 76428a ac3232 d95763 d77bba 8f974a 8a6f30',
    ),
    ramps: [
      { name: 'skin', colors: [1, 2, 3, 4, 6, 7] },
      { name: 'fire', colors: [2, 27, 5, 8] },
      { name: 'green', colors: [14, 12, 10, 9] },
      { name: 'teal', colors: [14, 11, 19] },
      { name: 'blue', colors: [1, 15, 16, 17, 18, 19, 20] },
      { name: 'gray', colors: [1, 25, 24, 23, 22, 21] },
      { name: 'purple', colors: [15, 26, 29] },
      { name: 'olive', colors: [13, 31, 30] },
    ],
  },
  {
    name: 'endesga-32',
    description: 'Endesga 32. Rich, saturated, very popular for games.',
    colors: split(
      'be4a2f d77643 ead4aa e4a672 b86f50 733e39 3e2731 a22633 e43b44 f77622 feae34 fee761 63c74d 3e8948 265c42 193c3e 124e89 0099db 2ce8f5 ffffff c0cbdc 8b9bb4 5a6988 3a4466 262b44 181425 ff0044 68386c b55088 f6757a e8b796 c28569',
    ),
    ramps: [
      { name: 'skin', colors: [6, 5, 4, 3, 2] },
      { name: 'red', colors: [6, 7, 8, 29] },
      { name: 'fire', colors: [7, 9, 10, 11] },
      { name: 'green', colors: [15, 14, 13, 12] },
      { name: 'blue', colors: [24, 16, 17, 18] },
      { name: 'gray', colors: [25, 24, 23, 22, 21, 20, 19] },
      { name: 'purple', colors: [25, 27, 28, 29] },
      { name: 'rust', colors: [6, 5, 0, 1, 3] },
    ],
  },
  {
    name: 'resurrect-64',
    description: 'Resurrect 64 by Kerrie Lake. Large, harmonious 64-colour palette.',
    colors: split(
      '2e222f 3e3546 625565 966c6c ab947a 694f62 7f708a 9babb2 c7dcd0 ffffff 6e2727 b33831 ea4f36 f57d4a ae2334 e83b3b fb6b1d f79617 f9c22b 7a3045 9e4539 cd683d e6904e fbb954 4c3e24 676633 a2a947 d5e04b fbff86 165a4c 239063 1ebc73 91db69 cddf6c 313638 374e4a 547e64 92a984 b2ba90 0b5e65 0b8a8f 0eaf9b 30e1b9 8ff8e2 323353 484a77 4d65b4 4d9be6 8fd3ff 45293f 6b3e75 905ea9 a884f3 eaaded 753c54 a24b6f cf657f ed8099 831c5d c32454 f04f78 f68181 fca790 fdcbb0',
    ),
  },
  {
    name: 'aap-64',
    description: 'AAP-64 by Adigun Polack. 64 colours with long natural ramps.',
    colors: split(
      '060608 141013 3b1725 73172d b4202a df3e23 fa6a0a f9a31b ffd541 fffc40 d6f264 9cdb43 59c135 14a02e 1a7a3e 24523b 122020 143464 285cc4 249fde 20d6c7 a6fcdb ffffff fef3c0 fad6b8 f5a097 e86a73 bc4a9b 793a80 403353 242234 221c1a 322b28 71413b bb7547 dba463 f4d29c dae0ea b3b9d1 8b93af 6d758d 4a5462 333941 422433 5b3138 8e5252 ba756a e9b5a3 e3e6ff b9bffb 849be4 588dbe 477d85 23674e 328464 5daf8d 92dcba cdf7e2 e4d2aa c7b08b a08662 796755 5a4e44 423934',
    ),
  },
  {
    name: 'apollo',
    description: 'Apollo by AdamCYounis. 46 colours organised in clean ramps.',
    colors: split(
      '172038 253a5e 3c5e8b 4f8fba 73bed3 a4dddb 19332d 25562e 468232 75a743 a8ca58 d0da91 4d2b32 7a4841 ad7757 c09473 d7b594 e7d5b3 341c27 602c2c 884b2b be772b de9e41 e8c170 241527 411d31 752438 a53030 cf573c da863e 1e1d39 402751 7a367b a23e8c c65197 df84a5 090a14 10141f 151d28 202e37 394a50 577277 819796 a8b5b2 c7cfcc ebede9',
    ),
    ramps: [
      { name: 'blue', colors: [0, 1, 2, 3, 4, 5] },
      { name: 'green', colors: [6, 7, 8, 9, 10, 11] },
      { name: 'brown', colors: [12, 13, 14, 15, 16, 17] },
      { name: 'orange', colors: [18, 19, 20, 21, 22, 23] },
      { name: 'red', colors: [24, 25, 26, 27, 28, 29] },
      { name: 'purple', colors: [30, 31, 32, 33, 34, 35] },
      { name: 'gray', colors: [36, 37, 38, 39, 40, 41, 42, 43, 44, 45] },
    ],
  },
  {
    name: 'lospec500',
    description: 'Lospec 500 collaborative palette, 42 colours.',
    colors: split(
      '10121c 2c1e31 6b2643 ac2847 ec273f 94493a de5d3a e98537 f3a833 4d3533 6e4c30 a26d3f ce9248 dab163 e8d282 f7f3b7 1e4044 006554 26854c 5ab552 9de64e 008b8b 62a477 a6cb96 d3eed3 3e3b65 3859b3 3388de 36c5f4 6dead6 5e5b8c 8c78a5 b0a7b8 deceed 9a4d76 c878af cc99ff fa6e79 ffa2ac ffd1d5 f6e8e0 ffffff',
    ),
  },
  {
    name: 'vinik24',
    description: 'Vinik 24. Muted, painterly 24-colour palette.',
    colors: split(
      '000000 6f6776 9a9a97 c5ccb8 8b5580 c38890 a593a5 666092 9a4f50 c28d75 7ca1c0 416aa3 8d6268 be955c 68aca9 387080 6e6962 93a167 6eaa78 557064 9d9f7f 7e9e99 5d6872 433455',
    ),
  },
  {
    name: 'nes',
    description: 'NES (2C02) approximate palette, unique colours.',
    colors: split(
      '7c7c7c 0000fc 0000bc 4428bc 940084 a80020 a81000 881400 503000 007800 006800 005800 004058 000000 bcbcbc 0078f8 0058f8 6844fc d800cc e40058 f83800 e45c10 ac7c00 00b800 00a800 00a844 008888 f8f8f8 3cbcfc 6888fc 9878f8 f878f8 f85898 f87858 fca044 f8b800 b8f818 58d854 58f898 00e8d8 787878 fcfcfc a4e4fc b8b8f8 d8b8f8 f8b8f8 f8a4c0 f0d0b0 fce0a8 f8d878 d8f878 b8f8b8 b8f8d8 00fcfc f8d8f8',
    ),
  },
  {
    name: 'c64',
    description: 'Commodore 64 (Pepto) 16 colours.',
    colors: split(
      '000000 ffffff 68372b 70a4b2 6f3d86 588d43 352879 b8c76f 6f4f25 433900 9a6759 444444 6c6c6c 9ad284 6c5eb5 959595',
    ),
  },
  {
    name: 'cga',
    description: 'IBM CGA full 16-colour palette.',
    colors: split(
      '000000 0000aa 00aa00 00aaaa aa0000 aa00aa aa5500 aaaaaa 555555 5555ff 55ff55 55ffff ff5555 ff55ff ffff55 ffffff',
    ),
  },
  {
    name: 'zx-spectrum',
    description: 'ZX Spectrum 15 unique colours (normal + bright).',
    colors: split(
      '000000 0000d7 d70000 d700d7 00d700 00d7d7 d7d700 d7d7d7 0000ff ff0000 ff00ff 00ff00 00ffff ffff00 ffffff',
    ),
  },
  {
    name: 'gameboy',
    description: 'Original Game Boy (DMG) 4 greens, dark → light.',
    colors: split('0f380f 306230 8bac0f 9bbc0f'),
    ramps: [{ name: 'green', colors: [0, 1, 2, 3] }],
  },
  {
    name: 'kirokaze-gameboy',
    description: 'Kirokaze Game Boy, 4 colours with a purple shadow.',
    colors: split('332c50 46878f 94e344 e2f3e4'),
    ramps: [{ name: 'main', colors: [0, 1, 2, 3] }],
  },
  {
    name: '2bit-demichrome',
    description: '2-bit Demichrome, 4 neutral tones.',
    colors: split('211e20 555568 a0a08b e9efec'),
    ramps: [{ name: 'main', colors: [0, 1, 2, 3] }],
  },
  {
    name: '1bit',
    description: 'Black and white.',
    colors: split('000000 ffffff'),
    ramps: [{ name: 'mono', colors: [0, 1] }],
  },
  {
    name: 'grayscale-8',
    description: '8 evenly spaced grays.',
    colors: split('000000 242424 494949 6d6d6d 929292 b6b6b6 dbdbdb ffffff'),
    ramps: [{ name: 'gray', colors: [0, 1, 2, 3, 4, 5, 6, 7] }],
  },
  {
    name: 'slso8',
    description: 'SLSO8, 8 colours from deep blue to cream.',
    colors: split('0d2b45 203c56 544e68 8d697a d08159 ffaa5e ffd4a3 ffecd6'),
    ramps: [{ name: 'main', colors: [0, 1, 2, 3, 4, 5, 6, 7] }],
  },
  {
    name: 'ammo-8',
    description: 'Ammo-8, 8 greens.',
    colors: split('040c06 112318 1e3a29 305d42 4d8061 89a257 bedc7f eeffcc'),
    ramps: [{ name: 'green', colors: [0, 1, 2, 3, 4, 5, 6, 7] }],
  },
  {
    name: 'nyx8',
    description: 'Nyx8, 8 moody colours.',
    colors: split('08141e 0f2a3f 20394f f6d6bd c3a38a 997577 816271 4e495f'),
    ramps: [{ name: 'main', colors: [0, 1, 2, 7, 6, 5, 4, 3] }],
  },
  {
    name: 'oil-6',
    description: 'Oil 6, 6 soft colours.',
    colors: split('fbf5ef f2d3ab c69fa5 8b6d9c 494d7e 272744'),
    ramps: [{ name: 'main', colors: [5, 4, 3, 2, 1, 0] }],
  },
  {
    name: 'twilight-5',
    description: 'Twilight 5, 5 colours.',
    colors: split('fbbbad ee8695 4a7a96 333f58 292831'),
    ramps: [{ name: 'main', colors: [4, 3, 2, 1, 0] }],
  },
];

export function findPreset(name: string): PalettePreset | undefined {
  const n = name.toLowerCase().replace(/[\s_]+/g, '-');
  return PRESETS.find((p) => p.name === n || p.name.replace(/-/g, '') === n.replace(/-/g, ''));
}

export function presetNames(): string[] {
  return PRESETS.map((p) => p.name);
}
