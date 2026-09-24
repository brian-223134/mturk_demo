// Review 탭: assignment 표, 필터, 일괄 승인/반려, 반려 번복. 답은 Answers 열에 두 줄(W: worker, R: 대조 기준)로 항상 보이고,
// 행을 누르면 응답 상세 drawer 가 열린다. 체크는 체크박스로 따로 한다. Worker 상세에서 ?worker=<id> 로 넘어오면 그 worker 만 보인다.

import { api } from '../../api-client/client.js';
import { refreshBalance } from '../../components/account.js';
import { attentionTag, statusTag } from '../../components/badges.js';
import { el } from '../../components/dom.js';
import { checkboxGroup, numberInput, searchInput, selectInput } from '../../components/filters.js';
import { formatDateTime, formatPercent, formatSeconds } from '../../components/format.js';
import { confirmModal, infoModal } from '../../components/modal.js';
import { errorNotice, loading } from '../../components/notice.js';
import { createSelection } from '../../components/selection.js';
import { num, pager, table } from '../../components/table.js';
import { toast } from '../../components/toast.js';
import { replace } from '../../components/render.js';
import { abbreviate, legendEntries, normalizeLabel, tokenWidthOf } from './answerTokens.js';
import { openAssignmentDrawer } from './assignmentDrawer.js';
import { openReviewAction } from './reviewActionModal.js';
import { attentionPrefixOf, describeReferenceSource, errorText, isAttentionName, workerPath } from './shared.js';
import { describeTopUp } from './topUp.js';

// Row 오름차순이면 같은 HIT 의 응답이 위아래로 붙는다 (서버가 rowIndex, WorkerId, SubmitTime 순으로 미리 정렬한다)
const DEFAULT_SORT = { field: 'rowIndex', order: 'asc' };
const PAGE_SIZES = [30, 50, 100];
const VERB = { approve: 'Approved', reject: 'Rejected', revert: 'Reverted to approved' };

/**
 * Review 표의 Answers 셀: 윗줄 W(this worker), 아랫줄 R(reference). 문항은 제출 순서대로 토큰 하나씩이라
 * hover 없이 한 줄을 훑어 판단한다. attention 문항은 보라 테두리, 기준과 다른 답은 빨강이다.
 */
export function answersCell(a, tokens, tokenWidth, attentionPrefix) {
  const pairs = a.answers.map((answer) => {
    const reference = a.reference?.[answer.name];
    return {
      name: answer.name,
      worker: answer.value,
      reference,
      attention: isAttentionName(answer.name, attentionPrefix),
      mismatch: reference !== undefined && normalizeLabel(reference) !== normalizeLabel(answer.value),
      title: `${answer.name} · worker: ${answer.value} · reference: ${reference ?? 'none'}`,
    };
  });
  const token = (text, p, extra = '') =>
    el('span', { className: `token${p.attention ? ' token-attention' : ''}${extra}`, title: p.title, style: { width: `${tokenWidth}ch` } }, text);
  return el(
    'div',
    { className: 'answers' },
    el('div', { className: 'answers-line' }, el('span', { className: 'answers-label' }, 'W'), pairs.map((p) => token(tokens.get(p.worker) ?? p.worker, p, p.mismatch ? ' token-mismatch' : ''))),
    el(
      'div',
      { className: 'answers-line' },
      el('span', { className: 'answers-label' }, 'R'),
      pairs.map((p) => (p.reference === undefined ? token('·', p, ' token-none') : token(tokens.get(p.reference) ?? p.reference, p))),
    ),
  );
}

export async function renderReview(panel, ctx) {
  const { signal } = ctx;
  const batch = ctx.detail.batch;
  const batchId = batch.id;
  const attentionPrefix = attentionPrefixOf(batch);
  const workerParam = new URLSearchParams(location.search).get('worker') ?? '';

  const query = { page: 1, pageSize: PAGE_SIZES[0], sort: DEFAULT_SORT, filters: { workerSearch: workerParam || undefined } };
  const selection = createSelection((a) => a.AssignmentId);
  let items = [];
  let total = 0;
  let tokens = new Map();
  let drawer = null;

  const filters = el('div', { className: 'toolbar', id: 'review-filters' });
  const actions = el('div', { className: 'toolbar', id: 'review-actions' });
  const legend = el('p', { className: 'muted small legend', id: 'review-legend' });
  const tableSlot = el('div', { id: 'review-table' }, loading());
  panel.append(filters, actions, legend, tableSlot);

  const setFilter = (name, value) => {
    query.filters = { ...query.filters, [name]: value };
    query.page = 1;
    void load();
  };

  filters.append(
    checkboxGroup({ label: 'Status', options: ['Submitted', 'Approved', 'Rejected'].map((v) => ({ value: v, label: v })), value: query.filters.AssignmentStatus ?? [], onChange: (value) => setFilter('AssignmentStatus', value.length ? value : undefined) }),
    selectInput({ label: 'Attention', value: '', options: [{ value: '', label: 'Any' }, { value: 'pass', label: 'Passed' }, { value: 'fail', label: 'Failed' }, { value: 'none', label: 'No attention items' }], onChange: (value) => setFilter('attention', value || undefined), className: 'filter-attention' }),
    searchInput({ label: 'WorkerId', value: workerParam, placeholder: 'WorkerId', width: 180, onSearch: (value) => setFilter('workerSearch', value || undefined), className: 'filter-worker' }),
    numberInput({ label: 'Work time under', min: 1, suffix: 's', placeholder: 'any', width: 90, onChange: (value) => setFilter('maxWorkTime', value ?? undefined), className: 'filter-time' }),
  );

  function renderActions() {
    const chosen = selection.values();
    const allSubmitted = chosen.length > 0 && chosen.every((a) => a.AssignmentStatus === 'Submitted');
    const allRejected = chosen.length > 0 && chosen.every((a) => a.AssignmentStatus === 'Rejected');
    replace(actions, 
      el('button', { type: 'button', className: 'btn', id: 'select-attention-failed', onClick: () => void selectAttentionFailed() }, 'Select attention-failed'),
      el('button', { type: 'button', className: 'btn', id: 'invert-selection', disabled: items.length === 0, onClick: () => selection.invert(items) }, 'Invert selection'),
      el('button', { type: 'button', className: 'btn btn-primary', id: 'approve-selected', disabled: !allSubmitted, onClick: () => startAction('approve', chosen) }, 'Approve selected'),
      el('button', { type: 'button', className: 'btn btn-danger', id: 'reject-selected', disabled: !allSubmitted, onClick: () => startAction('reject', chosen) }, 'Reject selected…'),
      allRejected ? el('button', { type: 'button', className: 'btn', id: 'revert-selected', onClick: () => startAction('revert', chosen) }, 'Revert to approved…') : null,
      chosen.length > 0
        ? el(
            'span',
            { className: 'toolbar-note' },
            el('span', { className: 'muted', id: 'selected-count' }, `${chosen.length} selected`),
            el('button', { type: 'button', className: 'btn btn-link btn-small', onClick: () => selection.clear() }, 'Clear'),
            !allSubmitted && !allRejected ? el('span', { className: 'muted' }, '· select only Submitted (to review) or only Rejected (to revert)') : null,
          )
        : null,
    );
  }

  function renderLegend() {
    legend.textContent =
      `Answers — W: this worker, R: reference (${describeReferenceSource(batch.reference)})` +
      legendEntries(tokens).map((entry) => ` · ${entry.token} = ${entry.values.join(' / ')}`).join('') +
      ' · purple outline = attention item · "·" = no reference';
  }

  function columnsFor() {
    const tokenWidth = tokenWidthOf(tokens);
    return [
      { title: 'Row', width: 60, align: 'right', sortKey: 'rowIndex', render: (a) => num(a.rowIndex) },
      { title: 'Worker', width: 150, sortKey: 'WorkerId', render: (a) => el('a', { href: workerPath(a.WorkerId), className: 'worker-link' }, el('code', { className: 'worker-id' }, a.WorkerId)) },
      { title: 'Answers', tooltip: 'W: this worker, R: reference. One token per question, in submission order', render: (a) => answersCell(a, tokens, tokenWidth, attentionPrefix) },
      { title: 'Attention', width: 100, render: (a) => attentionTag(a.attention) },
      { title: 'Agree', tooltip: "Share of this worker's answers (attention items excluded) that match the reference", width: 70, align: 'right', sortKey: 'agreement', render: (a) => num(formatPercent(a.agreement)) },
      { title: 'Time', width: 70, align: 'right', sortKey: 'workTimeInSeconds', render: (a) => num(formatSeconds(a.workTimeInSeconds)) },
      { title: 'Status', width: 100, sortKey: 'AssignmentStatus', render: (a) => statusTag(a.AssignmentStatus) },
      { title: 'Submitted', width: 140, sortKey: 'SubmitTime', render: (a) => formatDateTime(a.SubmitTime) },
      { title: 'Feedback', width: 180, className: 'cell-ellipsis', render: (a) => el('span', { className: 'ellipsis muted', title: a.RequesterFeedback ?? '' }, a.RequesterFeedback ?? '') },
    ];
  }

  function renderTable() {
    replace(tableSlot, 
      table({
        columns: columnsFor(),
        rows: items,
        rowKey: (a) => a.AssignmentId,
        rowAttrs: (a) => ({ dataset: { status: a.AssignmentStatus, worker: a.WorkerId } }),
        empty: 'No assignments.',
        className: 'assignment-table',
        sort: query.sort,
        onSort: (field, order) => {
          query.sort = { field, order };
          query.page = 1;
          void load();
        },
        selection: { isSelected: (a) => selection.has(a), onToggle: (a, checked) => selection.toggle(a, checked), onToggleAll: (rows, checked) => selection.setAll(rows, checked) },
        onRowClick: (a) => openDrawer(a),
      }),
      pager({
        page: query.page,
        pageSize: query.pageSize,
        total,
        unit: 'assignments',
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
      result = await api.listAssignments(batchId, query);
    } catch (error) {
      if (signal.aborted) return;
      tableSlot.classList.remove('is-loading');
      replace(tableSlot, errorNotice(error, 'Review'));
      return;
    }
    if (signal.aborted) return;
    items = result.items;
    total = result.total;
    // 약어는 페이지에 보이는 worker 답과 reference 값 전체로 만든다 (페이지가 바뀌면 다시)
    tokens = abbreviate(items.flatMap((a) => [...a.answers.map((x) => x.value), ...Object.values(a.reference ?? {})]));
    tableSlot.classList.remove('is-loading');
    renderLegend();
    renderTable();
    renderActions();
  }

  function openDrawer(assignment) {
    drawer?.close();
    drawer = openAssignmentDrawer({ detail: ctx.detail, assignment, onAction: (kind, a) => startAction(kind, [a]) });
  }

  function startAction(kind, assignments) {
    if (assignments.length === 0) return;
    openReviewAction({ kind, assignments, onDone: (done) => void onActionDone(done) });
  }

  async function refreshAll() {
    await Promise.all([load(), ctx.refreshDetail(), refreshBalance()]);
  }

  async function onActionDone(done) {
    selection.clear();
    drawer?.close();
    drawer = null;
    toast.success(`${VERB[done.kind]} ${done.assignments.length} assignment(s).`);
    await refreshAll();
    if (signal.aborted) return;
    if (done.kind === 'reject') await offerTopUp(done.assignments);
  }

  /** 반려해도 MTurk 는 자리를 다시 열어 주지 않으므로, 반려를 확정하면 재모집할지 묻는다. */
  async function offerTopUp(rejected) {
    const hitIds = [...new Set(rejected.map((a) => a.HITId))];
    const ok = await confirmModal({
      title: `Top up the ${hitIds.length} affected HIT(s)?`,
      message: 'MTurk does not reopen a slot when you reject. A top-up adds exactly as many assignments as each HIT still needs to reach its target, and extends expired HITs.',
      okText: 'Top up',
      cancelText: 'Not now',
    });
    if (!ok || signal.aborted) return;
    try {
      const result = await api.addAssignments(hitIds, 'fill-to-target');
      await refreshAll();
      const { title, lines } = describeTopUp(result);
      infoModal({ title, lines });
    } catch (error) {
      toast.error('Top-up failed', errorText(error));
    }
  }

  async function selectAttentionFailed() {
    const button = actions.querySelector('#select-attention-failed');
    if (button) button.disabled = true;
    try {
      const failed = await api.listAssignments(batchId, { page: 1, pageSize: 1000, filters: { AssignmentStatus: 'Submitted', attention: 'fail' } });
      if (signal.aborted) return;
      selection.replace(failed.items);
      if (failed.total === 0) toast.info('No submitted assignment failed the attention check.');
      else toast.success(`Selected ${failed.total} submitted assignment(s) that failed the attention check.`);
    } catch (error) {
      toast.error('Could not select', errorText(error));
    } finally {
      if (button) button.disabled = false;
    }
  }

  selection.subscribe(() => {
    renderActions();
    // 체크 상태만 바꾸고 표는 다시 그리지 않는다 (스크롤 위치 유지)
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
  renderActions();
  await load();
}
