/**
 * CPU-heavy, read-only work that runs on compute workers (or inline when the pool has no threads):
 * preview rendering + PNG encoding, export building, analysis. Each task gets a document payload copied
 * on the main thread, so it never touches live documents or holds a project lock.
 */
import { compositeFrame, type RenderRequest, renderView, resolveLayer } from '@pixelclaus/core';
import { decodePxc, encodePxc, flattenOnMatte, rasterToPng } from '@pixelclaus/formats';
import { buildExport, type BuiltFile, type ExportRequest } from '../services/export-build.js';
import { analyzeLines, type AnalyzeRequest } from './analyze.js';
import { payloadDoc, payloadSnapshot, snapshotPayload, type DocPayload } from './snapshot.js';

/** Plain frame render (REST frames, thumbnails). */
export interface FrameRequest {
  frame: number;
  /** Layer ids or names to isolate. */
  layers?: string[];
  includeHidden?: boolean;
  includeReference?: boolean;
  /** Packed RGBA matte. */
  background?: number | null;
  scale?: number;
  /** Largest integer scale that keeps the image ≤ fit px (thumbnails). */
  fit?: number;
  /** PNG deflate level. */
  level?: number;
}

export type ComputeTask =
  | { kind: 'render'; doc: DocPayload; req: RenderRequest }
  | { kind: 'frame'; doc: DocPayload; req: FrameRequest }
  | { kind: 'export'; doc: DocPayload; id: string; req: ExportRequest }
  | { kind: 'analyze'; doc: DocPayload; req: AnalyzeRequest }
  /** Checkpoints / .pxc: compress a complete document, or decode one back to a payload. */
  | { kind: 'pxc-encode'; doc: DocPayload }
  | { kind: 'pxc-decode'; bytes: Uint8Array }
  /** Diagnostics/tests: occupy a worker for `busyMs` of CPU time. */
  | { kind: 'busy'; busyMs: number };

export interface TaskResults {
  render: { png: Uint8Array; info: Record<string, unknown>; width: number; height: number };
  frame: { png: Uint8Array; width: number; height: number };
  export: { files: BuiltFile[]; warnings: string[] };
  analyze: { lines: string[] };
  'pxc-encode': { bytes: Uint8Array };
  'pxc-decode': { doc: DocPayload };
  busy: { threadId: number };
}

export type TaskResult<K extends ComputeTask['kind']> = TaskResults[K];

export async function runTask(task: ComputeTask, threadId = 0): Promise<TaskResults[ComputeTask['kind']]> {
  switch (task.kind) {
    case 'render': {
      const out = renderView(payloadDoc(task.doc), task.req);
      return {
        png: rasterToPng(out.raster),
        info: out.info,
        width: out.raster.width,
        height: out.raster.height,
      };
    }
    case 'frame': {
      const doc = payloadDoc(task.doc);
      const q = task.req;
      const isolate = q.layers?.length ? q.layers.map((l) => resolveLayer(doc, l).id) : undefined;
      let img = compositeFrame(doc, {
        frame: q.frame,
        isolate,
        includeHidden: q.includeHidden,
        includeReference: q.includeReference,
      });
      if (q.background !== undefined && q.background !== null) img = flattenOnMatte(img, q.background);
      let scale = q.scale ?? 1;
      if (q.fit) scale = Math.max(1, Math.min(8, Math.floor(q.fit / Math.max(img.width, img.height, 1))));
      if (scale > 1) img = img.scaled(scale);
      return {
        png: rasterToPng(img, q.level !== undefined ? { level: q.level } : undefined),
        width: img.width,
        height: img.height,
      };
    }
    case 'export':
      return buildExport(payloadDoc(task.doc), task.id, task.req);
    case 'analyze':
      return { lines: analyzeLines(payloadDoc(task.doc), task.req) };
    case 'pxc-encode':
      return { bytes: encodePxc(payloadSnapshot(task.doc)) };
    case 'pxc-decode':
      return { doc: snapshotPayload(decodePxc(task.bytes)).payload };
    case 'busy': {
      const end = Date.now() + task.busyMs;
      while (Date.now() < end) {
        // spin: simulates a CPU-bound render/export
      }
      return { threadId };
    }
  }
}

/** Which frames' pixels a task needs (null = all), so payload copies stay small. */
export function framesForRender(req: RenderRequest): number[] | null {
  const single = ['composite', 'silhouette', 'value', 'indexed', 'tile', 'contact', 'palette'];
  const view = req.view ?? 'composite';
  if (single.includes(view)) return [req.frame ?? 0];
  if (view === 'diff' && req.compareFrame !== undefined) return [req.frame ?? 0, req.compareFrame];
  return null;
}

export function framesForExport(req: ExportRequest): number[] | null {
  if (req.format === 'png' || req.format === 'jpg' || req.format === 'webp') return [req.frame ?? 0];
  if (req.format === 'palette') return [];
  return null;
}

export function framesForAnalyze(req: AnalyzeRequest): number[] | null {
  if (req.kind === 'diff' && req.frameA !== undefined && req.frameB !== undefined)
    return [req.frameA, req.frameB];
  return null;
}
