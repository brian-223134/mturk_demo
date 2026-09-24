// HITs 탭: HIT 별 진행률, "미완료만" 필터, 선택한 HIT 재모집(Add assignments), 입력 보기(getHit)와 task 화면 열기.

import { api } from '../../api-client/client.js';
import { refreshBalance } from '../../components/account.js';
import { tag } from '../../components/badges.js';
import { el } from '../../components/dom.js';
import { checkboxInput, selectInput } from '../../components/filters.js';
import { formatCents, formatDateTime } from '../../components/format.js';
import { infoModal, openModal } from '../../components/modal.js';
import { errorNotice, loading, muted } from '../../components/notice.js';
import { createSelection } from '../../components/selection.js';
import { num, pager, table } from '../../components/table.js';
import { toast } from '../../components/toast.js';
import { replace } from '../../components/render.js';
import { errorText } from './shared.js';
import { openTaskPreview } from './taskPreview.js';
import { MAX_FIXED_ADD, MAX_TOTAL_WHEN_CREATED_UNDER_10, describeTopUp, maxAddable, planBatchTopUp } from './topUp.js';

const DEFAULT_SORT = { field: 'rowIndex', order: 'asc' };
const PAGE_SIZES = [25, 50, 100];

export async function renderHits(panel, ctx) {
  const { signal } = ctx;
  const batch = ctx.detail.batch;
  const query = { page: 1, pageSize: PAGE_SIZES[0], sort: DEFAULT_SORT, filters: {} };
  // 대표 입력 컬럼. batch 마다 고를 수 있고, qid 가 있으면 그것부터 보여준다.
  let keyColumn = batch.inputColumns.includes('qid') ? 'qid' : (batch.inputColumns[0] ?? '');
  const selection = createSelection((h) => h.HITId);
  let items = [];
  let total = 0;

  const toolbar = el('div', { className: 'toolbar toolbar-split', id: 'hits-toolbar' });
  const tableSlot = el('div', { id: 'hits-table' }, loading());
  panel.append(toolbar, tableSlot);

  function renderToolbar() {
    replace(toolbar, 
      el(
        'div',
        { className: 'toolbar-group' },
        el('button', { type: 'button', className: 'btn btn-primary', id: 'add-assignments', disabled: selection.size === 0, onClick: () => openTopUpModal() }, 'Add assignments…'),
        selection.size > 0 ? el('span', { className: 'muted', id: 'hits-selected' }, `${selection.size} selected`) : null,
        selection.size > 0 ? el('button', { type: 'button', className: 'btn btn-link btn-small', onClick: () => selection.clear() }, 'Clear') : null,
        checkboxInput({ id: 'incomplete-only', label: 'Incomplete only', checked: query.filters.incomplete === true, onChange: (checked) => { query.filters = { ...query.filters, incomplete: checked || undefined }; query.page = 1; void load(); } }),
      ),
      el(
        'div',
        { className: 'toolbar-group' },
        selectInput({ id: 'key-column', label: 'Show input column', value: keyColumn, options: batch.inputColumns.map((c) => ({ value: c, label: c })), onChange: (value) => { keyColumn = value; renderTable(); } }),
      ),
    );
  }

  const columns = () => [
    { title: 'Row', width: 60, align: 'right', sortKey: 'rowIndex', render: (h) => num(h.rowIndex) },
    { title: keyColumn || 'Input', className: 'cell-ellipsis', render: (h) => el('span', { className: 'ellipsis', title: h.inputPreview?.[keyColumn] ?? '' }, h.inputPreview?.[keyColumn] ?? '') },
    { title: 'Max', width: 60, align: 'right', sortKey: 'MaxAssignments', render: (h) => num(h.MaxAssignments) },
    { title: 'Approved', width: 90, align: 'right', sortKey: 'progress.approved', render: (h) => num(h.progress.approved) },
    { title: 'Rejected', width: 90, align: 'right', sortKey: 'progress.rejected', render: (h) => num(h.progress.rejected) },
    { title: 'Submitted', width: 95, align: 'right', sortKey: 'progress.submitted', render: (h) => num(h.progress.submitted) },
    { title: 'Open', width: 60, align: 'right', sortKey: 'progress.open', render: (h) => num(h.progress.open) },
    {
      title: 'State',
      width: 210,
      render: (h) => [
        h.progress.completed ? tag('Completed', 'green') : tag('Incomplete', 'default'),
        !h.progress.completed && h.progress.shortfall > 0 ? tag(`needs +${h.progress.shortfall}`, 'orange') : null,
        !h.progress.completed && h.expired ? tag('Expired', 'gold') : null,
      ],
    },
    { title: 'Expires', width: 150, sortKey: 'Expiration', render: (h) => formatDateTime(h.Expiration) },
    {
      title: '',
      width: 150,
      className: 'cell-actions',
      render: (h) => [
        el('button', { type: 'button', className: 'btn btn-link btn-small', onClick: () => openHitDetail(h) }, 'Input'),
        el('button', { type: 'button', className: 'btn btn-link btn-small', onClick: () => openTaskPreview({ batch, hitId: h.HITId, rowIndex: h.rowIndex }) }, 'Open task'),
      ],
    },
  ];

  function renderTable() {
    replace(tableSlot, 
      table({
        columns: columns(),
        rows: items,
        rowKey: (h) => h.HITId,
        rowAttrs: (h) => ({ dataset: { rowIndex: String(h.rowIndex), completed: String(h.progress.completed) } }),
        empty: 'No HITs.',
        className: 'hit-table',
        sort: query.sort,
        onSort: (field, order) => { query.sort = { field, order }; query.page = 1; void load(); },
        selection: { isSelected: (h) => selection.has(h), onToggle: (h, checked) => selection.toggle(h, checked), onToggleAll: (rows, checked) => selection.setAll(rows, checked) },
      }),
      pager({
        page: query.page,
        pageSize: query.pageSize,
        total,
        unit: 'HITs',
        pageSizes: PAGE_SIZES,
        onChange: (next) => { query.page = next; void load(); },
        onPageSize: (size) => { query.pageSize = size; query.page = 1; void load(); },
      }),
    );
  }

  async function load() {
    tableSlot.classList.add('is-loading');
    let result;
    try {
      result = await api.listHits(batch.id, query);
    } catch (error) {
      if (signal.aborted) return;
      tableSlot.classList.remove('is-loading');
      replace(tableSlot, errorNotice(error, 'HITs'));
      return;
    }
    if (signal.aborted) return;
    items = result.items;
    total = result.total;
    tableSlot.classList.remove('is-loading');
    renderTable();
    renderToolbar();
  }

  /** HIT 의 전체 입력(getHit)을 보여 준다. 목록의 inputPreview 는 200자에서 잘린다. */
  function openHitDetail(hit) {
    const body = el('div', {}, loading());
    openModal({
      title: `HIT ${hit.HITId} · row ${hit.rowIndex}`,
      width: 900,
      className: 'modal-hit',
      content: body,
      buttons: [
        { key: 'task', label: 'Open task', onClick: () => openTaskPreview({ batch, hitId: hit.HITId, rowIndex: hit.rowIndex }) },
        { key: 'close', label: 'Close', kind: 'primary', onClick: (h) => h.close() },
      ],
    });
    api
      .getHit(hit.HITId)
      .then((full) => {
        const columns = [
          { title: 'Column', width: 220, render: (row) => el('code', {}, row.column) },
          { title: 'Value', render: (row) => el('pre', { className: 'pre cell-pre' }, row.value) },
        ];
        const rows = batch.inputColumns.map((column) => ({ column, value: full.input?.[column] ?? '' }));
        replace(body, 
          el(
            'dl',
            { className: 'desc desc-3' },
            el('dt', {}, 'Status'), el('dd', {}, full.HITStatus),
            el('dt', {}, 'MaxAssignments'), el('dd', {}, `${full.MaxAssignments} (created with ${full.initialMaxAssignments})`),
            el('dt', {}, 'Expires'), el('dd', {}, formatDateTime(full.Expiration)),
          ),
          el('h4', { className: 'card-title' }, `Input (${rows.length} columns)`),
          table({ columns, rows, rowKey: (r) => r.column, className: 'input-table' }),
        );
      })
      .catch((error) => replace(body, errorNotice(error, 'HIT')));
  }

  /** 선택한 HIT 에 assignment 를 추가한다. fill-to-target 또는 고정 수. */
  function openTopUpModal() {
    const chosen = selection.values();
    if (chosen.length === 0) return;
    let mode = 'fill';
    let count = 1;
    const room = maxAddable(chosen);
    const countInput = el('input', { type: 'number', className: 'input input-small', id: 'add-count', min: '1', max: String(MAX_FIXED_ADD), value: '1', disabled: true, onInput: () => { count = Math.max(1, Math.min(MAX_FIXED_ADD, Math.floor(Number(countInput.value) || 1))); if (String(count) !== countInput.value) countInput.value = String(count); paintEstimate(); } });
    const estimate = el('p', { className: 'muted small', id: 'add-estimate' });
    const paintEstimate = () => {
      const plan = planBatchTopUp(batch, chosen, mode === 'fill' ? 'fill-to-target' : count);
      estimate.textContent = `${plan.addTotal} assignment(s) across ${plan.hitsAdded} HIT(s) for ${formatCents(plan.costCents)}${plan.skipped > 0 ? ` · ${plan.skipped} HIT(s) would be skipped` : ''}.`;
    };
    const radio = (value, label, extra) =>
      el(
        'label',
        { className: 'radio' },
        el('input', { type: 'radio', name: 'add-mode', value, checked: value === mode, onChange: () => { mode = value; countInput.disabled = mode !== 'count'; paintEstimate(); } }),
        el('span', {}, label, extra ? ' ' : null, extra),
      );
    paintEstimate();
    openModal({
      title: `Add assignments to ${chosen.length} HIT(s)`,
      className: 'modal-topup',
      content: [
        el(
          'div',
          { className: 'radio-group' },
          radio('fill', `Fill to target: add what each HIT still needs to reach ${batch.settings.MaxAssignments} approved`),
          radio('count', 'Add a fixed number to every selected HIT', countInput),
        ),
        estimate,
        muted(
          `A HIT created with fewer than 10 assignments can never exceed ${MAX_TOTAL_WHEN_CREATED_UNDER_10} in total (MTurk rule); such HITs are skipped with the reason shown. ` +
            (Number.isFinite(room) ? `The selected HIT(s) can take at most +${room} each. ` : '') +
            'Expired HITs are extended by the batch lifetime. The cost is reserved from the balance.',
        ),
      ],
      buttons: [
        { key: 'cancel', label: 'Cancel', onClick: (h) => h.close() },
        {
          key: 'ok',
          label: 'Add assignments',
          kind: 'primary',
          onClick: async (h) => {
            let result;
            try {
              result = await api.addAssignments(chosen.map((x) => x.HITId), mode === 'fill' ? 'fill-to-target' : count);
            } catch (error) {
              toast.error('Top-up failed', errorText(error));
              return;
            }
            h.close();
            selection.clear();
            await Promise.all([load(), ctx.refreshDetail(), refreshBalance()]);
            const { title, lines } = describeTopUp(result);
            infoModal({ title, lines });
          },
        },
      ],
    });
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
  await load();
}
