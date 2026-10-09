import { api, type ProjectListing } from '../api.js';
import { clear, h, icon, timeAgo, toast } from '../dom.js';
import { confirmDialog } from './modal.js';

/** Project grid with search and live refresh. */
export function projectsView(root: HTMLElement): () => void {
  let projects: ProjectListing[] = [];
  let filter = '';
  let signature = '';
  const grid = h('div', { class: 'grid', role: 'list' });
  const count = h('span', { class: 'muted' });
  const search = h('input', {
    type: 'search',
    class: 'search',
    placeholder: 'Filter projects',
    'aria-label': 'Filter projects',
    oninput: (e: Event) => {
      filter = (e.target as HTMLInputElement).value.toLowerCase();
      render();
    },
  });
  clear(root);
  root.append(
    h(
      'section',
      { class: 'page' },
      h(
        'div',
        { class: 'toolbar' },
        h('h1', {}, 'Projects'),
        count,
        h('div', { class: 'spacer' }),
        search,
        h(
          'button',
          { class: 'icon-btn', title: 'Refresh', 'aria-label': 'Refresh', onclick: () => load(true) },
          icon('refresh'),
        ),
      ),
      grid,
    ),
  );

  function card(p: ProjectListing): HTMLElement {
    const del = h(
      'button',
      {
        class: 'icon-btn card-delete',
        title: `Delete ${p.name}`,
        'aria-label': `Delete ${p.name}`,
        onclick: async (e: Event) => {
          e.preventDefault();
          e.stopPropagation();
          if (
            !(await confirmDialog(
              'Delete project?',
              `"${p.name}" and all its checkpoints and exports will be permanently deleted.`,
              'Delete',
            ))
          )
            return;
          try {
            await api.remove(p.id);
            toast(`Deleted ${p.name}`);
            await load(true);
          } catch (err) {
            toast((err as Error).message, 'error');
          }
        },
      },
      icon('trash'),
    );
    return h(
      'a',
      { class: 'card', href: `#/p/${encodeURIComponent(p.id)}`, role: 'listitem' },
      h(
        'div',
        { class: 'thumb checker' },
        h('img', { src: api.thumbnailUrl(p.id, p.revision), alt: `${p.name} preview`, loading: 'lazy' }),
      ),
      h(
        'div',
        { class: 'card-body' },
        h('div', { class: 'card-title' }, h('strong', {}, p.name), del),
        h(
          'div',
          { class: 'meta' },
          `${p.width}×${p.height} · ${p.frames} frame${p.frames === 1 ? '' : 's'} · ${p.layers} layer${p.layers === 1 ? '' : 's'}`,
        ),
        h('div', { class: 'meta muted' }, `${p.colorMode} · ${timeAgo(p.modified)}`),
        p.tags.length
          ? h('div', { class: 'chips' }, ...p.tags.slice(0, 4).map((t) => h('span', { class: 'chip' }, t)))
          : null,
      ),
    );
  }

  function render(): void {
    clear(grid);
    const shown = projects.filter(
      (p) => !filter || p.name.toLowerCase().includes(filter) || p.id.includes(filter),
    );
    count.textContent = projects.length ? `${projects.length} total` : '';
    if (!projects.length) {
      grid.append(
        h(
          'div',
          { class: 'empty' },
          h('h2', {}, 'No projects yet'),
          h(
            'p',
            {},
            'Ask Claude to create one — for example: “Create a 32×32 knight sprite with an idle animation.” Projects appear here automatically.',
          ),
        ),
      );
      return;
    }
    if (!shown.length)
      grid.append(h('div', { class: 'empty' }, h('p', {}, `No projects match “${filter}”.`)));
    for (const p of shown) grid.append(card(p));
  }

  async function load(force = false): Promise<void> {
    try {
      const list = await api.list();
      const sig = list.map((p) => `${p.id}:${p.revision}`).join('|');
      if (!force && sig === signature) return;
      signature = sig;
      projects = list;
      render();
    } catch (err) {
      if (force) toast((err as Error).message, 'error');
    }
  }

  void load(true);
  const timer = window.setInterval(() => void load(), 3000);
  return () => window.clearInterval(timer);
}
