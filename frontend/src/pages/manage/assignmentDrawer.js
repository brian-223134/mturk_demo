// Review 의 응답 상세: 문항별로 이 worker 의 값, 대조 기준(reference), 같은 HIT 다른 worker 의 값을 나란히 보여준다.
// openAssignmentDrawer({ detail, assignment, onAction(kind, assignment) }) → drawer handle

import { api } from '../../api-client/client.js';
import { attentionTag, statusTag, tag } from '../../components/badges.js';
import { el } from '../../components/dom.js';
import { openDrawer } from '../../components/drawer.js';
import { checkboxInput } from '../../components/filters.js';
import { EMPTY, formatDateTime, formatPercent, formatSeconds } from '../../components/format.js';
import { errorNotice, loading } from '../../components/notice.js';
import { table } from '../../components/table.js';
import { replace } from '../../components/render.js';
import { normalizeLabel } from './answerTokens.js';
import { attentionPrefixOf, describeReferenceSource, isAttentionName, workerPath } from './shared.js';
import { openTaskPreview } from './taskPreview.js';

const SIBLING_PAGE = 100;

function item(label, value, wide = false) {
  return [el('dt', { className: wide ? 'wide' : null }, label), el('dd', { className: wide ? 'wide' : null }, value)];
}

export function openAssignmentDrawer({ detail, assignment, onAction }) {
  const { batch } = detail;
  const prefix = attentionPrefixOf(batch);
  let onlyDifferences = false;
  let others = [];
  let siblingsState = 'loading';
  let siblingsError = null;

  const rowsOf = () =>
    assignment.answers.map((answer) => ({
      name: answer.name,
      own: answer.value,
      reference: assignment.reference?.[answer.name],
      others: others.flatMap((other) => {
        const value = other.answers.find((x) => x.name === answer.name)?.value;
        return value === undefined ? [] : [{ workerId: other.WorkerId, value, rejected: other.AssignmentStatus === 'Rejected' }];
      }),
      attention: isAttentionName(answer.name, prefix),
    }));
  // 표의 Answers 열과 같은 기준: reference 가 있는 문항만, normalizeLabel 로 비교한다
  const disagrees = (row) => row.reference !== undefined && normalizeLabel(row.reference) !== normalizeLabel(row.own);

  const columns = [
    { title: 'Item', width: 190, render: (row) => [el('code', {}, row.name), row.attention ? tag('attention', 'purple') : null] },
    { title: 'This worker', width: 150, render: (row) => tag(row.own, disagrees(row) ? 'red' : 'default') },
    { title: 'Reference', width: 150, render: (row) => (row.reference === undefined ? el('span', { className: 'muted' }, EMPTY) : tag(row.reference, row.attention ? 'purple' : 'default')) },
    {
      title: 'Other workers on this HIT',
      render: (row) =>
        row.others.length === 0
          ? el('span', { className: 'muted' }, 'none yet')
          : row.others.map((o) => tag(o.value, 'default', { className: o.rejected ? 'tag-rejected' : '', title: `${o.workerId}${o.rejected ? ' (rejected)' : ''}` })),
    },
  ];

  const summary = el('strong', { id: 'drawer-answers-summary' });
  const tableSlot = el('div', { id: 'drawer-answers' });
  function paint() {
    const rows = rowsOf();
    const differ = rows.filter(disagrees).length;
    summary.textContent = `Answers (${rows.length})${differ > 0 ? `, ${differ} differ` : ''}`;
    if (siblingsState === 'error') replace(tableSlot, errorNotice(siblingsError, 'Other workers'));
    else {
      const shown = onlyDifferences ? rows.filter(disagrees) : rows;
      replace(tableSlot, 
        siblingsState === 'loading' ? loading('Loading other workers…') : null,
        table({ columns, rows: shown, rowKey: (r) => r.name, empty: onlyDifferences ? 'No differences.' : 'No answers.', className: 'answers-table' }),
      );
    }
  }

  const actions = [el('button', { type: 'button', className: 'btn', onClick: () => openTaskPreview({ batch, hitId: assignment.HITId, rowIndex: assignment.rowIndex }) }, 'Open task')];
  if (assignment.AssignmentStatus === 'Submitted') {
    actions.push(
      el('button', { type: 'button', className: 'btn btn-primary', onClick: () => onAction('approve', assignment) }, 'Approve'),
      el('button', { type: 'button', className: 'btn btn-danger', onClick: () => onAction('reject', assignment) }, 'Reject…'),
    );
  } else if (assignment.AssignmentStatus === 'Rejected') {
    actions.push(el('button', { type: 'button', className: 'btn', onClick: () => onAction('revert', assignment) }, 'Revert to approved…'));
  }

  const drawer = openDrawer({
    title: `Row ${assignment.rowIndex} · assignment ${assignment.AssignmentId.slice(0, 10)}…`,
    className: 'assignment-drawer',
    extra: actions,
    content: [
      el(
        'dl',
        { className: 'desc desc-3' },
        item('Worker', el('a', { href: workerPath(assignment.WorkerId) }, el('code', { className: 'worker-id' }, assignment.WorkerId))),
        item('Status', statusTag(assignment.AssignmentStatus)),
        item('Work time', formatSeconds(assignment.workTimeInSeconds)),
        item('Attention', attentionTag(assignment.attention)),
        item('Agreement', formatPercent(assignment.agreement)),
        item('Submitted', formatDateTime(assignment.SubmitTime)),
        assignment.RequesterFeedback ? item('Feedback', assignment.RequesterFeedback, true) : null,
      ),
      el(
        'div',
        { className: 'drawer-row' },
        el('span', {}, summary, ' ', el('span', { className: 'muted' }, `Reference: ${describeReferenceSource(batch.reference)}`)),
        checkboxInput({ label: 'Only differences', checked: false, onChange: (checked) => { onlyDifferences = checked; paint(); } }),
      ),
      tableSlot,
    ],
  });
  paint();

  // 같은 HIT 의 다른 worker 답을 보여 주는 데만 쓴다 (reference 는 목록 항목에 이미 들어 있다)
  api
    .listAssignments(batch.id, { page: 1, pageSize: SIBLING_PAGE, filters: { HITId: assignment.HITId } })
    .then((result) => {
      others = result.items.filter((a) => a.AssignmentId !== assignment.AssignmentId);
      siblingsState = 'ready';
      paint();
    })
    .catch((error) => {
      siblingsState = 'error';
      siblingsError = error;
      paint();
    });
  return drawer;
}
