// Review 탭: assignment 표, 필터, 검수 결정과 제출, 반려 번복. 답은 Answers 열에 두 줄(W: worker, R: 대조 기준)로 항상 보이고,
// 행을 누르면 응답 상세 drawer 가 열린다. Worker 상세에서 ?worker=<id> 로 넘어오면 그 worker 만 보인다.
// 검수는 두 단계의 라디오로 한다: 응답(worker)마다 Approve / Reject, 그리고 Row 순으로 볼 때는 HIT 칸(그 HIT 의 응답 행을 덮는다)의
// Approve all / Reject all. 고른 결정은 페이지를 넘겨도 남고, 위의 막대에서 한 번에 제출한다 (reviewDecisions.js).

import { api } from '../../api-client/client.js';
import { refreshBalance } from '../../components/account.js';
import { attentionTag, statusTag } from '../../components/badges.js';
import { el } from '../../components/dom.js';
import { checkboxGroup, numberInput, searchInput, selectInput } from '../../components/filters.js';
import { formatDateTime, formatPercent, formatSeconds } from '../../components/format.js';
import { confirmModal, infoModal } from '../../components/modal.js';
import { errorNotice, loading } from '../../components/notice.js';
import { num, pager, table } from '../../components/table.js';
import { toast } from '../../components/toast.js';
import { replace } from '../../components/render.js';
import { FREE_TEXT_PREVIEW, abbreviate, freeTextPreview, legendEntries, normalizeLabel, tokenWidthOf } from './answerTokens.js';
import { openAssignmentDrawer } from './assignmentDrawer.js';
import { openDecisionSubmit, openReviewAction } from './reviewActionModal.js';
import { APPROVE, REJECT, createDecisions, decisionSummary, groupDecision, groupMembers, hitGroups, reviewable } from './reviewDecisions.js';
import { answerKindsOf, describeReferenceSource, errorText, workerPath } from './shared.js';
import { describeTopUp } from './topUp.js';

// Row 오름차순이면 같은 HIT 의 응답이 위아래로 붙는다 (서버가 rowIndex, WorkerId, SubmitTime 순으로 미리 정렬한다)
const DEFAULT_SORT = { field: 'rowIndex', order: 'asc' };
const PAGE_SIZES = [30, 50, 100];
const VERB = { approve: 'Approved', reject: 'Rejected', revert: 'Reverted to approved' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Approve / Reject 두 칸짜리 라디오. 이미 고른 칸을 다시 누르면 지운다 (onPick(value) 가 toggle 을 맡는다).
 * value 는 지금 결정 ('approve' | 'reject' | null). mixed 면 어느 칸도 고르지 않은 채 섞였다는 표시를 붙인다.
 */
function decisionRadio({ name, value, labels, onPick, mixed = false, size = '' }) {
  const option = (choice, text) =>
    el(
      'label',
      { className: `seg seg-${choice}` },
      el('input', { type: 'radio', name, value: choice, checked: value === choice, onClick: () => onPick(choice) }),
      el('span', {}, text),
    );
  return el(
    'div',
    { className: `seg-group${size ? ` seg-${size}` : ''}${mixed ? ' seg-mixed' : ''}`, role: 'radiogroup', 'aria-label': name, dataset: { decision: value ?? (mixed ? 'mixed' : 'none') } },
    option(APPROVE, labels[0]),
    option(REJECT, labels[1]),
  );
}

/**
 * Review 표의 Answers 셀: 윗줄 W(this worker), 아랫줄 R(reference). 문항은 제출 순서대로 토큰 하나씩이라
 * hover 없이 한 줄을 훑어 판단한다. attention 문항은 보라 테두리, 기준과 다른 답은 빨강이다.
 * 자유 서술 답은 약어 대신 글을 짧게 잘라 보이고(전문은 title), 대조 기준이 없다. kinds 는 shared.js 의 answerKindsOf 다.
 */
export function answersCell(a, tokens, tokenWidth, kinds) {
  const pairs = a.answers.map((answer) => {
    const reference = a.reference?.[answer.name];
    const freeText = kinds.isFreeText(answer.name);
    return {
      name: answer.name,
      worker: answer.value,
      reference,
      attention: kinds.isAttention(answer.name),
      freeText,
      mismatch: !freeText && reference !== undefined && normalizeLabel(reference) !== normalizeLabel(answer.value),
      title: freeText ? `${answer.name} (free text) · worker: ${answer.value}` : `${answer.name} · worker: ${answer.value} · reference: ${reference ?? 'none'}`,
    };
  });
  const token = (text, p, extra = '') =>
    el('span', { className: `token${p.attention ? ' token-attention' : ''}${p.freeText ? ' token-text' : ''}${extra}`, title: p.title, style: { width: `${p.freeText ? FREE_TEXT_PREVIEW + 1 : tokenWidth}ch` } }, text);
  const workerText = (p) => (p.freeText ? freeTextPreview(p.worker) : (tokens.get(p.worker) ?? p.worker));
  return el(
    'div',
    { className: 'answers' },
    el('div', { className: 'answers-line' }, el('span', { className: 'answers-label' }, 'W'), pairs.map((p) => token(workerText(p), p, p.mismatch ? ' token-mismatch' : ''))),
    el(
      'div',
      { className: 'answers-line' },
      el('span', { className: 'answers-label' }, 'R'),
      pairs.map((p) => (p.reference === undefined || p.freeText ? token('·', p, ' token-none') : token(tokens.get(p.reference) ?? p.reference, p))),
    ),
  );
}

export async function renderReview(panel, ctx) {
  const { signal } = ctx;
  const batch = ctx.detail.batch;
  const batchId = batch.id;
  const workerParam = new URLSearchParams(location.search).get('worker') ?? '';

  const query = { page: 1, pageSize: PAGE_SIZES[0], sort: DEFAULT_SORT, filters: { workerSearch: workerParam || undefined } };
  const decisions = createDecisions();
  let items = [];
  let total = 0;
  let groups = [];
  let tokens = new Map();
  let drawer = null;
  const grouped = () => query.sort.field === 'rowIndex';

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
    const lists = decisions.lists();
    const count = lists.approve.length + lists.reject.length;
    replace(actions,
      el('button', { type: 'button', className: 'btn', id: 'reject-attention-failed', title: 'Mark every submitted assignment that failed the attention check as Reject', onClick: () => void rejectAttentionFailed() }, 'Reject attention-failed'),
      count > 0
        ? el(
            'span',
            { className: 'decision-bar', id: 'decision-bar' },
            el('strong', { id: 'decision-count' }, decisionSummary(lists)),
            el('span', { className: 'muted' }, '· not submitted yet'),
            el('button', { type: 'button', className: 'btn btn-link btn-small', id: 'clear-decisions', onClick: () => decisions.clear() }, 'Clear'),
            el('button', { type: 'button', className: 'btn btn-primary', id: 'submit-decisions', onClick: () => submitDecisions() }, `Submit ${plural(count, 'decision')}…`),
          )
        : el('span', { className: 'muted toolbar-note', id: 'decision-hint' }, grouped()
            ? 'Choose Approve or Reject for each worker, or for a whole HIT in the Row column, then submit once.'
            : 'Choose Approve or Reject for each worker, then submit once. Sort by Row to decide a whole HIT at once.'),
    );
  }

  function renderLegend() {
    legend.textContent =
      `Answers — W: this worker, R: reference (${describeReferenceSource(batch.reference)})` +
      legendEntries(tokens).map((entry) => ` · ${entry.token} = ${entry.values.join(' / ')}`).join('') +
      ' · purple outline = attention item · italic = free text (hover for the full text) · "·" = no reference';
  }

  /** HIT 칸: Row 번호, 남은 검수 수, HIT 단위 라디오. 그 HIT 의 응답 행을 rowspan 으로 덮는다. */
  function hitCell(group) {
    const members = groupMembers(group);
    const open = members.filter(reviewable).length;
    const state = groupDecision(members, decisions);
    const outside = [
      group.before.length ? `+${group.before.length} on the previous page` : null,
      group.after.length ? `+${group.after.length} on the next page` : null,
    ].filter(Boolean);
    return el(
      'div',
      { className: 'hit-cell', dataset: { group: group.hitId } },
      el('div', { className: 'hit-cell-row' }, el('span', { className: 'muted small' }, 'Row'), ' ', el('strong', { className: 'tabular' }, String(group.rowIndex ?? ''))),
      el('div', { className: 'muted small hit-cell-count' }, open > 0 ? `${open} of ${members.length} to review` : `${plural(members.length, 'assignment')} reviewed`),
      open > 0
        ? decisionRadio({
            name: `hit-${group.hitId}`,
            value: state === APPROVE || state === REJECT ? state : null,
            mixed: state === 'mixed',
            size: 'block',
            labels: ['Approve all', 'Reject all'],
            onPick: (value) => decisions.setMany(members, state === value ? null : value),
          })
        : null,
      state === 'mixed' ? el('div', { className: 'small hit-cell-mixed' }, 'Mixed decisions') : null,
      outside.length ? el('div', { className: 'muted small hit-cell-outside', title: 'Approve all / Reject all also covers these' }, outside.join(' · ')) : null,
    );
  }

  function decisionCell(a) {
    if (reviewable(a)) {
      return decisionRadio({ name: `decision-${a.AssignmentId}`, value: decisions.get(a), labels: ['Approve', 'Reject'], onPick: (value) => decisions.toggle(a, value) });
    }
    if (a.AssignmentStatus === 'Rejected') {
      return el('button', { type: 'button', className: 'btn btn-link btn-small revert-one', title: 'Override the rejection and pay the worker', onClick: () => startAction('revert', [a]) }, 'Revert…');
    }
    return el('span', { className: 'muted' }, '—');
  }

  /** 행 index → 그 행에서 시작하는 HIT 묶음 (Row 순일 때만) */
  function groupStarts() {
    const starts = new Map();
    let offset = 0;
    for (const group of groups) {
      starts.set(offset, group);
      offset += group.items.length;
    }
    return starts;
  }

  function columnsFor() {
    const tokenWidth = tokenWidthOf(tokens);
    const startAt = groupStarts();
    const rowColumn = grouped()
      ? { title: 'Row', tooltip: 'One HIT. Approve all / Reject all applies to every worker of the HIT', width: 190, sortKey: 'rowIndex', className: 'cell-hit no-row-click', span: (a, i) => (startAt.has(i) ? startAt.get(i).items.length : 0), render: (a, i) => hitCell(startAt.get(i)) }
      : { title: 'Row', width: 60, align: 'right', sortKey: 'rowIndex', render: (a) => num(a.rowIndex) };
    return [
      rowColumn,
      { title: 'Decision', tooltip: "This worker's assignment. Click the chosen option again to clear it", width: 150, className: 'cell-decision', render: (a) => decisionCell(a) },
      { title: 'Worker', width: 150, sortKey: 'WorkerId', render: (a) => el('a', { href: workerPath(a.WorkerId), className: 'worker-link' }, el('code', { className: 'worker-id' }, a.WorkerId)) },
      { title: 'Answers', tooltip: 'W: this worker, R: reference. One token per question, in submission order', render: (a) => answersCell(a, tokens, tokenWidth, answerKindsOf(a, batch)) },
      { title: 'Attention', width: 100, render: (a) => attentionTag(a.attention) },
      { title: 'Agree', tooltip: "Share of this worker's answers (attention and free-text items excluded) that match the reference", width: 70, align: 'right', sortKey: 'agreement', render: (a) => num(formatPercent(a.agreement)) },
      { title: 'Time', width: 70, align: 'right', sortKey: 'workTimeInSeconds', render: (a) => num(formatSeconds(a.workTimeInSeconds)) },
      { title: 'Status', width: 100, sortKey: 'AssignmentStatus', render: (a) => statusTag(a.AssignmentStatus) },
      { title: 'Submitted', width: 140, sortKey: 'SubmitTime', render: (a) => formatDateTime(a.SubmitTime) },
      { title: 'Feedback', width: 180, className: 'cell-ellipsis', render: (a) => el('span', { className: 'ellipsis muted', title: a.RequesterFeedback ?? '' }, a.RequesterFeedback ?? '') },
    ];
  }

  function rowClass(a, index, starts) {
    const decision = decisions.get(a);
    return [starts.has(index) ? 'group-start' : '', decision ? `decision-${decision}` : ''].filter(Boolean).join(' ') || null;
  }

  function renderTable() {
    const starts = groupStarts();
    replace(tableSlot, 
      table({
        columns: columnsFor(),
        rows: items,
        rowKey: (a) => a.AssignmentId,
        rowAttrs: (a, i) => ({ className: rowClass(a, i, starts), dataset: { status: a.AssignmentStatus, worker: a.WorkerId, hit: a.HITId } }),
        empty: 'No assignments.',
        className: `assignment-table${grouped() ? ' assignment-table-grouped' : ''}`,
        sort: query.sort,
        onSort: (field, order) => {
          query.sort = { field, order };
          query.page = 1;
          void load();
        },
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
    groups = grouped() ? hitGroups(items, await neighbours()) : [];
    if (signal.aborted) return;
    // 약어는 페이지에 보이는 worker 답과 reference 값 전체로 만든다 (페이지가 바뀌면 다시). 자유 서술 답은 약어로 쓰지 않는다
    tokens = abbreviate(
      items.flatMap((a) => {
        const kinds = answerKindsOf(a, batch);
        const labels = ([name]) => !kinds.isFreeText(name);
        return [...a.answers.filter((x) => labels([x.name])).map((x) => x.value), ...Object.entries(a.reference ?? {}).filter(labels).map(([, value]) => value)];
      }),
    );
    tableSlot.classList.remove('is-loading');
    renderLegend();
    renderTable();
    renderActions();
  }

  /**
   * Row 순일 때 페이지 경계에 걸린 HIT 의 나머지 응답. 앞 페이지와 다음 페이지를 같은 조건으로 받아 hitGroups 에 넘긴다.
   * 못 받으면 경계의 HIT 는 이 페이지의 응답만으로 묶인다.
   */
  async function neighbours() {
    const lastPage = Math.max(1, Math.ceil(total / query.pageSize));
    const fetchPage = async (page) => {
      if (page < 1 || page > lastPage || items.length === 0) return [];
      try {
        return (await api.listAssignments(batchId, { ...query, page })).items;
      } catch {
        return [];
      }
    };
    const [before, after] = await Promise.all([fetchPage(query.page - 1), fetchPage(query.page + 1)]);
    return { before, after };
  }

  function openDrawer(assignment) {
    drawer?.close();
    drawer = openAssignmentDrawer({ detail: ctx.detail, assignment, onAction: (kind, a) => startAction(kind, [a]) });
  }

  function startAction(kind, assignments) {
    if (assignments.length === 0) return;
    openReviewAction({ kind, assignments, onDone: (done) => void onActionDone(done) });
  }

  function submitDecisions() {
    const { approve, reject } = decisions.lists();
    if (approve.length + reject.length === 0) return;
    openDecisionSubmit({ approve, reject, onDone: (done) => void onDecisionsDone(done) });
  }

  async function onDecisionsDone(done) {
    decisions.removeIds([...done.approve, ...done.reject].map((a) => a.AssignmentId));
    const parts = [done.approve.length ? `approved ${done.approve.length}` : null, done.reject.length ? `rejected ${done.reject.length}` : null].filter(Boolean);
    toast.success(`${parts.join(' and ').replace(/^./, (c) => c.toUpperCase())} assignment(s).`);
    await refreshAll();
    if (signal.aborted) return;
    if (done.reject.length) await offerTopUp(done.reject);
  }

  async function refreshAll() {
    await Promise.all([load(), ctx.refreshDetail(), refreshBalance()]);
  }

  async function onActionDone(done) {
    decisions.removeIds(done.assignments.map((a) => a.AssignmentId));
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

  async function rejectAttentionFailed() {
    const button = actions.querySelector('#reject-attention-failed');
    if (button) button.disabled = true;
    try {
      const failed = await api.listAssignments(batchId, { page: 1, pageSize: 1000, filters: { AssignmentStatus: 'Submitted', attention: 'fail' } });
      if (signal.aborted) return;
      decisions.setMany(failed.items, REJECT);
      if (failed.total === 0) toast.info('No submitted assignment failed the attention check.');
      else toast.success(`Marked ${failed.total} submitted assignment(s) that failed the attention check as Reject. Submit to apply.`);
    } catch (error) {
      toast.error('Could not load attention failures', errorText(error));
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  }

  /** 결정이 바뀌면 표를 다시 그리지 않고 라디오, 행 색, HIT 칸만 맞춘다 (스크롤 위치 유지) */
  function syncDecisions() {
    renderActions();
    const byId = new Map(items.map((a) => [a.AssignmentId, a]));
    for (const tr of tableSlot.querySelectorAll('tbody tr[data-row]')) {
      const a = byId.get(tr.dataset.row);
      if (!a) continue;
      const value = decisions.get(a);
      tr.classList.toggle('decision-approve', value === APPROVE);
      tr.classList.toggle('decision-reject', value === REJECT);
      const radio = tr.querySelector('.cell-decision .seg-group');
      if (radio) {
        radio.dataset.decision = value ?? 'none';
        for (const input of radio.querySelectorAll('input[type="radio"]')) input.checked = input.value === value;
      }
    }
    for (const group of groups) {
      const node = tableSlot.querySelector(`.hit-cell[data-group="${CSS.escape(group.hitId)}"]`);
      if (node) node.replaceWith(hitCell(group));
    }
  }

  decisions.subscribe(syncDecisions);
  // 제출하지 않은 결정이 있을 때 창을 닫거나 새로고침하면 브라우저가 한 번 묻는다
  const warnUnload = (event) => {
    if (decisions.size === 0) return;
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', warnUnload);
  signal.addEventListener('abort', () => window.removeEventListener('beforeunload', warnUnload));
  renderActions();
  await load();
}
