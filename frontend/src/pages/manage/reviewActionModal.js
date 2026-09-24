// 검수 동작: 승인(피드백 선택), 반려(피드백 필수, 프리셋 세 개), 반려 번복(OverrideRejection).
// openReviewAction({ kind: 'approve'|'reject'|'revert', assignments, onDone(action) })

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

export function openReviewAction({ kind, assignments, onDone }) {
  const copy = COPY[kind];
  const workers = new Set(assignments.map((a) => a.WorkerId)).size;
  const passedAttention = assignments.filter((a) => a.attention?.passed).length;
  // attention 실패 건만 고른 경우가 가장 흔하므로 첫 프리셋이 기본이다
  let preset = REJECT_PRESETS[0];
  let text = '';

  const feedbackOf = () => (kind === 'reject' ? (preset === CUSTOM ? text.trim() : preset) : text.trim());
  const content = [];
  let customBox = null;

  if (kind === 'reject') {
    content.push(el('p', { className: 'modal-text' }, 'Rejected workers are not paid and see this reason. Feedback is required.'));
    if (passedAttention > 0) {
      content.push(notice('warning', `${passedAttention} of the selected assignment(s) passed the attention check.`));
    }
    customBox = el('div', { className: 'field', hidden: true }, textArea({ rows: 3, maxLength: 1024, placeholder: 'Reason shown to the worker', onInput: (v) => { text = v; sync(); } }));
    const radios = [...REJECT_PRESETS, CUSTOM].map((value, i) =>
      el(
        'label',
        { className: 'radio' },
        el('input', { type: 'radio', name: 'reject-preset', value, checked: i === 0, onChange: () => { preset = value; customBox.hidden = value !== CUSTOM; if (value === CUSTOM) customBox.querySelector('textarea').focus(); sync(); } }),
        el('span', {}, value === CUSTOM ? 'Other reason' : value),
      ),
    );
    content.push(el('div', { className: 'radio-group', role: 'radiogroup' }, radios), customBox);
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
