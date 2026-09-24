// 짧은 알림 (antd 의 message 와 notification 역할). 오른쪽 위에 쌓이고 몇 초 뒤에 사라진다. 오류는 제목과 설명을 함께 쓴다.
//   toast.success('Rejected 2 assignment(s).'), toast.info(...), toast.warning(...), toast.error('Reject failed', error.message)

import { el } from './dom.js';

const DURATION_MS = { success: 4000, info: 4000, warning: 6000, error: 10000 };

function container() {
  let node = document.getElementById('toasts');
  if (!node) {
    node = el('div', { id: 'toasts', className: 'toasts', 'aria-live': 'polite' });
    document.body.append(node);
  }
  return node;
}

function show(kind, title, description) {
  const node = el(
    'div',
    { className: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status', dataset: { kind } },
    el('div', { className: 'toast-title' }, title),
    description ? el('div', { className: 'toast-message' }, description) : null,
  );
  const remove = () => node.remove();
  node.addEventListener('click', remove);
  container().append(node);
  setTimeout(remove, DURATION_MS[kind] ?? 4000);
  return node;
}

export const toast = {
  success: (text) => show('success', text),
  info: (text) => show('info', text),
  warning: (text) => show('warning', text),
  error: (title, description) => show('error', title, description),
};
