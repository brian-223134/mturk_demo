// 표 도우미. columns: { title, tooltip, align: 'right'|'center', width, render(row, index) → Node|string|number, className,
//   sortKey (있으면 머리글을 눌러 정렬), sortDefault: 'asc'|'desc' (처음 누를 때의 방향) }
// 선택적으로 정렬(sort, onSort), 체크박스 선택(selection), 행 클릭(onRowClick)을 붙인다. 없으면 예전과 같은 표다.
// 데이터 행에는 data-row="<키>" 가 붙고, 비어 있을 때의 안내 행에는 붙지 않는다 (행 수를 셀 때 구분).

import { el } from './dom.js';

const ROW_CLICK_IGNORE = 'a, button, input, select, textarea, label, summary, .no-row-click';

function headerCell(c, sort, onSort) {
  const sortable = Boolean(c.sortKey && onSort);
  const active = sortable && sort?.field === c.sortKey;
  const th = el(
    'th',
    {
      className: [c.align ? `align-${c.align}` : '', sortable ? 'sortable' : '', active ? 'sorted' : ''].filter(Boolean).join(' ') || null,
      title: c.tooltip,
      style: c.width ? { width: `${c.width}px` } : null,
      'aria-sort': active ? (sort.order === 'asc' ? 'ascending' : 'descending') : null,
      dataset: sortable ? { sortKey: c.sortKey } : undefined,
    },
    c.title,
    sortable ? el('span', { className: 'sort-indicator', 'aria-hidden': 'true' }, active ? (sort.order === 'asc' ? '▲' : '▼') : '⇅') : null,
  );
  if (sortable) {
    th.addEventListener('click', () => {
      const order = active ? (sort.order === 'asc' ? 'desc' : 'asc') : (c.sortDefault ?? 'asc');
      onSort(c.sortKey, order);
    });
  }
  return th;
}

/**
 * selection: { isSelected(row) → boolean, onToggle(row, checked), onToggleAll(rows, checked) }.
 * 첫 열에 체크박스가 생기고, 머리글의 체크박스는 이 페이지의 행을 모두 선택하거나 해제한다.
 */
function selectionColumn(selection, rows) {
  const all = rows.length > 0 && rows.every((row) => selection.isSelected(row));
  const some = !all && rows.some((row) => selection.isSelected(row));
  const head = el('input', { type: 'checkbox', className: 'select-all', 'aria-label': 'Select all rows on this page', checked: all, disabled: rows.length === 0, onChange: (event) => selection.onToggleAll(rows, event.target.checked) });
  head.indeterminate = some;
  return {
    title: head,
    width: 36,
    className: 'cell-select',
    align: 'center',
    render: (row) => el('input', { type: 'checkbox', className: 'select-row', 'aria-label': 'Select row', checked: selection.isSelected(row), onChange: (event) => selection.onToggle(row, event.target.checked) }),
  };
}

export function table({ columns, rows, rowKey, rowAttrs, empty = 'No data', className = '', sort, onSort, selection, onRowClick }) {
  const cols = selection ? [selectionColumn(selection, rows), ...columns] : columns;
  const head = el('tr', {}, cols.map((c) => headerCell(c, sort, onSort)));
  const body = el('tbody');
  if (rows.length === 0) {
    body.append(el('tr', { className: 'table-empty' }, el('td', { colspan: String(cols.length) }, empty)));
  }
  rows.forEach((row, index) => {
    const tr = el('tr', rowAttrs ? rowAttrs(row, index) : {});
    tr.dataset.row = rowKey ? String(rowKey(row, index)) : String(index);
    if (selection && selection.isSelected(row)) tr.classList.add('row-selected');
    if (onRowClick) {
      tr.classList.add('row-clickable');
      tr.addEventListener('click', (event) => {
        if (event.target.closest(ROW_CLICK_IGNORE)) return;
        onRowClick(row, event);
      });
    }
    for (const c of cols) {
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

/**
 * "Showing 1–25 of 40" 과 Prev / Next 버튼. onChange(page) 로 페이지를 바꾼다.
 * pageSizes 를 주면 페이지 크기 선택이 붙고 onPageSize(size) 를 부른다.
 */
export function pager({ page, pageSize, total, onChange, unit = 'rows', pageSizes, onPageSize }) {
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  return el(
    'div',
    { className: 'pager' },
    el('span', { className: 'muted pager-total' }, total === 0 ? `0 ${unit}` : `Showing ${first}–${last} of ${total} ${unit}`),
    el('button', { type: 'button', className: 'btn btn-small', disabled: page <= 1, onClick: () => onChange(page - 1) }, 'Prev'),
    el('span', { className: 'muted' }, `Page ${page} / ${lastPage}`),
    el('button', { type: 'button', className: 'btn btn-small', disabled: page >= lastPage, onClick: () => onChange(page + 1) }, 'Next'),
    pageSizes && onPageSize
      ? el(
          'select',
          { className: 'input input-small pager-size', 'aria-label': 'Rows per page', onChange: (event) => onPageSize(Number(event.target.value)) },
          pageSizes.map((size) => el('option', { value: String(size), selected: size === pageSize }, `${size} / page`)),
        )
      : null,
  );
}
