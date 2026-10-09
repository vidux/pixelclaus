import './styles.css';
import { h } from './dom.js';
import { projectView } from './views/project.js';
import { projectsView } from './views/projects.js';

const app = document.getElementById('app')!;
const header = h(
  'header',
  { class: 'app-header' },
  h(
    'a',
    { class: 'brand', href: '#/' },
    h('img', { src: '/favicon.svg', alt: '', width: 20, height: 20 }),
    'PixelClaus',
  ),
  h('span', { class: 'muted small' }, 'Viewer — Claude designs, you review and export'),
);
const main = h('main', { id: 'main' });
app.append(header, main);

let dispose: (() => void) | null = null;
function route(): void {
  dispose?.();
  const m = /^#\/p\/([^/?]+)/.exec(location.hash);
  dispose = m ? projectView(main, decodeURIComponent(m[1]!)) : projectsView(main);
  if (!m) document.title = 'PixelClaus Viewer';
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
route();
