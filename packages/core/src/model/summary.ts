/**
 * Compact, JSON-friendly overview of a document (used by project_get, the viewer API and UIs).
 */
import type { SpriteDocument } from './document.js';
import { celsOfLayer, layerDepth, walkLayers } from './lookup.js';
import type { SpriteSettings, TagState } from './types.js';

export interface LayerSummary {
  id: string;
  name: string;
  type: string;
  depth: number;
  parentId: string | null;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: string;
  isBackground: boolean;
  continuous: boolean;
  /** Frames that have a cel. */
  celFrames: number[];
  /** Groups of frames sharing one image (linked cels). */
  links: number[][];
  notes?: string;
}

export interface DocumentSummary {
  id: string;
  name: string;
  width: number;
  height: number;
  colorMode: string;
  frameCount: number;
  durations: number[];
  totalDuration: number;
  layers: LayerSummary[];
  tags: TagState[];
  slices: Array<{ name: string; keys: number }>;
  palette: { name: string; size: number; ramps: string[] };
  selections: string[];
  clipboards: string[];
  settings: SpriteSettings;
  notes: string;
  revision: number;
  history: { undo: number; redo: number; last: string | null };
  created: string;
  modified: string;
}

export function summarizeDocument(doc: SpriteDocument): DocumentSummary {
  const st = doc.state;
  const layers: LayerSummary[] = [];
  // top → bottom reads naturally in a list, but keep the documented bottom → top sibling order
  walkLayers(st, (l) => {
    const cels = celsOfLayer(st, l.id);
    const byImage = new Map<string, number[]>();
    for (const c of cels) byImage.set(c.imageId, [...(byImage.get(c.imageId) ?? []), c.frame]);
    layers.push({
      id: l.id,
      name: l.name,
      type: l.type,
      depth: layerDepth(st, l),
      parentId: l.parentId,
      visible: l.visible,
      locked: l.locked,
      opacity: l.opacity,
      blendMode: l.blendMode,
      isBackground: l.isBackground,
      continuous: l.continuous,
      celFrames: cels.map((c) => c.frame),
      links: [...byImage.values()].filter((g) => g.length > 1),
      ...(l.notes ? { notes: l.notes } : {}),
    });
  });
  const last = doc.history.listUndo(1)[0];
  return {
    id: st.id,
    name: st.name,
    width: st.width,
    height: st.height,
    colorMode: st.colorMode,
    frameCount: st.frames.length,
    durations: st.frames.map((f) => f.duration),
    totalDuration: st.frames.reduce((s, f) => s + f.duration, 0),
    layers,
    tags: st.tags,
    slices: st.slices.map((s) => ({ name: s.name, keys: s.keys.length })),
    palette: {
      name: st.palette.name,
      size: st.palette.colors.length - 1,
      ramps: st.palette.ramps.map((r) => `${r.name}[${r.indices.join(',')}]`),
    },
    selections: Object.keys(st.selections),
    clipboards: Object.keys(st.clipboards),
    settings: st.settings,
    notes: st.notes,
    revision: doc.revision,
    history: { undo: doc.history.undoCount, redo: doc.history.redoCount, last: last?.label ?? null },
    created: st.created,
    modified: st.modified,
  };
}
