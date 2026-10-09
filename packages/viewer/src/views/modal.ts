import { h } from '../dom.js';

/** Accessible modal dialog using <dialog>. Resolves when closed. */
export function openModal(
  title: string,
  body: Node,
  actions: HTMLElement[],
): { dialog: HTMLDialogElement; close: () => void } {
  const dialog = h('dialog', { class: 'modal', 'aria-labelledby': 'modal-title' });
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  dialog.append(
    h(
      'header',
      { class: 'modal-head' },
      h('h2', { id: 'modal-title' }, title),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '×'),
    ),
    h('div', { class: 'modal-body' }, body),
    h('footer', { class: 'modal-actions' }, ...actions),
  );
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close };
}

export function confirmDialog(title: string, message: string, confirmLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const cancel = h('button', { class: 'btn', onclick: () => finish(false) }, 'Cancel');
    const ok = h('button', { class: 'btn danger', onclick: () => finish(true) }, confirmLabel);
    const m = openModal(title, h('p', {}, message), [cancel, ok]);
    m.dialog.addEventListener('close', () => finish(false));
    cancel.focus();
  });
}
