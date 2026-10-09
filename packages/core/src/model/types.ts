/**
 * Serializable document metadata. Everything here is plain JSON; pixel data lives in image/mask stores
 * referenced by id.
 */
import type { BlendMode } from '../color/blend.js';
import type { Point, Rect } from '../util/geometry.js';

export type ColorMode = 'indexed' | 'rgba';
export type LayerType = 'image' | 'group' | 'reference';
export type TagDirection = 'forward' | 'reverse' | 'pingpong' | 'pingpong_reverse';
export type LightDirection =
  'top-left' | 'top' | 'top-right' | 'left' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right';
export type MissingColorPolicy = 'snap' | 'add' | 'error';

export const TAG_DIRECTIONS: readonly TagDirection[] = ['forward', 'reverse', 'pingpong', 'pingpong_reverse'];
export const LIGHT_DIRECTIONS: readonly LightDirection[] = [
  'top-left',
  'top',
  'top-right',
  'left',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
];

export interface LayerState {
  id: string;
  name: string;
  type: LayerType;
  /** Parent group id or null for root. */
  parentId: string | null;
  visible: boolean;
  locked: boolean;
  /** 0..255 */
  opacity: number;
  blendMode: BlendMode;
  /** Bottom-most opaque layer (Aseprite "Background"). */
  isBackground: boolean;
  /** New frames link this layer's cels instead of creating empty cels. */
  continuous: boolean;
  /** UI/timeline colour tag, '#rrggbb' */
  color?: string;
  notes?: string;
  /** Group collapsed state (informational, for UIs and .aseprite round-trips). */
  collapsed?: boolean;
}

export interface FrameState {
  /** Duration in milliseconds. */
  duration: number;
  notes?: string;
}

export interface CelState {
  layerId: string;
  frame: number;
  imageId: string;
  /** Canvas position of the image's top-left pixel. */
  x: number;
  y: number;
  /** 0..255 */
  opacity: number;
  zIndex: number;
  notes?: string;
}

export interface TagState {
  name: string;
  /** Inclusive frame range. */
  from: number;
  to: number;
  direction: TagDirection;
  /** 0 = loop forever */
  repeat: number;
  color: string;
  notes?: string;
}

export interface SliceKey {
  frame: number;
  bounds: Rect;
  /** 9-patch centre, relative to bounds. */
  center?: Rect;
  /** Pivot, relative to bounds. */
  pivot?: Point;
}

export interface SliceState {
  name: string;
  color: string;
  keys: SliceKey[];
  notes?: string;
}

export interface RampState {
  name: string;
  /** Palette indices ordered dark → light. */
  indices: number[];
}

export interface PaletteState {
  name: string;
  /** '#rrggbbaa'. colors[0] is always transparent. Max 256 entries. */
  colors: string[];
  /** Optional names keyed by index (as string). */
  names: Record<string, string>;
  ramps: RampState[];
}

export interface SpriteSettings {
  /** RGBA mode: snap written colours to the palette. (Indexed mode is always palette-bound.) */
  paletteLock: boolean;
  /** What happens when a colour that is not in the palette is used. */
  missingColor: MissingColorPolicy;
  lightDirection: LightDirection;
  /** Background colour used by previews ('#rrggbb') or null for checkerboard. */
  previewBackground: string | null;
  /** Target number of colours (lint). */
  colorBudget: number | null;
  /** Palette index of the main outline colour (lint, selout). */
  outlineColor: number | null;
}

export interface ClipboardState {
  imageId: string;
  /** Canvas position the content was copied from. */
  x: number;
  y: number;
}

export interface SpriteState {
  version: 1;
  id: string;
  name: string;
  width: number;
  height: number;
  colorMode: ColorMode;
  pixelRatio: { x: number; y: number };
  grid: Rect;
  palette: PaletteState;
  /** Sibling order is bottom → top. */
  layers: LayerState[];
  frames: FrameState[];
  cels: CelState[];
  tags: TagState[];
  slices: SliceState[];
  /** Named selections → mask id. */
  selections: Record<string, string>;
  clipboards: Record<string, ClipboardState>;
  settings: SpriteSettings;
  notes: string;
  created: string;
  modified: string;
}

export const MAX_CANVAS = 4096;
export const MAX_FRAMES = 2000;
export const MAX_LAYERS = 256;
export const MAX_PALETTE = 256;
/** Pixel budget for one document's images (2^28 px ≈ 1 GB): one project must not exhaust a shared server. */
export const MAX_DOC_PIXELS = 2 ** 28;
