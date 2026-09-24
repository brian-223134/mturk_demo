// Results 탭: 문항별 투표와 majority, 만장일치 비율, Fleiss κ, 라벨 분포, export.
// Approved assignment 의 실제 문항만 센다. 계산은 서버가 하고 화면은 보여주기만 한다.

import { api } from '../../api-client/client.js';
import { tag } from '../../components/badges.js';
import { el } from '../../components/dom.js';
import { downloadFile } from '../../components/download.js';
import { selectInput } from '../../components/filters.js';
import { formatFixed, formatPercent } from '../../components/format.js';
import { menuButton } from '../../components/menu.js';
import { errorNotice, loading, muted } from '../../components/notice.js';
import { CATEGORY_COLORS, stackedBar } from '../../components/stackedBar.js';
import { num, pager, table } from '../../components/table.js';
import { toast } from '../../components/toast.js';
import { replace } from '../../components/render.js';
import { errorText } from './shared.js';

const PAGE_SIZES = [25, 50, 100];

export const EXPORT_FORMATS = [
  { key: 'labels-json', label: 'Labels JSON (votes, majority, workers per item)' },
  { key: 'mturk-csv', label: 'MTurk results CSV (same columns as the Requester website export)' },
];

/** Landis & Koch (1977) 의 구간. 해석을 돕는 관례일 뿐 기준은 아니다. */
export function kappaBand(kappa) {
  if (kappa < 0) return 'poor';
  if (kappa <= 0.2) return 'slight';
  if (kappa <= 0.4) return 'fair';
  if (kappa <= 0.6) return 'moderate';
  if (kappa <= 0.8) return 'substantial';
  return 'almost perfect';
}

export async function exportBatchAs(batchId, format) {
  try {
    const file = await api.exportBatch(batchId, format);
    downloadFile(file);
    toast.success(`Exported ${file.filename}`);
  } catch (error) {
    toast.error('Export failed', errorText(error));
  }
}

export function exportMenu(batchId, formats = EXPORT_FORMATS) {
  return menuButton({ label: 'Export', className: 'export-menu', items: formats.map((f) => ({ key: f.key, label: f.label, onClick: () => void exportBatchAs(batchId, f.key) })) });
}

function card(title, ...children) {
  return el('section', { className: 'card' }, title ? el('h4', { className: 'card-title' }, title) : null, ...children);
}

function stat(label, value, attrs = {}) {
  return el('div', { className: 'stat', ...attrs }, el('div', { className: 'stat-label' }, label), el('div', { className: 'stat-value tabular' }, value));
}

export async function renderResults(panel, ctx) {
  const { signal } = ctx;
  const batch = ctx.detail.batch;
  replace(panel, loading());
  let data;
  try {
    data = await api.getResults(batch.id);
  } catch (error) {
    if (signal.aborted) return;
    replace(panel, errorNotice(error, 'Results'));
    return;
  }
  if (signal.aborted) return;

  const items = data.items ?? [];
  // 값마다 색을 고정한다 (득표 순이 아니라 이름 순). 필터로 항목이 줄어도 같은 값은 같은 색이다.
  const labels = Object.keys(data.labelDistribution ?? {}).sort();
  const colorOf = (label) => CATEGORY_COLORS[labels.indexOf(label)] ?? '#8c8b86';
  const tied = items.filter((i) => i.majority === null).length;

  let filter = 'all';
  let page = 1;
  let pageSize = PAGE_SIZES[0];
  let sort = { field: 'rowIndex', order: 'asc' };

  const shownItems = () => {
    let list = items;
    if (filter === 'not-unanimous') list = items.filter((i) => !i.unanimous && i.votes.length > 1);
    else if (filter === 'tie') list = items.filter((i) => i.majority === null);
    else if (filter === 'short') list = items.filter((i) => i.votes.length < data.target);
    const direction = sort.order === 'desc' ? -1 : 1;
    const key = sort.field === 'n' ? (i) => i.votes.length : (i) => i.rowIndex;
    return [...list].sort((a, b) => direction * (key(a) - key(b)) || a.key.localeCompare(b.key));
  };

  const columns = [
    { title: 'Row', width: 70, align: 'right', sortKey: 'rowIndex', render: (r) => num(r.rowIndex) },
    { title: 'Item', width: 200, render: (r) => el('code', {}, r.answerName) },
    {
      title: 'Votes (approved)',
      render: (r) =>
        r.votes.map((vote, i) =>
          el('span', { className: 'tag tag-default vote', title: r.workers?.[i] ?? '' }, el('span', { className: 'bar-swatch', style: { background: colorOf(vote) } }), vote),
        ),
    },
    { title: 'n', width: 50, align: 'right', sortKey: 'n', render: (r) => num(r.votes.length) },
    {
      title: 'Majority',
      width: 200,
      render: (r) => (r.majority === null ? tag('tie', 'gold') : [tag(r.majority, 'default'), r.unanimous ? el('span', { className: 'muted small' }, 'unanimous') : null]),
    },
  ];

  const countNode = el('span', { className: 'muted', id: 'results-shown' });
  const tableSlot = el('div', { id: 'results-table' });
  function renderTable() {
    const list = shownItems();
    countNode.textContent = `${list.length} shown`;
    const start = (page - 1) * pageSize;
    replace(tableSlot, 
      table({
        columns,
        rows: list.slice(start, start + pageSize),
        rowKey: (r) => r.key,
        empty: 'No items with votes.',
        className: 'results-table',
        sort,
        onSort: (field, order) => { sort = { field, order }; page = 1; renderTable(); },
      }),
      pager({ page, pageSize, total: list.length, unit: 'items', pageSizes: PAGE_SIZES, onChange: (next) => { page = next; renderTable(); }, onPageSize: (size) => { pageSize = size; page = 1; renderTable(); } }),
    );
  }

  replace(panel, 
    el(
      'div',
      { className: 'cards cards-4' },
      card(
        null,
        stat("Fleiss' κ", formatFixed(data.fleissKappa), { id: 'kappa', title: 'Computed only on items with exactly the target number of approved votes' }),
        muted(`${data.fleissKappa === null || data.fleissKappa === undefined ? '' : `${kappaBand(data.fleissKappa)} agreement · `}${data.kappaItemCount} items × ${data.target} raters`),
      ),
      card(null, stat('Unanimous items', formatPercent(data.unanimousRatio), { id: 'unanimous' }), muted(`of items with ${data.target} votes`)),
      card(null, stat('Items with votes', String(items.length), { id: 'items-with-votes' }), muted(`${items.length - data.kappaItemCount} not at ${data.target} votes · ${tied} tied`)),
      card('Label distribution (approved votes)', labels.length === 0 ? muted('No approved votes yet.') : stackedBar(labels.map((label) => ({ key: label, label, value: data.labelDistribution[label], color: colorOf(label) })))),
    ),
    el(
      'div',
      { className: 'toolbar toolbar-split' },
      el(
        'div',
        { className: 'toolbar-group' },
        el('strong', {}, 'Items'),
        selectInput({
          id: 'results-filter',
          value: filter,
          options: [
            { value: 'all', label: 'All items' },
            { value: 'not-unanimous', label: 'Not unanimous' },
            { value: 'tie', label: 'Tied (no majority)' },
            { value: 'short', label: `Fewer than ${data.target} votes` },
          ],
          onChange: (value) => { filter = value; page = 1; renderTable(); },
        }),
        countNode,
      ),
      el('div', { className: 'toolbar-group' }, exportMenu(batch.id)),
    ),
    tableSlot,
  );
  renderTable();
}
