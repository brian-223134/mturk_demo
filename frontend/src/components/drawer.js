// 오른쪽에서 열리는 상세 창 (antd Drawer 역할). openDrawer({ title, extra, content, width }) → { root, body, setTitle, setExtra, close }.
// 모달과 같은 겹침 스택을 쓰므로 drawer 위에 모달을 열면 Escape 가 모달부터 닫는다.

import { append, el } from './dom.js';
import { pushOverlay } from './overlay.js';

const openDrawers = new Set();

export function openDrawer({ title, extra = [], content = [], width = 860, onClose, className = '' }) {
  let closed = false;
  const heading = el('h3', { className: 'drawer-title' }, title ?? '');
  const extraSlot = append(el('div', { className: 'drawer-extra' }), Array.isArray(extra) ? extra : [extra]);
  const body = append(el('div', { className: 'drawer-body' }), Array.isArray(content) ? content : [content]);
  const panel = el(
    'aside',
    { className: `drawer${className ? ` ${className}` : ''}`, role: 'dialog', 'aria-modal': 'true', tabindex: '-1', style: { width: `min(${width}px, 100vw)` } },
    el('div', { className: 'drawer-head' }, el('button', { type: 'button', className: 'drawer-close', 'aria-label': 'Close', onClick: () => close() }, '×'), heading, extraSlot),
    body,
  );
  const root = el('div', { className: 'drawer-backdrop' }, panel);
  root.addEventListener('mousedown', (event) => {
    if (event.target === root) close();
  });

  function close() {
    if (closed) return;
    closed = true;
    unregister();
    openDrawers.delete(handle);
    root.remove();
    if (typeof onClose === 'function') onClose();
  }

  const handle = {
    root,
    body,
    close,
    setTitle: (text) => (heading.textContent = text),
    setExtra: (nodes) => {
      extraSlot.replaceChildren();
      append(extraSlot, Array.isArray(nodes) ? nodes : [nodes]);
    },
    setContent: (nodes) => {
      body.replaceChildren();
      append(body, Array.isArray(nodes) ? nodes : [nodes]);
    },
  };
  const unregister = pushOverlay({ close, canClose: () => true });
  openDrawers.add(handle);
  document.body.append(root);
  panel.focus();
  return handle;
}

export function closeAllDrawers() {
  for (const handle of [...openDrawers]) handle.close();
}
