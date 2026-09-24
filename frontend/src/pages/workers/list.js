// Worker 목록. 정렬, 검색, 필터, 페이지 이동은 전부 listWorkers 에 맡긴다 (서버식 페이지네이션).
// 여러 명을 골라 pool 에 넣거나 빼고, 차단한다. 차단의 기본 동선은 Excluded pool 이다 (blockModal.js).

import { api } from '../../api-client/client.js';
import { tag } from '../../components/badges.js';
import { el } from '../../components/dom.js';
import { checkboxInput, searchInput, selectInput } from '../../components/filters.js';
import { formatDate, formatPercent, formatSeconds } from '../../components/format.js';
import { errorNotice, loading } from '../../components/notice.js';
import { createSelection } from '../../components/selection.js';
import { num, pager, table } from '../../components/table.js';
import { replace } from '../../components/render.js';
import { openBlockModal } from './blockModal.js';
import { poolMenuButton } from './poolMenu.js';
import { workerActions, workerPath } from './shared.js';

const DEFAULT_SORT = { field: 'stats.total', order: 'desc' };
const PAGE_SIZES = [25, 50, 100];

export async function renderWorkerList(root, signal) {
  const query = { page: 1, pageSize: PAGE_SIZES[0], sort: DEFAULT_SORT, filters: { search: '', poolId: '', blocked: undefined } };
  const selection = createSelection((w) => w.WorkerId);
  let pools = [];
  let items = [];
  let total = 0;
  let busy = false;

  const toolbar = el('div', { className: 'toolbar toolbar-split', id: 'workers-toolbar' });
  const tableSlot = el('div', { id: 'worker-list' }, loading());
  root.append(toolbar, tableSlot);

  const poolName = (id) => pools.find((p) => p.id === id)?.name ?? id;
  const changeFilter = (patch) => {
    query.filters = { ...query.filters, ...patch };
    query.page = 1;
    void load();
  };

  function renderToolbar() {
    const chosen = selection.values();
    const ids = chosen.map((w) => w.WorkerId);
    const allBlocked = chosen.length > 0 && chosen.every((w) => w.blocked);
    replace(toolbar, 
      el(
        'div',
        { className: 'toolbar-group' },
        poolMenuButton({ mode: 'add', pools, workerIds: ids, disabled: busy, onPick: (pool) => act(() => workerActions.addToPool(pool, ids)) }),
        poolMenuButton({ mode: 'remove', pools, workerIds: ids, disabled: busy, onPick: (pool) => act(() => workerActions.removeFromPool(pool, ids)) }),
        allBlocked
          ? el('button', { type: 'button', className: 'btn', id: 'unblock-selected', disabled: busy, onClick: () => act(() => workerActions.unblock(ids)) }, 'Unblock')
          : el('button', { type: 'button', className: 'btn btn-danger', id: 'block-selected', disabled: chosen.length === 0 || busy, onClick: () => openBlockModal({ workerIds: ids, pools, onDone: () => { selection.clear(); void reload(); } }) }, 'Block…'),
        el('span', { className: 'muted', id: 'workers-selected' }, `${chosen.length} selected`),
        chosen.length > 0 ? el('button', { type: 'button', className: 'btn btn-link btn-small', onClick: () => selection.clear() }, 'Clear') : null,
      ),
      el(
        'div',
        { className: 'toolbar-group' },
        selectInput({ id: 'pool-filter', value: query.filters.poolId, options: [{ value: '', label: 'Any pool' }, ...pools.map((p) => ({ value: p.id, label: `${p.name} (${p.workerIds.length})` }))], onChange: (poolId) => changeFilter({ poolId }) }),
        checkboxInput({ id: 'blocked-only', label: 'Blocked only', checked: query.filters.blocked === true, onChange: (checked) => changeFilter({ blocked: checked ? true : undefined }) }),
        searchInput({ id: 'worker-search', value: query.filters.search, placeholder: 'Search WorkerId', width: 200, onSearch: (search) => changeFilter({ search }) }),
      ),
    );
  }

  /** pool 변경과 차단은 목록, pool 인원, 선택을 함께 바꾼다 */
  async function act(action) {
    busy = true;
    renderToolbar();
    const ok = await action();
    busy = false;
    if (signal.aborted) return;
    if (ok) selection.clear();
    await reload();
  }

  const numeric = (title, key, pick, width = 80, tooltip) => ({ title, tooltip, width, align: 'right', sortKey: key, sortDefault: 'desc', render: (w) => num(pick(w)) });
  const columns = () => [
    {
      title: 'Worker',
      sortKey: 'WorkerId',
      render: (w) => el('span', { className: 'cell-name' }, el('a', { href: workerPath(w.WorkerId) }, el('code', { className: 'worker-id' }, w.WorkerId)), w.note ? el('span', { className: 'muted small note-mark', title: w.note }, '(note)') : null),
    },
    numeric('Subm', 'stats.total', (w) => w.stats.total, 70, 'Submitted assignments (any status)'),
    numeric('Appr', 'stats.approved', (w) => w.stats.approved, 70),
    numeric('Rej', 'stats.rejected', (w) => w.stats.rejected, 70),
    numeric('Rej%', 'stats.rejectRate', (w) => formatPercent(w.stats.rejectRate), 70, 'Rejected / (approved + rejected)'),
    numeric('Attn fail', 'stats.attentionFailRate', (w) => formatPercent(w.stats.attentionFailRate), 90, 'Attention checks failed / attention checks judged'),
    numeric('Med time', 'stats.medianWorkTimeInSeconds', (w) => formatSeconds(w.stats.medianWorkTimeInSeconds), 90),
    numeric('Agree', 'stats.majorityAgreement', (w) => formatPercent(w.stats.majorityAgreement), 80, 'Share of answers that match the majority of the other workers'),
    numeric('Batches', 'stats.batchCount', (w) => w.stats.batchCount, 80),
    { title: 'Pools', width: 190, className: 'cell-pools', render: (w) => [...w.poolIds.map((id) => tag(poolName(id), 'default')), w.blocked ? tag('Blocked', 'red') : null] },
    { title: 'Last active', width: 110, sortKey: 'stats.lastActiveAt', sortDefault: 'desc', render: (w) => formatDate(w.stats.lastActiveAt) },
  ];

  function renderTable() {
    replace(tableSlot, 
      table({
        columns: columns(),
        rows: items,
        rowKey: (w) => w.WorkerId,
        rowAttrs: (w) => ({ dataset: { blocked: String(w.blocked) } }),
        empty: 'No workers yet.',
        className: 'worker-table',
        sort: query.sort,
        onSort: (field, order) => { query.sort = { field, order }; query.page = 1; void load(); },
        selection: { isSelected: (w) => selection.has(w), onToggle: (w, checked) => selection.toggle(w, checked), onToggleAll: (rows, checked) => selection.setAll(rows, checked) },
      }),
      pager({
        page: query.page,
        pageSize: query.pageSize,
        total,
        unit: total === 1 ? 'worker' : 'workers',
        pageSizes: PAGE_SIZES,
        onChange: (next) => { query.page = next; void load(); },
        onPageSize: (size) => { query.pageSize = size; query.page = 1; void load(); },
      }),
    );
  }

  async function loadPools() {
    try {
      pools = await api.listPools();
    } catch (error) {
      if (!signal.aborted) replace(tableSlot, errorNotice(error, 'Pools'));
    }
  }

  async function load() {
    tableSlot.classList.add('is-loading');
    let result;
    try {
      result = await api.listWorkers(query);
    } catch (error) {
      if (signal.aborted) return;
      tableSlot.classList.remove('is-loading');
      replace(tableSlot, errorNotice(error, 'Workers'));
      return;
    }
    if (signal.aborted) return;
    // 차단 해제나 pool 제거로 마지막 페이지가 비면 앞 페이지로 돌아간다
    const lastPage = Math.max(1, Math.ceil(result.total / query.pageSize));
    if (query.page > lastPage) {
      query.page = lastPage;
      return load();
    }
    items = result.items;
    total = result.total;
    // 선택된 행의 blocked 등이 바뀌었을 수 있으므로 최신 행으로 바꿔 둔다
    for (const w of items) if (selection.has(w)) selection.toggle(w, true);
    tableSlot.classList.remove('is-loading');
    renderTable();
    renderToolbar();
  }

  async function reload() {
    await loadPools();
    if (signal.aborted) return;
    await load();
  }

  selection.subscribe(() => {
    renderToolbar();
    for (const tr of tableSlot.querySelectorAll('tbody tr[data-row]')) {
      const selected = selection.hasKey(tr.dataset.row);
      tr.classList.toggle('row-selected', selected);
      const box = tr.querySelector('input.select-row');
      if (box) box.checked = selected;
    }
    const all = tableSlot.querySelector('input.select-all');
    if (all) {
      all.checked = selection.allSelected(items);
      all.indeterminate = !all.checked && selection.someSelected(items);
    }
  });
  renderToolbar();
  await reload();
}
