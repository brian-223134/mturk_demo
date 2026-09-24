// Worker Pool: 모든 batch 를 합산한 worker 별 지표 표(listWorkers, 서버식 페이지네이션)와 pool 목록(listPools).
// 이 단계의 backend 는 두 경로를 501 로 답하므로, 그때는 표 대신 "Not implemented" 안내가 보인다.

import { api } from '../api-client/client.js';
import { tag } from '../components/badges.js';
import { el } from '../components/dom.js';
import { EMPTY, formatDate, formatPercent, formatSeconds } from '../components/format.js';
import { errorNotice, loading, muted } from '../components/notice.js';
import { num, pager, table } from '../components/table.js';

const PAGE_SIZE = 25;
const DEFAULT_SORT = { field: 'stats.total', order: 'desc' };

function workerColumns(poolName) {
  return [
    {
      title: 'Worker',
      render: (w) =>
        el(
          'span',
          { className: 'cell-name' },
          el('code', { className: 'worker-id' }, w.WorkerId),
          w.note ? el('span', { className: 'muted small', title: w.note }, '(note)') : null,
        ),
    },
    { title: 'Subm', tooltip: 'Submitted assignments (any status)', width: 70, align: 'right', render: (w) => num(w.stats.total) },
    { title: 'Appr', width: 70, align: 'right', render: (w) => num(w.stats.approved) },
    { title: 'Rej', width: 70, align: 'right', render: (w) => num(w.stats.rejected) },
    { title: 'Rej%', tooltip: 'Rejected / (approved + rejected)', width: 70, align: 'right', render: (w) => num(formatPercent(w.stats.rejectRate)) },
    { title: 'Attn fail', tooltip: 'Attention checks failed / attention checks judged', width: 90, align: 'right', render: (w) => num(formatPercent(w.stats.attentionFailRate)) },
    { title: 'Med time', width: 90, align: 'right', render: (w) => num(formatSeconds(w.stats.medianWorkTimeInSeconds)) },
    { title: 'Agree', tooltip: 'Share of answers that match the majority of the other workers', width: 80, align: 'right', render: (w) => num(formatPercent(w.stats.majorityAgreement)) },
    { title: 'Batches', width: 80, align: 'right', render: (w) => num(w.stats.batchCount) },
    {
      title: 'Pools',
      width: 200,
      render: (w) => [
        ...w.poolIds.map((id) => tag(poolName(id), 'default')),
        w.blocked ? tag('Blocked', 'red') : null,
      ],
    },
    { title: 'Last active', width: 110, render: (w) => formatDate(w.stats.lastActiveAt) },
  ];
}

const POOL_COLUMNS = [
  { title: 'Name', width: 220, render: (p) => el('strong', {}, p.name) },
  { title: 'Description', render: (p) => p.description },
  { title: 'Workers', width: 90, align: 'right', render: (p) => num(p.workerIds.length) },
  {
    title: 'QualificationTypeId',
    width: 250,
    render: (p) => (p.QualificationTypeId ? el('code', {}, p.QualificationTypeId) : el('span', { className: 'muted' }, `${EMPTY} (set after integration)`)),
  },
];

export async function render(root, _params, signal) {
  root.append(el('h2', { className: 'page-title' }, 'Worker Pool'));

  const workersBody = el('div', { id: 'worker-list' }, loading());
  const poolsBody = el('div', { id: 'pool-list' }, loading());
  root.append(
    el('section', { className: 'panel' }, el('h3', { className: 'panel-title' }, 'Workers'), workersBody),
    el(
      'section',
      { className: 'panel' },
      el('h3', { className: 'panel-title' }, 'Pools'),
      muted('Require or exclude a pool for a batch in Create › Settings. Each pool maps to one custom qualification.'),
      poolsBody,
    ),
  );

  // pool 이름은 worker 표의 Pools 열에도 쓰므로 먼저 받아 둔다 (실패해도 worker 표는 id 로 그린다)
  let pools = null;
  try {
    pools = await api.listPools();
  } catch (error) {
    if (signal.aborted) return;
    poolsBody.replaceChildren(errorNotice(error, 'Pools'));
  }
  if (signal.aborted) return;
  if (pools) {
    poolsBody.replaceChildren(table({ columns: POOL_COLUMNS, rows: pools, rowKey: (p) => p.id, empty: 'No pools yet.', className: 'pool-table' }));
  }
  const poolName = (id) => pools?.find((p) => p.id === id)?.name ?? id;

  let page = 1;
  async function loadWorkers() {
    workersBody.replaceChildren(loading());
    let result;
    try {
      result = await api.listWorkers({ page, pageSize: PAGE_SIZE, sort: DEFAULT_SORT });
    } catch (error) {
      if (signal.aborted) return;
      workersBody.replaceChildren(errorNotice(error, 'Workers'));
      return;
    }
    if (signal.aborted) return;
    workersBody.replaceChildren(
      table({ columns: workerColumns(poolName), rows: result.items, rowKey: (w) => w.WorkerId, empty: 'No workers yet.', className: 'worker-table' }),
      pager({
        page,
        pageSize: PAGE_SIZE,
        total: result.total,
        unit: result.total === 1 ? 'worker' : 'workers',
        onChange: (next) => {
          page = next;
          void loadWorkers();
        },
      }),
    );
  }
  await loadWorkers();
}
