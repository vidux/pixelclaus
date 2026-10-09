import { api, type ExportOptions, type ProjectDetail } from '../api.js';
import { bytes, clear, h, timeAgo, toast } from '../dom.js';
import { openModal } from './modal.js';

const FORMATS: Array<{
  value: string;
  label: string;
  kind: 'still' | 'anim' | 'sheet' | 'file' | 'palette';
}> = [
  { value: 'png', label: 'PNG image', kind: 'still' },
  { value: 'gif', label: 'GIF animation', kind: 'anim' },
  { value: 'apng', label: 'APNG animation', kind: 'anim' },
  { value: 'webp_animated', label: 'Animated WebP', kind: 'anim' },
  { value: 'spritesheet', label: 'Sprite sheet + JSON', kind: 'sheet' },
  { value: 'frames', label: 'PNG sequence (zip)', kind: 'anim' },
  { value: 'webp', label: 'WebP image', kind: 'still' },
  { value: 'jpg', label: 'JPG image', kind: 'still' },
  { value: 'aseprite', label: 'Aseprite (.aseprite)', kind: 'file' },
  { value: 'pxc', label: 'PixelClaus backup (.pxc)', kind: 'file' },
  { value: 'palette', label: 'Palette file', kind: 'palette' },
];

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h(
    'label',
    { class: 'form-field' },
    h('span', {}, label),
    control,
    hint ? h('small', { class: 'muted' }, hint) : null,
  );
}

export function exportDialog(p: ProjectDetail): void {
  const format = h('select', {}, ...FORMATS.map((f) => h('option', { value: f.value }, f.label)));
  const scale = h(
    'select',
    {},
    ...[1, 2, 3, 4, 6, 8, 10, 16].map((s) => h('option', { value: String(s) }, `${s}×`)),
  );
  const frame = h(
    'select',
    {},
    ...p.durations.map((_, i) => h('option', { value: String(i) }, `Frame ${i}`)),
  );
  const tag = h(
    'select',
    {},
    h('option', { value: '' }, 'All frames'),
    ...p.tags.map((t) => h('option', { value: t.name }, t.name)),
    p.tags.length ? h('option', { value: '__split' }, 'Each tag separately') : null,
  );
  const bgOn = h('input', { type: 'checkbox' });
  const bg = h('input', { type: 'color', value: '#1a1c2c' });
  const trim = h('input', { type: 'checkbox' });
  const splitLayers = h('input', { type: 'checkbox' });
  const layout = h(
    'select',
    {},
    ...['horizontal', 'vertical', 'grid', 'rows', 'packed'].map((l) => h('option', { value: l }, l)),
  );
  const padding = h('input', { type: 'number', min: '0', max: '16', value: '0' });
  const json = h(
    'select',
    {},
    ...['aseprite-hash', 'aseprite-array', 'texturepacker', 'none'].map((j) => h('option', { value: j }, j)),
  );
  const palFmt = h(
    'select',
    {},
    ...['hex', 'gpl', 'pal', 'act'].map((f) => h('option', { value: f }, `.${f}`)),
  );
  const exportsList = h('div', { class: 'exports-list' });

  const rows = {
    scale: field('Scale', scale, 'Nearest-neighbour, whole numbers only'),
    frame: field('Frame', frame),
    tag: field('Animation', tag),
    bg: h('label', { class: 'form-check' }, bgOn, 'Solid background', bg),
    trim: h('label', { class: 'form-check' }, trim, 'Trim to content'),
    split: h('label', { class: 'form-check' }, splitLayers, 'One file per layer'),
    layout: field('Layout', layout),
    padding: field('Padding', padding),
    json: field('JSON atlas', json),
    pal: field('Palette format', palFmt),
  };
  const body = h(
    'div',
    { class: 'form' },
    field('Format', format),
    ...Object.values(rows),
    h('h3', {}, 'Previous exports'),
    exportsList,
  );

  function sync(): void {
    const kind = FORMATS.find((f) => f.value === format.value)!.kind;
    const show = (el: HTMLElement, on: boolean) => (el.hidden = !on);
    show(rows.scale, kind !== 'file' && kind !== 'palette');
    show(rows.frame, kind === 'still');
    show(rows.tag, kind === 'anim' || kind === 'sheet');
    show(rows.bg, kind !== 'file' && kind !== 'palette');
    show(rows.trim, kind === 'still');
    show(rows.split, kind === 'still' || format.value === 'frames');
    show(rows.layout, kind === 'sheet');
    show(rows.padding, kind === 'sheet');
    show(rows.json, kind === 'sheet');
    show(rows.pal, kind === 'palette');
    if (format.value === 'jpg') bgOn.checked = true;
  }
  format.addEventListener('change', sync);
  sync();

  async function loadExports(): Promise<void> {
    try {
      const files = await api.exports(p.id);
      clear(exportsList);
      if (!files.length)
        exportsList.append(
          h('p', { class: 'muted small' }, 'Files Claude exports into the project folder show up here.'),
        );
      for (const f of files.slice(0, 20)) {
        exportsList.append(
          h(
            'a',
            { class: 'export-row', href: api.exportFileUrl(p.id, f.name), download: f.name },
            h('span', { class: 'mono' }, f.name),
            h('span', { class: 'muted small' }, `${bytes(f.bytes)} · ${timeAgo(f.modified)}`),
          ),
        );
      }
    } catch {
      // ignore
    }
  }
  void loadExports();

  const go = h(
    'button',
    {
      class: 'btn primary',
      onclick: async () => {
        const opts: ExportOptions = { format: format.value, scale: Number(scale.value) };
        const kind = FORMATS.find((f) => f.value === format.value)!.kind;
        if (kind === 'still') opts.frame = Number(frame.value);
        if (kind === 'anim' || kind === 'sheet') {
          if (tag.value === '__split') opts.splitTags = true;
          else if (tag.value) opts.tag = tag.value;
        }
        if (bgOn.checked) opts.background = bg.value;
        if (trim.checked && kind === 'still') opts.trim = true;
        if (splitLayers.checked) opts.splitLayers = true;
        if (kind === 'sheet')
          opts.sheet = { layout: layout.value, padding: Number(padding.value), json: json.value };
        if (kind === 'palette') opts.paletteFormat = palFmt.value;
        go.setAttribute('disabled', '');
        go.textContent = 'Exporting…';
        try {
          const { blob, name } = await api.download(p.id, opts);
          const url = URL.createObjectURL(blob);
          const a = h('a', { href: url, download: name });
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
          toast(`Downloaded ${name}`);
          m.close();
        } catch (err) {
          toast((err as Error).message, 'error');
          go.removeAttribute('disabled');
          go.textContent = 'Download';
        }
      },
    },
    'Download',
  );
  const m = openModal(`Export “${p.name}”`, body, [
    h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
    go,
  ]);
}
