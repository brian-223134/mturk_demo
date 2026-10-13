// 검수 동작: 승인(피드백 선택), 반려(피드백 필수, 프리셋 세 개), 반려 번복(OverrideRejection).
// openReviewAction({ kind: 'approve'|'reject'|'revert', assignments, onDone(action) })  응답 상세(drawer)와 행의 Revert… 가 쓴다
// openDecisionSubmit({ approve, reject, onDone({ approve, reject }) })  Review 표에서 골라 둔 결정을 한 번에 제출한다

import { api } from '../../api-client/client.js';
import { el } from '../../components/dom.js';
import { textArea } from '../../components/filters.js';
import { openModal } from '../../components/modal.js';
import { notice } from '../../components/notice.js';
import { toast } from '../../components/toast.js';
import { REJECT_PRESETS, errorText } from './shared.js';

const CUSTOM = '__custom__';

const COPY = {
  approve: { title: 'Approve', ok: 'Approve', danger: false },
  reject: { title: 'Reject', ok: 'Reject', danger: true },
  revert: { title: 'Revert to approved', ok: 'Revert to approved', danger: false },
};

const workerCount = (assignments) => new Set(assignments.map((a) => a.WorkerId)).size;

/**
 * 반려 사유 고르기: 프리셋 세 개와 직접 쓰기. attention 을 통과한 응답이 섞이면 경고한다.
 * { nodes, reason() → 문자열 } 을 돌려주고, 바뀔 때마다 onChange() 를 부른다.
 */
function rejectReasonField(assignments, onChange) {
  // attention 실패 건만 고른 경우가 가장 흔하므로 첫 프리셋이 기본이다
  let preset = REJECT_PRESETS[0];
  let text = '';
  const passedAttention = assignments.filter((a) => a.attention?.passed).length;
  const customBox = el('div', { className: 'field', hidden: true }, textArea({ rows: 3, maxLength: 1024, placeholder: 'Reason shown to the worker', onInput: (v) => { text = v; onChange(); } }));
  const radios = [...REJECT_PRESETS, CUSTOM].map((value, i) =>
    el(
      'label',
      { className: 'radio' },
      el('input', { type: 'radio', name: 'reject-preset', value, checked: i === 0, onChange: () => { preset = value; customBox.hidden = value !== CUSTOM; if (value === CUSTOM) customBox.querySelector('textarea').focus(); onChange(); } }),
      el('span', {}, value === CUSTOM ? 'Other reason' : value),
    ),
  );
  return {
    nodes: [
      passedAttention > 0 ? notice('warning', `${passedAttention} of the assignment(s) to reject passed the attention check.`) : null,
      el('div', { className: 'radio-group', role: 'radiogroup' }, radios),
      customBox,
    ],
    reason: () => (preset === CUSTOM ? text.trim() : preset),
  };
}

export function openReviewAction({ kind, assignments, onDone }) {
  const copy = COPY[kind];
  const workers = workerCount(assignments);
  let text = '';
  let reasonField = null;

  const feedbackOf = () => (kind === 'reject' ? reasonField.reason() : text.trim());
  const content = [];

  if (kind === 'reject') {
    content.push(el('p', { className: 'modal-text' }, 'Rejected workers are not paid and see this reason. Feedback is required.'));
    reasonField = rejectReasonField(assignments, () => sync());
    content.push(...reasonField.nodes);
  } else if (kind === 'approve') {
    content.push(el('p', { className: 'modal-text' }, 'Approved workers are paid the reward. Feedback is optional.'));
    content.push(el('div', { className: 'field' }, textArea({ rows: 2, maxLength: 1024, placeholder: 'Optional message to the worker', onInput: (v) => { text = v; } })));
  } else {
    content.push(
      el('p', { className: 'modal-text' }, 'The rejection is overridden and the worker is paid (MTurk ', el('code', {}, 'OverrideRejection'), '). MTurk allows this only within 30 days of the rejection.'),
      el('div', { className: 'field' }, textArea({ rows: 2, maxLength: 1024, placeholder: 'Optional message to the worker', onInput: (v) => { text = v; } })),
    );
  }

  const modal = openModal({
    title: `${copy.title} ${assignments.length} assignment(s) from ${workers} worker(s)`,
    className: `modal-review modal-review-${kind}`,
    content,
    buttons: [
      { key: 'cancel', label: 'Cancel', onClick: (h) => h.close() },
      {
        key: 'ok',
        label: copy.ok,
        kind: copy.danger ? 'danger' : 'primary',
        disabled: kind === 'reject' && feedbackOf() === '',
        onClick: async (h) => {
          const ids = assignments.map((a) => a.AssignmentId);
          const feedback = feedbackOf();
          try {
            if (kind === 'reject') await api.rejectAssignments(ids, feedback);
            else await api.approveAssignments(ids, feedback || undefined, kind === 'revert');
          } catch (error) {
            toast.error(`${copy.title} failed`, errorText(error));
            return;
          }
          h.close();
          onDone({ kind, assignments });
        },
      },
    ],
  });
  function sync() {
    modal.setButton('ok', { disabled: kind === 'reject' && feedbackOf() === '' });
  }
  return modal;
}

/**
 * Review 표에서 골라 둔 결정을 한 번에 제출한다. 반려가 있으면 사유가 필요하고, 승인 메시지는 선택이다.
 * 반려를 먼저 보내고 승인을 보낸다 (각 요청은 서버에서 전부 되거나 전부 안 된다). 하나라도 반영되면 onDone 으로 반영된 것만 알린다.
 */
export function openDecisionSubmit({ approve, reject, onDone }) {
  const total = approve.length + reject.length;
  let approveText = '';
  const reasonField = reject.length > 0 ? rejectReasonField(reject, () => sync()) : null;
  const content = [];
  if (reject.length > 0) {
    content.push(
      el('h4', { className: 'decision-heading decision-heading-reject' }, `Reject ${reject.length} assignment(s) from ${workerCount(reject)} worker(s)`),
      el('p', { className: 'modal-text' }, 'Rejected workers are not paid and see this reason. A reason is required.'),
      ...reasonField.nodes,
    );
  }
  if (approve.length > 0) {
    content.push(
      el('h4', { className: 'decision-heading decision-heading-approve' }, `Approve ${approve.length} assignment(s) from ${workerCount(approve)} worker(s)`),
      el('p', { className: 'modal-text' }, 'Approved workers are paid the reward. A message is optional.'),
      el('div', { className: 'field' }, textArea({ rows: 2, maxLength: 1024, placeholder: 'Optional message to the workers', onInput: (v) => { approveText = v; } })),
    );
  }
  const blocked = () => reasonField !== null && reasonField.reason() === '';
  const modal = openModal({
    title: `Submit ${total} decision(s)`,
    className: 'modal-review modal-review-submit',
    content,
    buttons: [
      { key: 'cancel', label: 'Cancel', onClick: (h) => h.close() },
      {
        key: 'ok',
        label: `Submit ${total} decision(s)`,
        kind: 'primary',
        disabled: blocked(),
        onClick: async (h) => {
          const done = { approve: [], reject: [] };
          try {
            if (reject.length > 0) {
              await api.rejectAssignments(reject.map((a) => a.AssignmentId), reasonField.reason());
              done.reject = reject;
            }
            if (approve.length > 0) {
              await api.approveAssignments(approve.map((a) => a.AssignmentId), approveText.trim() || undefined, false);
              done.approve = approve;
            }
          } catch (error) {
            const applied = done.reject.length > 0 ? ` The ${done.reject.length} rejection(s) were applied; the approvals were not.` : '';
            toast.error('Submit failed', `${errorText(error)}${applied}`);
            if (done.reject.length === 0) return;
          }
          h.close();
          onDone(done);
        },
      },
    ],
  });
  function sync() {
    modal.setButton('ok', { disabled: blocked() });
  }
  return modal;
}
