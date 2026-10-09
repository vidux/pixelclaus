import { api, type LayerSummary, type ProjectDetail, type TagSummary } from '../api.js';
import { clear, h, icon, timeAgo, toast } from '../dom.js';
import { exportDialog } from './export-dialog.js';
import { confirmDialog } from './modal.js';

type Backdrop = 'checker' | 'dark' | 'light';

function playbackOrder(p: ProjectDetail, tag: TagSummary | null): number[] {
  if (!tag) return p.durations.map((_, i) => i);
  const fwd = Array.from({ length: tag.to - tag.from + 1 }, (_, i) => tag.from + i);
  const pp = (a: number[]) => (a.length <= 1 ? a : [...a, ...a.slice(1, -1).reverse()]);
  switch (tag.direction) {
    case 'reverse':
      return [...fwd].reverse();
    case 'pingpong':
      return pp(fwd);
    case 'pingpong_reverse':
      return pp([...fwd].reverse());
    default:
      return fwd;
  }
}

/** Top → bottom order with depth (like a layer panel). */
function panelOrder(layers: LayerSummary[]): LayerSummary[] {
  const byParent = new Map<string | null, LayerSummary[]>();
  for (const l of layers) byParent.set(l.parentId, [...(byParent.get(l.parentId) ?? []), l]);
  const out: LayerSummary[] = [];
  const rec = (pid: string | null) => {
    for (const l of [...(byParent.get(pid) ?? [])].reverse()) {
      out.push(l);
      if (l.type === 'group') rec(l.id);
    }
  };
  rec(null);
  return out;
}

export function projectView(root: HTMLElement, id: string): () => void {
  let p: ProjectDetail | null = null;
  let tag: TagSummary | null = null;
  let order: number[] = [];
  let pos = 0;
  let playing = true;
  let zoom = 0; // 0 = fit
  let backdrop: Backdrop = 'checker';
  let hidden = new Set<string>();
  let timer: number | undefined;
  let alive = true;
  const images = new Map<string, HTMLImageElement>();

  const canvas = h('canvas', { class: 'stage-canvas', 'aria-label': 'Animation preview' });
  const stage = h('div', { class: 'stage checker' }, canvas);
  const frameLabel = h('span', { class: 'mono' });
  const playBtn = h('button', {
    class: 'icon-btn',
    'aria-label': 'Play/pause',
    onclick: () => setPlaying(!playing),
  });
  const strip = h('div', { class: 'strip', role: 'listbox', 'aria-label': 'Frames' });
  const tagSelect = h('select', {
    'aria-label': 'Animation tag',
    onchange: (e: Event) => selectTag((e.target as HTMLSelectElement).value),
  });
  const zoomSelect = h(
    'select',
    {
      'aria-label': 'Zoom',
      onchange: (e: Event) => ((zoom = Number((e.target as HTMLSelectElement).value)), draw()),
    },
    h('option', { value: '0' }, 'Fit'),
    ...[1, 2, 4, 8, 16].map((z) => h('option', { value: String(z) }, `${z}×`)),
  );
  const bgSelect = h(
    'select',
    {
      'aria-label': 'Backdrop',
      onchange: (e: Event) => setBackdrop((e.target as HTMLSelectElement).value as Backdrop),
    },
    h('option', { value: 'checker' }, 'Checker'),
    h('option', { value: 'dark' }, 'Dark'),
    h('option', { value: 'light' }, 'Light'),
  );
  const layersPanel = h('div', { class: 'panel-body' });
  const infoPanel = h('div', { class: 'panel-body' });
  const title = h('h1', {}, id);
  const sub = h('span', { class: 'muted' });

  clear(root);
  root.append(
    h(
      'section',
      { class: 'page project' },
      h(
        'div',
        { class: 'toolbar' },
        h('a', { class: 'icon-btn', href: '#/', 'aria-label': 'Back to projects' }, icon('back')),
        title,
        sub,
        h('div', { class: 'spacer' }),
        h(
          'button',
          { class: 'btn primary', onclick: () => p && exportDialog(p) },
          icon('download'),
          'Export',
        ),
        h('button', { class: 'btn danger-ghost', onclick: () => void remove() }, icon('trash'), 'Delete'),
      ),
      h(
        'div',
        { class: 'layout' },
        h(
          'div',
          { class: 'main-col' },
          stage,
          h(
            'div',
            { class: 'controls' },
            h(
              'button',
              { class: 'icon-btn', 'aria-label': 'Previous frame', onclick: () => step(-1) },
              icon('stepback'),
            ),
            playBtn,
            h(
              'button',
              { class: 'icon-btn', 'aria-label': 'Next frame', onclick: () => step(1) },
              icon('step'),
            ),
            frameLabel,
            h('div', { class: 'spacer' }),
            h('label', { class: 'field' }, 'Tag', tagSelect),
            h('label', { class: 'field' }, 'Zoom', zoomSelect),
            h('label', { class: 'field' }, 'Backdrop', bgSelect),
          ),
          strip,
        ),
        h(
          'aside',
          { class: 'side-col' },
          h('div', { class: 'panel' }, h('h2', {}, 'Layers'), layersPanel),
          h('div', { class: 'panel' }, h('h2', {}, 'Details'), infoPanel),
        ),
      ),
    ),
  );

  function isolate(): string[] | undefined {
    if (!p) return undefined;
    const fileVisible = p.layers.filter((l) => l.type !== 'group' && l.visible).map((l) => l.id);
    if (!hidden.size) return undefined;
    const ids = fileVisible.filter((lid) => !hidden.has(lid));
    return ids.length ? ids : ['__none__'];
  }

  function frameImage(f: number): HTMLImageElement {
    const iso = isolate();
    const url = iso?.[0] === '__none__' ? '' : api.frameUrl(id, f, p!.revision, { layers: iso });
    let img = images.get(url);
    if (!img) {
      img = new Image();
      img.decoding = 'async';
      if (url) img.src = url;
      img.onload = () => {
        if (order[pos] === f) draw();
      };
      images.set(url, img);
    }
    return img;
  }

  function draw(): void {
    if (!p) return;
    const f = order[pos] ?? 0;
    const avail = stage.clientWidth - 24;
    const availH = Math.max(160, window.innerHeight * 0.55);
    const z = zoom || Math.max(1, Math.floor(Math.min(avail / p.width, availH / p.height)));
    canvas.width = p.width * z;
    canvas.height = p.height * z;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const img = frameImage(f);
    if (img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    frameLabel.textContent = `frame ${f} · ${p.durations[f]} ms`;
    strip
      .querySelectorAll('.frame-cell')
      .forEach((el) => el.classList.toggle('active', Number((el as HTMLElement).dataset.frame) === f));
  }

  function schedule(): void {
    window.clearTimeout(timer);
    if (!playing || !p || order.length < 2) return;
    timer = window.setTimeout(() => {
      pos = (pos + 1) % order.length;
      draw();
      schedule();
    }, p.durations[order[pos]!] ?? 100);
  }

  function setPlaying(v: boolean): void {
    const was = playing;
    playing = v;
    playBtn.replaceChildren(icon(playing ? 'pause' : 'play'));
    if (was && !playing) renderLayers();
    schedule();
  }

  function step(d: number): void {
    setPlaying(false);
    pos = (pos + d + order.length) % order.length;
    draw();
    renderLayers();
  }

  function setBackdrop(b: Backdrop): void {
    backdrop = b;
    stage.className = `stage ${b === 'checker' ? 'checker' : b}`;
  }

  function selectTag(name: string): void {
    tag = p?.tags.find((t) => t.name === name) ?? null;
    order = p ? playbackOrder(p, tag) : [];
    pos = 0;
    renderStrip();
    draw();
    schedule();
  }

  function renderStrip(): void {
    if (!p) return;
    clear(strip);
    const inTag = new Set(order);
    p.durations.forEach((d, f) => {
      const t = p!.tags.find((x) => f >= x.from && f <= x.to);
      strip.append(
        h(
          'button',
          {
            class: `frame-cell${inTag.has(f) ? '' : ' dim'}`,
            'data-frame': String(f),
            role: 'option',
            title: `Frame ${f} · ${d} ms${t ? ` · ${t.name}` : ''}`,
            onclick: () => {
              setPlaying(false);
              const i = order.indexOf(f);
              if (i >= 0) pos = i;
              else {
                selectTag('');
                pos = f;
              }
              draw();
              renderLayers();
            },
          },
          h('img', { src: api.frameUrl(id, f, p!.revision), alt: '' }),
          h('span', { class: 'mono' }, `${f}`),
          h('span', { class: 'muted mono' }, `${d}`),
          t ? h('i', { class: 'tag-bar', style: `background:${t.color}` }) : null,
        ),
      );
    });
  }

  function renderLayers(): void {
    if (!p) return;
    clear(layersPanel);
    const f = order[pos] ?? 0;
    for (const l of panelOrder(p.layers)) {
      const off = !l.visible || hidden.has(l.id);
      const toggle =
        l.type === 'group'
          ? h('span', { class: 'icon-spacer' })
          : h(
              'button',
              {
                class: 'icon-btn small',
                'aria-label': `${off ? 'Show' : 'Hide'} ${l.name} in preview`,
                title: l.visible ? 'Toggle in preview (does not change the file)' : 'Hidden in the file',
                disabled: !l.visible,
                onclick: () => {
                  if (hidden.has(l.id)) hidden.delete(l.id);
                  else hidden.add(l.id);
                  renderLayers();
                  draw();
                },
              },
              icon(off ? 'eyeoff' : 'eye'),
            );
      const badges = [
        l.type !== 'image' ? l.type : '',
        l.isBackground ? 'background' : '',
        !l.visible ? 'hidden' : '',
        l.opacity !== 255 ? `${Math.round((l.opacity / 255) * 100)}%` : '',
        l.blendMode !== 'normal' ? l.blendMode : '',
        l.links.length ? 'linked' : '',
      ].filter(Boolean);
      layersPanel.append(
        h(
          'div',
          { class: `layer-row${off ? ' off' : ''}`, style: `padding-left:${8 + l.depth * 16}px` },
          toggle,
          l.type === 'group'
            ? h('span', { class: 'layer-thumb group' }, icon('folder'))
            : h('img', {
                class: 'layer-thumb checker',
                src: api.frameUrl(id, f, p.revision, { layers: [l.id] }),
                alt: '',
              }),
          h(
            'div',
            { class: 'layer-text' },
            h('span', { class: 'layer-name' }, l.name, l.locked ? icon('lock') : null),
            h(
              'span',
              { class: 'muted small' },
              `${l.id} · ${l.type === 'group' ? 'group' : `${l.celFrames.length} cel${l.celFrames.length === 1 ? '' : 's'}`}`,
            ),
          ),
          h('div', { class: 'chips' }, ...badges.map((b) => h('span', { class: 'chip' }, b))),
        ),
      );
    }
  }

  function renderInfo(): void {
    if (!p) return;
    clear(infoPanel);
    const row = (k: string, v: Node | string) =>
      h(
        'div',
        { class: 'kv' },
        h('span', { class: 'muted' }, k),
        typeof v === 'string' ? h('span', {}, v) : v,
      );
    const swatches = h(
      'div',
      { class: 'swatches' },
      ...p.paletteColors.slice(1).map((c) =>
        h('span', {
          class: 'swatch',
          style: `background:${c.hex}`,
          title: `${c.index} ${c.hex}${c.name ? ` ${c.name}` : ''}`,
        }),
      ),
    );
    infoPanel.append(
      row('Size', `${p.width} × ${p.height} px`),
      row('Colour mode', p.colorMode),
      row('Frames', `${p.frameCount} · ${p.totalDuration} ms total`),
      row(
        'Tags',
        p.tags.length
          ? h(
              'div',
              { class: 'chips' },
              ...p.tags.map((t) =>
                h('span', { class: 'chip', style: `border-color:${t.color}` }, `${t.name} ${t.from}–${t.to}`),
              ),
            )
          : 'none',
      ),
      row('Slices', p.slices.length ? p.slices.map((s) => s.name).join(', ') : 'none'),
      row('Checkpoints', p.checkpoints.length ? p.checkpoints.map((c) => c.name).join(', ') : 'none'),
      row('Modified', timeAgo(p.modified)),
      h('div', { class: 'palette-head muted' }, `Palette · ${p.palette.name} (${p.palette.size})`),
      swatches,
    );
    if (p.notes) infoPanel.append(h('p', { class: 'notes' }, p.notes));
  }

  async function load(initial = false): Promise<void> {
    try {
      const next = await api.get(id);
      if (!alive) return;
      if (!initial && p && next.revision === p.revision) return;
      p = next;
      images.clear();
      title.textContent = p.name;
      sub.textContent = `${p.width}×${p.height} · rev ${p.revision}`;
      document.title = `${p.name} · PixelClaus`;
      const currentTag = tag?.name ?? '';
      clear(tagSelect);
      tagSelect.append(
        h('option', { value: '' }, 'All frames'),
        ...p.tags.map((t) => h('option', { value: t.name }, `${t.name} (${t.direction})`)),
      );
      tagSelect.value = p.tags.some((t) => t.name === currentTag) ? currentTag : '';
      tag = p.tags.find((t) => t.name === tagSelect.value) ?? null;
      order = playbackOrder(p, tag);
      if (pos >= order.length) pos = 0;
      hidden = new Set([...hidden].filter((lid) => p!.layers.some((l) => l.id === lid)));
      renderStrip();
      renderLayers();
      renderInfo();
      draw();
      if (initial) setPlaying(true);
      else schedule();
    } catch (err) {
      if (initial) {
        clear(root);
        root.append(
          h(
            'section',
            { class: 'page' },
            h(
              'div',
              { class: 'empty' },
              h('h2', {}, 'Project not found'),
              h('p', {}, (err as Error).message),
              h('a', { class: 'btn', href: '#/' }, 'Back to projects'),
            ),
          ),
        );
        alive = false;
      }
    }
  }

  async function remove(): Promise<void> {
    if (!p) return;
    if (
      !(await confirmDialog(
        'Delete project?',
        `"${p.name}" and all its checkpoints and exports will be permanently deleted.`,
        'Delete',
      ))
    )
      return;
    try {
      await api.remove(id);
      toast(`Deleted ${p.name}`);
      location.hash = '#/';
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  const onResize = () => draw();
  window.addEventListener('resize', onResize);
  setBackdrop(backdrop);
  void load(true);
  const poll = window.setInterval(() => void load(), 2500);
  return () => {
    alive = false;
    window.clearTimeout(timer);
    window.clearInterval(poll);
    window.removeEventListener('resize', onResize);
  };
}
