// 눌러서 여는 메뉴 버튼 (antd Dropdown 역할). <details> 로 만들어 JS 없이도 열리고 닫히며, 바깥을 누르면 닫힌다.
//   menuButton({ label, items: [{ key, label, hint, disabled, onClick }], disabled, className, kind })

import { el } from './dom.js';

let listening = false;
function closeOthers(event) {
  for (const open of document.querySelectorAll('details.menu[open]')) {
    if (!open.contains(event.target)) open.removeAttribute('open');
  }
}

export function menuButton({ label, items, disabled = false, className = '', kind = 'default', dataset = {} }) {
  if (!listening) {
    document.addEventListener('mousedown', closeOthers);
    listening = true;
  }
  const summary = el('summary', { className: `btn${kind === 'primary' ? ' btn-primary' : ''}`, role: 'button', 'aria-haspopup': 'menu' }, label, el('span', { className: 'menu-caret' }, '▾'));
  const list = el(
    'div',
    { className: 'menu-list', role: 'menu' },
    items.map((item) =>
      el(
        'button',
        {
          type: 'button',
          className: 'menu-item',
          role: 'menuitem',
          disabled: Boolean(item.disabled),
          dataset: { key: item.key ?? '' },
          onClick: () => {
            details.removeAttribute('open');
            if (item.onClick) item.onClick(item);
          },
        },
        item.label,
        item.hint ? el('span', { className: 'menu-hint' }, item.hint) : null,
      ),
    ),
  );
  const details = el('details', { className: `menu${disabled ? ' menu-disabled' : ''}${className ? ` ${className}` : ''}`, dataset }, summary, list);
  if (disabled) summary.addEventListener('click', (event) => event.preventDefault());
  return details;
}
