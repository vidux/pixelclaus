import type { ColorAdjustment } from '../color/hsl.js';
import type { DitherKind, PatternName } from '../draw/dither.js';
import type { GradientType } from '../draw/gradient.js';
import type { BrushShape } from '../draw/shapes.js';
import type { Ink, Symmetry } from '../draw/writer.js';
import type { ColorInput } from '../model/colors.js';
import type { LightDirection } from '../model/types.js';
import type { DitherMethod } from '../palette/quantize.js';
import type { Rect } from '../util/geometry.js';

/** A point as `[x, y]` or `{x, y}`. */
export type PointInput = readonly [number, number] | { x: number; y: number };

export interface OpCommon {
  /** Override the call's default layer. */
  layer?: string;
  /** Override the call's default frame. */
  frame?: number;
  ink?: Ink;
  /** Restrict to a named selection. */
  clip?: string;
}

export type DrawOp = OpCommon &
  (
    | {
        op: 'pixels';
        points: ReadonlyArray<
          | readonly [number, number]
          | readonly [number, number, ColorInput]
          | { x: number; y: number; color?: ColorInput }
        >;
        color?: ColorInput;
      }
    | {
        op: 'grid';
        x?: number;
        y?: number;
        rows: string | readonly string[];
        legend?: Record<string, ColorInput>;
        mode?: 'replace' | 'overlay';
      }
    | { op: 'line'; from: PointInput; to: PointInput; color: ColorInput; width?: number; brush?: BrushShape }
    | {
        op: 'path';
        points: readonly PointInput[];
        color: ColorInput;
        closed?: boolean;
        pixelPerfect?: boolean;
        width?: number;
        brush?: BrushShape;
      }
    | ({ op: 'rect'; color?: ColorInput; fill?: ColorInput; thickness?: number } & Rect)
    | ({ op: 'ellipse'; color?: ColorInput; fill?: ColorInput } & Rect)
    | { op: 'circle'; cx: number; cy: number; r: number; color?: ColorInput; fill?: ColorInput }
    | { op: 'polygon'; points: readonly PointInput[]; color?: ColorInput; fill?: ColorInput }
    | {
        op: 'fill';
        x: number;
        y: number;
        color: ColorInput;
        contiguous?: boolean;
        tolerance?: number;
        connectivity?: 4 | 8;
        reference?: 'layer' | 'composite';
      }
    | {
        op: 'replace_color';
        from: ColorInput;
        to: ColorInput;
        scope?: 'cel' | 'layer' | 'frame' | 'sprite';
        tolerance?: number;
      }
    | {
        op: 'gradient';
        from: PointInput;
        to: PointInput;
        colors: readonly ColorInput[];
        type?: GradientType;
        dither?: DitherKind;
        area?: Rect;
      }
    | {
        op: 'pattern';
        pattern: PatternName | readonly string[];
        colors: readonly ColorInput[];
        area?: Rect;
        offsetX?: number;
        offsetY?: number;
      }
    | {
        op: 'outline';
        color: ColorInput;
        side?: 'outside' | 'inside';
        connectivity?: 4 | 8;
        source?: 'layer' | 'composite' | string;
      }
    | {
        op: 'selout';
        light?: LightDirection;
        lightSteps?: number;
        sideSteps?: number;
        source?: 'layer' | 'composite' | string;
      }
    | {
        op: 'shade';
        mode?: 'shift' | 'light';
        amount?: number;
        light?: LightDirection;
        depth?: number;
        highlight?: number;
        shadow?: number;
        area?: Rect;
        ramp?: string;
        /** light mode: outline colour to leave untouched; 'auto' detects a dominant edge colour (default). */
        outline?: ColorInput | 'auto' | 'none';
      }
    | { op: 'erase'; area?: Rect; points?: readonly PointInput[] }
    | { op: 'clear' }
    | { op: 'copy'; name?: string; area?: Rect; source?: 'layer' | 'composite' }
    | { op: 'paste'; name?: string; x?: number; y?: number; mode?: 'overlay' | 'replace' }
    | {
        op: 'stamp';
        from: { layer?: string; frame?: number; area?: Rect };
        x?: number;
        y?: number;
        dx?: number;
        dy?: number;
        mode?: 'overlay' | 'replace';
        flipX?: boolean;
        flipY?: boolean;
      }
    | {
        op: 'text';
        x: number;
        y: number;
        text: string;
        color: ColorInput;
        font?: '3x5' | '5x7';
        spacing?: number;
      }
    | ({ op: 'adjust'; area?: Rect } & ColorAdjustment)
    | { op: 'quantize'; dither?: DitherMethod; area?: Rect }
  );

export type DrawOpName = DrawOp['op'];

export interface DrawRequest {
  /** Default layer for ops (id or name). */
  layer?: string;
  /** Default frame (0-indexed). Default 0. */
  frame?: number;
  ops: readonly DrawOp[];
  symmetry?: Symmetry;
  ink?: Ink;
  /** Default clip selection for all ops. */
  clip?: string;
}

export interface OpResult {
  op: DrawOpName;
  layer?: string;
  frame?: number;
  written: number;
  clipped?: number;
  note?: string;
}

export interface DrawResult {
  results: OpResult[];
  written: number;
  dirty: Rect | null;
}
