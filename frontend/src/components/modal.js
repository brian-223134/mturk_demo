// 모달 창. document.body 에 붙이고 handle 로 닫는다. 버튼의 onClick 이 Promise 를 돌려주면 끝날 때까지 모든 버튼을 잠근다 (confirmLoading).
//   openModal({ title, width, content, buttons: [{ key, label, kind, onClick, disabled, autofocus }], onClose, closable })
//   confirmModal({ title, message, okText, cancelText, danger }) → Promise<boolean>
//   infoModal({ title, lines }) 는 "알림" 창이다. 페이지 이동 때는 closeAllModals 로 정리한다.

import { append, el } from './dom.js';
import { pushOverlay } from './overlay.js';
import { toast } from './toast.js';

const openModals = new Set();

const BUTTON_CLASS = { primary: 'btn btn-primary', danger: 'btn btn-danger', default: 'btn', link: 'btn btn-link' };

export function openModal({ title, width = 520, content = [], buttons = [], onClose, closable = true, className = '' }) {
  let closed = false;
  let busy = false;
  const buttonNodes = new Map();

  const heading = el('h3', { className: 'modal-title', id: `modal-title-${Math.random().toString(36).slice(2, 8)}` }, title ?? '');
  const closeButton = el('button', { type: 'button', className: 'modal-close', 'aria-label': 'Close', onClick: () => canClose() && close() }, '×');
  const body = append(el('div', { className: 'modal-body' }), Array.isArray(content) ? content : [content]);
  const footer = el('div', { className: 'modal-footer' });
  const box = el(
    'div',
    { className: `modal${className ? ` ${className}` : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': heading.id, tabindex: '-1', style: { width: `${width}px` } },
    el('div', { className: 'modal-head' }, heading, closable ? closeButton : null),
    body,
    footer,
  );
  const root = el('div', { className: 'modal-backdrop' }, box);
  root.addEventListener('mousedown', (event) => {
    if (event.target === root && canClose()) close();
  });

  function canClose() {
    return closable && !busy;
  }

  function setBusy(next, activeKey = null) {
    busy = next;
    box.classList.toggle('modal-busy', next);
    for (const [key, node] of buttonNodes) {
      const spec = node.spec;
      node.disabled = next || Boolean(spec.disabled);
      node.classList.toggle('btn-loading', next && key === activeKey);
    }
  }

  function close(result) {
    if (closed) return;
    closed = true;
    unregister();
    openModals.delete(handle);
    root.remove();
    if (typeof onClose === 'function') onClose(result);
  }

  function setButton(key, patch) {
    const node = buttonNodes.get(key);
    if (!node) return;
    Object.assign(node.spec, patch);
    if (patch.label !== undefined) node.textContent = patch.label;
    if (patch.disabled !== undefined) node.disabled = busy || Boolean(patch.disabled);
  }

  for (const spec of buttons) {
    const node = el('button', { type: 'button', className: BUTTON_CLASS[spec.kind ?? 'default'], disabled: Boolean(spec.disabled), autofocus: spec.autofocus, dataset: { key: spec.key ?? '' } }, spec.label);
    node.spec = { ...spec };
    node.addEventListener('click', () => {
      if (busy) return;
      const fn = node.spec.onClick;
      if (!fn) {
        close();
        return;
      }
      let result;
      try {
        result = fn(handle);
      } catch (error) {
        toast.error('Action failed', error instanceof Error ? error.message : String(error));
        return;
      }
      if (result && typeof result.then === 'function') {
        setBusy(true, spec.key);
        result
          .catch((error) => toast.error('Action failed', error instanceof Error ? error.message : String(error)))
          .finally(() => {
            if (!closed) setBusy(false);
          });
      }
    });
    buttonNodes.set(spec.key ?? spec.label, node);
    footer.append(node);
  }
  if (buttons.length === 0) footer.remove();

  const handle = { root, box, body, footer, close, setBusy, setButton, setTitle: (text) => (heading.textContent = text), get busy() { return busy; } };
  const unregister = pushOverlay({ close, canClose });
  openModals.add(handle);
  document.body.append(root);
  const focusTarget = box.querySelector('[autofocus]') ?? box.querySelector('input, textarea, select') ?? box;
  focusTarget.focus();
  return handle;
}

/** 확인 창. 확인하면 true, 취소하거나 닫으면 false. */
export function confirmModal({ title, message, okText = 'OK', cancelText = 'Cancel', danger = false, width = 480 }) {
  return new Promise((resolve) => {
    let answer = false;
    openModal({
      title,
      width,
      className: 'modal-confirm',
      content: typeof message === 'string' ? el('p', { className: 'modal-text' }, message) : message,
      buttons: [
        { key: 'cancel', label: cancelText, onClick: (h) => h.close() },
        { key: 'ok', label: okText, kind: danger ? 'danger' : 'primary', autofocus: true, onClick: (h) => { answer = true; h.close(); } },
      ],
      onClose: () => resolve(answer),
    });
  });
}

/** 알림 창. lines 는 문단 목록이다. */
export function infoModal({ title, lines = [], okText = 'OK', width = 520 }) {
  return openModal({
    title,
    width,
    className: 'modal-info',
    content: lines.map((line) => el('p', { className: 'modal-text' }, line)),
    buttons: [{ key: 'ok', label: okText, kind: 'primary', autofocus: true, onClick: (h) => h.close() }],
  });
}

export function closeAllModals() {
  for (const handle of [...openModals]) handle.close();
}
