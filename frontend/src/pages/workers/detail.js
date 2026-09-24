// Worker 상세: 지표 요약, batch 별 assignment 이력, 메모. pool 과 차단도 여기서 바꿀 수 있다.

import { api } from '../../api-client/client.js';
import { statusTag, tag } from '../../components/badges.js';
import { el } from '../../components/dom.js';
import { selectInput, textArea } from '../../components/filters.js';
import { EMPTY, formatDate, formatDateTime, formatPercent, formatSeconds } from '../../components/format.js';
import { errorNotice, loading, notice } from '../../components/notice.js';
import { num, pager, table } from '../../components/table.js';
import { toast } from '../../components/toast.js';
import { replace } from '../../components/render.js';
import { openBlockModal } from './blockModal.js';
import { poolMenuButton } from './poolMenu.js';
import { errorText, reviewLink, workerActions } from './shared.js';

const STATUSES = ['Submitted', 'Approved', 'Rejected'];
const HISTORY_PAGE = 10;

function stat(label, value, hint) {
  return el('div', { className: 'stat', title: hint }, el('div', { className: 'stat-label' }, label, hint ? el('span', { className: 'muted', 'aria-hidden': 'true' }, ' ⓘ') : null), el('div', { className: 'stat-value tabular' }, value));
}

export async function renderWorkerDetail(root, workerId, signal) {
  root.append(
    el('nav', { className: 'crumbs', 'aria-label': 'Breadcrumb' }, el('a', { href: '/workers' }, 'Worker Pool'), el('span', { className: 'crumb-sep' }, '›'), el('code', { className: 'worker-id crumb-current' }, workerId)),
  );
  const body = el('div', { id: 'worker-detail' }, loading());
  root.append(body);

  let data;
  let pools = [];
  let busy = false;
  let noteDraft = null;
  let history = { page: 1, sort: { field: 'SubmitTime', order: 'desc' }, batchId: '', status: '' };

  async function load() {
    try {
      [data, pools] = await Promise.all([api.getWorker(workerId), api.listPools().catch(() => pools)]);
    } catch (error) {
      if (signal.aborted) return;
      replace(body, errorNotice(error, 'Worker'), el('p', {}, el('a', { href: '/workers' }, '← Back to the worker list')));
      return;
    }
    if (signal.aborted) return;
    paint();
  }

  async function act(action) {
    busy = true;
    paint();
    await action();
    busy = false;
    if (signal.aborted) return;
    await load();
  }

  function paint() {
    const poolName = (id) => pools.find((p) => p.id === id)?.name ?? id;
    const batchName = (id) => data.batches.find((b) => b.batchId === id)?.batchName ?? id;
    const ids = [data.WorkerId];

    const head = el(
      'div',
      { className: 'page-header page-header-split' },
      el(
        'div',
        { className: 'cell-name' },
        el('h2', { className: 'page-title worker-title' }, el('code', { className: 'worker-id' }, data.WorkerId)),
        el('span', { id: 'worker-pools' }, data.poolIds.map((id) => tag(poolName(id), 'default'))),
        data.poolIds.length === 0 && !data.blocked ? el('span', { className: 'muted' }, 'Not in any pool') : null,
        data.blocked ? tag('Blocked', 'red', { id: 'worker-blocked' }) : null,
      ),
      el(
        'div',
        { className: 'toolbar-group', id: 'worker-actions' },
        poolMenuButton({ mode: 'add', pools, workerIds: ids, disabled: busy, onPick: (pool) => act(() => workerActions.addToPool(pool, ids)) }),
        poolMenuButton({ mode: 'remove', pools, workerIds: ids, disabled: busy, onPick: (pool) => act(() => workerActions.removeFromPool(pool, ids)) }),
        data.blocked
          ? el('button', { type: 'button', className: 'btn', id: 'unblock-worker', disabled: busy, onClick: () => act(() => workerActions.unblock(ids)) }, 'Unblock')
          : el('button', { type: 'button', className: 'btn btn-danger', id: 'block-worker', disabled: busy, onClick: () => openBlockModal({ workerIds: ids, pools, onDone: () => void load() }) }, 'Block…'),
      ),
    );

    const blockedNotice = data.blocked
      ? notice('error', 'This worker is blocked', `Reason: ${data.blockReason || EMPTY}\nBlocking can harm the worker's MTurk account. If the goal is only to keep them out of future batches, unblock and use the Excluded pool instead.`)
      : null;

    const stats = el(
      'section',
      { className: 'card stats-grid', id: 'worker-stats' },
      stat('Submitted', String(data.stats.total)),
      stat('Approved', String(data.stats.approved)),
      stat('Rejected', String(data.stats.rejected)),
      stat('Pending review', String(data.stats.pending)),
      stat('Batches', String(data.stats.batchCount)),
      stat('Reject rate', formatPercent(data.stats.rejectRate), 'Rejected / (approved + rejected)'),
      stat('Attention fail rate', formatPercent(data.stats.attentionFailRate), 'Assignments that failed the attention check / assignments that had one'),
      stat('Majority agreement', formatPercent(data.stats.majorityAgreement), "Share of this worker's answers that equal the majority of the other workers on the same item. Ties are skipped."),
      stat('Median work time', formatSeconds(data.stats.medianWorkTimeInSeconds)),
      stat('Last active', formatDate(data.stats.lastActiveAt)),
    );

    const batchColumns = [
      { title: 'Batch', render: (b) => el('a', { href: reviewLink(b.batchId, workerId), className: 'batch-review-link' }, b.batchName) },
      { title: 'Submitted', align: 'right', width: 100, render: (b) => num(b.total) },
      { title: 'Approved', align: 'right', width: 100, render: (b) => num(b.approved) },
      { title: 'Rejected', align: 'right', width: 100, render: (b) => num(b.rejected) },
      { title: 'Pending', align: 'right', width: 90, render: (b) => num(b.pending) },
      // 반려 / (승인 + 반려)
      { title: 'Rej%', align: 'right', width: 80, render: (b) => num(formatPercent(b.approved + b.rejected > 0 ? b.rejected / (b.approved + b.rejected) : null)) },
    ];
    const byBatch = el('section', { className: 'card card-table', id: 'worker-batches' }, el('h4', { className: 'card-title' }, 'By batch'), table({ columns: batchColumns, rows: data.batches, rowKey: (b) => b.batchId, empty: 'No assignments yet.', className: 'worker-batch-table' }));

    // 메모. 저장된 값과 다를 때만 Save 가 켜진다. 다른 갱신(pool 변경)이 쓰던 내용을 지우지 않게 초안을 따로 둔다.
    const draft = () => (noteDraft === null ? data.note : noteDraft);
    const unsaved = el('span', { className: 'muted', id: 'note-unsaved', hidden: draft() === data.note }, 'Unsaved changes');
    const saveButton = el('button', { type: 'button', className: 'btn btn-primary', id: 'save-note', disabled: draft() === data.note, onClick: () => void saveNote() }, 'Save');
    const noteInput = textArea({ id: 'worker-note', rows: 4, maxLength: 2000, value: draft(), placeholder: 'Anything worth remembering about this worker. Only visible in this console.', onInput: (v) => { noteDraft = v; unsaved.hidden = v === data.note; saveButton.disabled = v === data.note; } });
    async function saveNote() {
      saveButton.disabled = true;
      try {
        const updated = await api.updateWorkerNote(workerId, draft());
        data.note = updated?.note ?? draft();
        noteDraft = null;
        toast.success('Note saved.');
        unsaved.hidden = true;
      } catch (error) {
        toast.error('Could not save the note', errorText(error));
        saveButton.disabled = false;
      }
    }
    const note = el('section', { className: 'card', id: 'worker-note-card' }, el('h4', { className: 'card-title' }, 'Note'), el('div', { className: 'field' }, noteInput), el('div', { className: 'toolbar toolbar-right' }, unsaved, saveButton));

    const historySlot = el('div', { id: 'worker-history' });
    function renderHistory() {
      let rows = data.assignments.filter((a) => (!history.batchId || a.batchId === history.batchId) && (!history.status || a.AssignmentStatus === history.status));
      const direction = history.sort.order === 'desc' ? -1 : 1;
      const pick = { SubmitTime: (a) => a.SubmitTime, rowIndex: (a) => a.rowIndex, workTimeInSeconds: (a) => a.workTimeInSeconds }[history.sort.field];
      rows = [...rows].sort((a, b) => {
        const x = pick(a);
        const y = pick(b);
        return direction * (typeof x === 'number' ? x - y : String(x).localeCompare(String(y)));
      });
      const start = (history.page - 1) * HISTORY_PAGE;
      const columns = [
        { title: 'Submitted', width: 150, sortKey: 'SubmitTime', render: (a) => formatDateTime(a.SubmitTime) },
        { title: 'Batch', className: 'cell-ellipsis', render: (a) => el('a', { href: reviewLink(a.batchId, workerId), className: 'ellipsis' }, batchName(a.batchId)) },
        { title: 'Row', width: 60, align: 'right', sortKey: 'rowIndex', render: (a) => num(a.rowIndex) },
        { title: 'Status', width: 110, render: (a) => statusTag(a.AssignmentStatus) },
        { title: 'Work time', width: 100, align: 'right', sortKey: 'workTimeInSeconds', render: (a) => num(formatSeconds(a.workTimeInSeconds)) },
        { title: 'Attention', width: 110, render: (a) => (a.attention ? el('span', { className: `tabular ${a.attention.passed ? 'text-good' : 'text-critical'}` }, `${a.attention.correct}/${a.attention.total} ${a.attention.passed ? 'PASS' : 'FAIL'}`) : EMPTY) },
        { title: 'Feedback', className: 'cell-ellipsis', render: (a) => el('span', { className: 'ellipsis', title: a.RequesterFeedback ?? '' }, a.RequesterFeedback || EMPTY) },
      ];
      replace(historySlot, 
        table({ columns, rows: rows.slice(start, start + HISTORY_PAGE), rowKey: (a) => a.AssignmentId, empty: 'No assignments yet.', className: 'worker-history-table', sort: history.sort, onSort: (field, order) => { history.sort = { field, order }; history.page = 1; renderHistory(); } }),
        rows.length > HISTORY_PAGE ? pager({ page: history.page, pageSize: HISTORY_PAGE, total: rows.length, unit: 'assignments', onChange: (next) => { history.page = next; renderHistory(); } }) : null,
      );
    }
    const historyCard = el(
      'section',
      { className: 'card card-table', id: 'worker-history-card' },
      el(
        'div',
        { className: 'toolbar toolbar-split' },
        el('h4', { className: 'card-title' }, `Assignment history (${data.assignments.length})`),
        el(
          'div',
          { className: 'toolbar-group' },
          selectInput({ id: 'history-batch', value: history.batchId, options: [{ value: '', label: 'All batches' }, ...data.batches.map((b) => ({ value: b.batchId, label: b.batchName }))], onChange: (v) => { history.batchId = v; history.page = 1; renderHistory(); } }),
          selectInput({ id: 'history-status', value: history.status, options: [{ value: '', label: 'Any status' }, ...STATUSES.map((s) => ({ value: s, label: s }))], onChange: (v) => { history.status = v; history.page = 1; renderHistory(); } }),
        ),
      ),
      historySlot,
    );
    renderHistory();

    replace(body, head, blockedNotice, stats, el('div', { className: 'two-col' }, byBatch, note), historyCard);
  }

  await load();
}
