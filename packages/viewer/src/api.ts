/** Typed client for the PixelClaus REST API. */

export interface ProjectListing {
  id: string;
  name: string;
  width: number;
  height: number;
  colorMode: string;
  frames: number;
  layers: number;
  tags: string[];
  revision: number;
  modified: string;
  created: string;
}

export interface LayerSummary {
  id: string;
  name: string;
  type: 'image' | 'group' | 'reference';
  depth: number;
  parentId: string | null;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: string;
  isBackground: boolean;
  continuous: boolean;
  celFrames: number[];
  links: number[][];
  notes?: string;
}

export interface TagSummary {
  name: string;
  from: number;
  to: number;
  direction: 'forward' | 'reverse' | 'pingpong' | 'pingpong_reverse';
  repeat: number;
  color: string;
}

export interface ProjectDetail {
  id: string;
  name: string;
  width: number;
  height: number;
  colorMode: string;
  frameCount: number;
  durations: number[];
  totalDuration: number;
  layers: LayerSummary[];
  tags: TagSummary[];
  slices: Array<{ name: string; keys: number }>;
  palette: { name: string; size: number; ramps: string[] };
  paletteColors: Array<{ index: number; hex: string; name?: string }>;
  checkpoints: Array<{ id: string; name: string; created: string }>;
  notes: string;
  revision: number;
  modified: string;
  created: string;
}

export interface ExportFile {
  name: string;
  bytes: number;
  modified: string;
}

export interface ExportOptions {
  format: string;
  frame?: number;
  tag?: string;
  scale?: number;
  background?: string;
  trim?: boolean;
  splitLayers?: boolean;
  splitTags?: boolean;
  paletteFormat?: string;
  sheet?: {
    layout?: string;
    columns?: number;
    padding?: number;
    trim?: boolean;
    json?: string;
    extrude?: number;
  };
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string; hint?: string };
      if (body.error) msg = body.error + (body.hint ? ` — ${body.hint}` : '');
    } catch {
      // not JSON
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const api = {
  list: () => fetch('/api/projects').then((r) => json<ProjectListing[]>(r)),
  get: (id: string) => fetch(`/api/projects/${enc(id)}`).then((r) => json<ProjectDetail>(r)),
  remove: (id: string) =>
    fetch(`/api/projects/${enc(id)}`, { method: 'DELETE' }).then((r) => json<{ deleted: string }>(r)),
  formats: () => fetch('/api/formats').then((r) => json<{ export: string[]; views: string[] }>(r)),
  exports: (id: string) => fetch(`/api/projects/${enc(id)}/exports`).then((r) => json<ExportFile[]>(r)),
  thumbnailUrl: (id: string, rev: number) => `/api/projects/${enc(id)}/thumbnail.png?rev=${rev}`,
  frameUrl: (id: string, frame: number, rev: number, opts: { layers?: string[]; scale?: number } = {}) => {
    const q = new URLSearchParams({ rev: String(rev) });
    if (opts.layers) q.set('layers', opts.layers.join(','));
    if (opts.scale) q.set('scale', String(opts.scale));
    return `/api/projects/${enc(id)}/frames/${frame}.png?${q}`;
  },
  viewUrl: (id: string, view: string, rev: number, frame = 0, tag?: string) =>
    `/api/projects/${enc(id)}/view.png?view=${enc(view)}&frame=${frame}&rev=${rev}${tag ? `&tag=${enc(tag)}` : ''}`,
  exportFileUrl: (id: string, name: string) => `/api/projects/${enc(id)}/exports/${enc(name)}`,
  async download(id: string, opts: ExportOptions): Promise<{ blob: Blob; name: string }> {
    const res = await fetch(`/api/projects/${enc(id)}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(opts),
    });
    if (!res.ok) await json(res);
    const cd = res.headers.get('content-disposition') ?? '';
    const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? `${id}.${opts.format}`;
    return { blob: await res.blob(), name };
  },
};
