// 표 도우미. columns: { title, tooltip, align: 'right'|'center', width, render(row, index) → Node|string|number, className }
// 데이터 행에는 data-row="<키>" 가 붙고, 비어 있을 때의 안내 행에는 붙지 않는다 (행 수를 셀 때 구분).

import { el } from './dom.js';

export function table({ columns, rows, rowKey, rowAttrs, empty = 'No data', className = '' }) {
  const head = el(
    'tr',
    {},
    columns.map((c) =>
      el(
        'th',
        { className: c.align ? `align-${c.align}` : null, title: c.tooltip, style: c.width ? { width: `${c.width}px` } : null },
        c.title,
      ),
    ),
  );
  const body = el('tbody');
  if (rows.length === 0) {
    body.append(el('tr', { className: 'table-empty' }, el('td', { colspan: String(columns.length) }, empty)));
  }
  rows.forEach((row, index) => {
    const tr = el('tr', rowAttrs ? rowAttrs(row, index) : {});
    tr.dataset.row = rowKey ? String(rowKey(row, index)) : String(index);
    for (const c of columns) {
      const value = c.render ? c.render(row, index) : row[c.key];
      const classes = [c.align ? `align-${c.align}` : '', c.className ?? ''].filter(Boolean).join(' ') || null;
      tr.append(el('td', { className: classes }, value === undefined || value === null ? '' : value));
    }
    body.append(tr);
  });
  return el('table', { className: `table${className ? ` ${className}` : ''}` }, el('thead', {}, head), body);
}

/** 숫자 셀. 자릿수가 맞게 고정폭 숫자를 쓴다. */
export function num(value) {
  return el('span', { className: 'tabular' }, value === null || value === undefined ? '' : String(value));
}

/** "Showing 1–25 of 40" 과 Prev / Next 버튼. onChange(page) 로 페이지를 바꾼다. */
export function pager({ page, pageSize, total, onChange, unit = 'rows' }) {
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  return el(
    'div',
    { className: 'pager' },
    el('span', { className: 'muted' }, total === 0 ? `0 ${unit}` : `Showing ${first}–${last} of ${total} ${unit}`),
    el('button', { type: 'button', className: 'btn btn-small', disabled: page <= 1, onClick: () => onChange(page - 1) }, 'Prev'),
    el('span', { className: 'muted' }, `Page ${page} / ${lastPage}`),
    el('button', { type: 'button', className: 'btn btn-small', disabled: page >= lastPage, onClick: () => onChange(page + 1) }, 'Next'),
  );
}
