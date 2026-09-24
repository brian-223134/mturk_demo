// Pool 목록과 편집: pool 생성, 인원 보기/빼기(행 펼침), "조건으로 채우기".

import { api } from '../../api-client/client.js';
import { tag } from '../../components/badges.js';
import { el } from '../../components/dom.js';
import { EMPTY, formatDate, formatPercent } from '../../components/format.js';
import { confirmModal } from '../../components/modal.js';
import { errorNotice, loading, muted } from '../../components/notice.js';
import { createSelection } from '../../components/selection.js';
import { num, pager, table } from '../../components/table.js';
import { replace } from '../../components/render.js';
import { openCreatePoolModal } from './createPoolModal.js';
import { openFillByCriteria } from './fillByCriteria.js';
import { MAX_PAGE, countWorkers, workerActions, workerPath } from './shared.js';

const MEMBER_PAGE = 10;

export async function renderPools(root, signal) {
  const listSlot = el('div', { id: 'pool-list' }, loading());
  root.append(
    el(
      'div',
      { className: 'toolbar toolbar-split' },
      muted('Require or exclude a pool for a batch in Create › Settings. After integration each pool maps to one custom Qualification.'),
      el('button', { type: 'button', className: 'btn btn-primary', id: 'new-pool', onClick: () => openCreatePoolModal({ onCreated: () => void load() }) }, '+ New pool'),
    ),
    listSlot,
  );

  let pools = [];
  const expanded = new Set();
  const members = new Map(); // poolId → { items, total, page, selection, busy, error }

  function memberState(pool) {
    let state = members.get(pool.id);
    if (!state) {
      state = { items: null, total: 0, page: 1, selection: createSelection((w) => w.WorkerId), busy: false, error: null };
      members.set(pool.id, state);
      state.selection.subscribe(() => paintMembers(pool));
    }
    return state;
  }

  async function loadMembers(pool) {
    const state = memberState(pool);
    try {
      // 지표까지 보여주려고 pool.workerIds 대신 listWorkers 로 받는다
      const result = await api.listWorkers({ page: 1, pageSize: MAX_PAGE, sort: { field: 'stats.total', order: 'desc' }, filters: { poolId: pool.id } });
      if (signal.aborted) return;
      state.items = result.items;
      state.total = result.total;
      state.error = null;
    } catch (error) {
      if (signal.aborted) return;
      state.error = error;
    }
    paintMembers(pool);
  }

  async function removeMembers(pool, workerIds) {
    const state = memberState(pool);
    state.busy = true;
    paintMembers(pool);
    const ok = await workerActions.removeFromPool(pool, workerIds);
    state.busy = false;
    if (signal.aborted) return;
    if (ok) state.selection.removeKeys(workerIds);
    await load();
  }

  function membersPanel(pool) {
    const state = memberState(pool);
    const columns = [
      { title: 'Worker', render: (w) => el('span', { className: 'cell-name' }, el('a', { href: workerPath(w.WorkerId) }, el('code', { className: 'worker-id' }, w.WorkerId)), w.blocked ? tag('Blocked', 'red') : null) },
      { title: 'Subm', align: 'right', width: 70, render: (w) => num(w.stats.total) },
      { title: 'Appr', align: 'right', width: 70, render: (w) => num(w.stats.approved) },
      { title: 'Rej%', align: 'right', width: 70, render: (w) => num(formatPercent(w.stats.rejectRate)) },
      { title: 'Attn fail', align: 'right', width: 90, render: (w) => num(formatPercent(w.stats.attentionFailRate)) },
      { title: 'Agree', align: 'right', width: 80, render: (w) => num(formatPercent(w.stats.majorityAgreement)) },
      { title: 'Last active', width: 110, render: (w) => formatDate(w.stats.lastActiveAt) },
      { title: '', width: 90, align: 'right', render: (w) => el('button', { type: 'button', className: 'btn btn-link btn-small remove-member', disabled: state.busy, onClick: () => void removeMembers(pool, [w.WorkerId]) }, 'Remove') },
    ];
    const total = state.items ? state.total : pool.workerIds.length;
    const chosen = state.selection.keys();
    const start = (state.page - 1) * MEMBER_PAGE;
    const rows = state.items ?? [];
    return el(
      'div',
      { className: 'pool-members', dataset: { pool: pool.id } },
      el(
        'div',
        { className: 'toolbar toolbar-split' },
        el('span', { className: 'muted' }, `${countWorkers(total)} in "${pool.name}"${total > MAX_PAGE ? ` (showing the first ${MAX_PAGE})` : ''}`),
        el(
          'button',
          {
            type: 'button',
            className: 'btn btn-danger btn-small remove-selected',
            disabled: chosen.length === 0 || state.busy,
            onClick: async () => {
              const ok = await confirmModal({ title: `Remove ${countWorkers(chosen.length)} from "${pool.name}"?`, okText: 'Remove', danger: true });
              if (ok) void removeMembers(pool, chosen);
            },
          },
          `Remove selected${chosen.length > 0 ? ` (${chosen.length})` : ''}`,
        ),
      ),
      state.error ? errorNotice(state.error, 'Members') : null,
      state.items === null && !state.error ? loading() : null,
      state.items
        ? [
            table({
              columns,
              rows: rows.slice(start, start + MEMBER_PAGE),
              rowKey: (w) => w.WorkerId,
              empty: 'No workers in this pool yet. Add them from the Workers list, or use "Fill by criteria…".',
              className: 'pool-member-table',
              selection: { isSelected: (w) => state.selection.has(w), onToggle: (w, checked) => state.selection.toggle(w, checked), onToggleAll: (page, checked) => state.selection.setAll(page, checked) },
            }),
            rows.length > MEMBER_PAGE ? pager({ page: state.page, pageSize: MEMBER_PAGE, total: rows.length, unit: 'workers', onChange: (next) => { state.page = next; paintMembers(pool); } }) : null,
          ]
        : null,
    );
  }

  function paintMembers(pool) {
    const slot = listSlot.querySelector(`.pool-expanded[data-pool="${CSS.escape(pool.id)}"]`);
    if (slot) replace(slot, membersPanel(pool));
  }

  function toggle(pool) {
    if (expanded.has(pool.id)) expanded.delete(pool.id);
    else {
      expanded.add(pool.id);
      void loadMembers(pool);
    }
    paintList();
  }

  const columns = [
    { title: 'Name', width: 220, render: (p) => el('strong', {}, p.name) },
    { title: 'Description', render: (p) => p.description },
    { title: 'Workers', width: 90, align: 'right', className: 'cell-count', render: (p) => num(p.workerIds.length) },
    { title: 'QualificationTypeId', width: 250, render: (p) => (p.QualificationTypeId ? el('code', {}, p.QualificationTypeId) : el('span', { className: 'muted' }, `${EMPTY} (set after integration)`)) },
    {
      title: '',
      width: 250,
      align: 'right',
      className: 'cell-actions',
      render: (p) => [
        el('button', { type: 'button', className: 'btn btn-link btn-small toggle-members', onClick: () => toggle(p) }, expanded.has(p.id) ? 'Hide members' : 'View members'),
        el('button', { type: 'button', className: 'btn btn-link btn-small fill-pool', onClick: () => openFillByCriteria({ pool: p, onDone: () => { expanded.add(p.id); void load(); } }) }, 'Fill by criteria…'),
      ],
    },
  ];

  function paintList() {
    const t = table({ columns, rows: pools, rowKey: (p) => p.id, rowAttrs: (p) => ({ dataset: { poolId: p.id } }), empty: 'No pools yet.', className: 'pool-table' });
    // 펼친 pool 의 인원 표를 그 행 아래에 끼워 넣는다
    const body = t.querySelector('tbody');
    for (const tr of [...body.querySelectorAll('tr[data-row]')]) {
      const pool = pools.find((p) => p.id === tr.dataset.row);
      if (!pool || !expanded.has(pool.id)) continue;
      const cell = el('td', { colspan: String(columns.length) }, el('div', { className: 'pool-expanded', dataset: { pool: pool.id } }, membersPanel(pool)));
      tr.after(el('tr', { className: 'row-expanded' }, cell));
    }
    replace(listSlot, t);
  }

  async function load() {
    try {
      pools = await api.listPools();
    } catch (error) {
      if (signal.aborted) return;
      replace(listSlot, errorNotice(error, 'Pools'));
      return;
    }
    if (signal.aborted) return;
    paintList();
    for (const pool of pools) if (expanded.has(pool.id)) void loadMembers(pool);
  }

  await load();
}
