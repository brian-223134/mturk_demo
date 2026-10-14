// worker 화면. MTurk 의 worker 사이트처럼 HIT group(= batch)을 고르고 HIT 를 받아 풀고 제출한다.
//   /worker                           HITs: 받을 수 있는 HIT 가 남은 batch 목록, Accept & Work, 푸는 중이면 Continue
//   /worker/assignments/:assignmentId  작업 화면: 남은 시간, 템플릿(sandbox iframe), 제출과 반납, 다음 HIT 이어 받기
//   /worker/history                   Your HITs: 내 HIT 의 상태와 금액, 반려 사유
// 템플릿은 Requester 미리보기와 같은 iframe(previewFrame)으로 그리고, 가로챈 제출 답을 backend 에 보낸다.
// 행 데이터는 backend 가 정답 컬럼을 뺀 것만 준다 (app/domain/tasks.py).

import { isApiError, worker } from '../api-client/client.js';
import { tag } from '../components/badges.js';
import { el } from '../components/dom.js';
import { formatDateTime, formatMoney } from '../components/format.js';
import { confirmModal } from '../components/modal.js';
import { errorNotice, loading, notice } from '../components/notice.js';
import { previewFrame } from '../components/preview-frame.js';
import { replace } from '../components/render.js';
import { table } from '../components/table.js';
import { toast } from '../components/toast.js';
import { durationText, statusLabel, timeLeft } from '../lib/worker-tasks.js';
import { navigate } from '../router.js';

const STATUS_COLORS = { Accepted: 'blue', Submitted: 'gold', Approved: 'green', Rejected: 'red', Abandoned: 'muted', Returned: 'muted' };
const statusTag = (status) => tag(statusLabel(status), STATUS_COLORS[status] ?? 'default', { dataset: { status } });
const taskPath = (assignmentId) => `/worker/assignments/${encodeURIComponent(assignmentId)}`;
const AUTO_NEXT_KEY = 'mturk-console:worker-auto-next';

function readAutoNext() {
  try {
    return localStorage.getItem(AUTO_NEXT_KEY) !== 'off';
  } catch {
    return true;
  }
}

function writeAutoNext(on) {
  try {
    localStorage.setItem(AUTO_NEXT_KEY, on ? 'on' : 'off');
  } catch {
    // 저장소를 못 써도 이번 화면에서는 체크 상태대로 동작한다
  }
}

/** 그 batch 에서 HIT 를 받아 작업 화면으로 간다. 남은 HIT 가 없으면 목록으로. */
async function acceptAndOpen(batchId) {
  try {
    const { assignment } = await worker.acceptHit(batchId);
    navigate(taskPath(assignment.assignmentId));
    return true;
  } catch (error) {
    toast.error('Could not accept a HIT', error.message);
    return false;
  }
}

// ---- /worker ----------------------------------------------------------------------------------

export async function renderHits(container, _params, signal, session) {
  const slot = el('div', {}, loading());
  container.append(
    el('div', { className: 'page-title' }, el('h2', {}, 'HITs')),
    el(
      'p',
      { className: 'muted' },
      'Your Worker ID is ',
      el('code', { className: 'worker-id-inline' }, session.user.workerId ?? '–'),
      '. Choose a batch and accept a HIT. You get one HIT at a time; after you submit, the next one in the same batch can open automatically.',
    ),
    slot,
  );
  let groups;
  try {
    ({ groups } = await worker.listHitGroups());
  } catch (error) {
    if (!signal.aborted) replace(slot, errorNotice(error, 'HITs'));
    return;
  }
  if (signal.aborted) return;
  if (groups.length === 0) {
    replace(slot, notice('info', 'No HITs are available to you right now', 'New HITs appear here when a requester publishes a batch you can work on.'));
    return;
  }
  replace(
    slot,
    table({
      rowKey: (group) => group.batchId,
      rows: groups,
      columns: [
        { title: 'Title', render: (g) => [el('div', { className: 'hit-title' }, g.title), g.description ? el('div', { className: 'muted small' }, g.description) : null] },
        { title: 'Requester', render: (g) => g.requester },
        { title: 'Reward', align: 'right', render: (g) => formatMoney(g.reward) },
        { title: 'Time allotted', render: (g) => durationText(g.assignmentDurationInSeconds) },
        { title: 'HITs available', align: 'right', render: (g) => String(g.availableHits) },
        { title: 'Expires', render: (g) => formatDateTime(g.expiresAt) },
        {
          title: '',
          align: 'right',
          render: (g) =>
            g.activeAssignmentId
              ? el('a', { className: 'btn btn-small', href: taskPath(g.activeAssignmentId) }, 'Continue')
              : el('button', {
                  type: 'button',
                  className: 'btn btn-primary btn-small',
                  dataset: { batchId: g.batchId },
                  onClick: (event) => {
                    const button = event.currentTarget;
                    button.disabled = true;
                    void acceptAndOpen(g.batchId).then((ok) => {
                      if (!ok) button.disabled = false;
                    });
                  },
                }, 'Accept & Work'),
        },
      ],
    }),
  );
}

// ---- /worker/assignments/:assignmentId ---------------------------------------------------------

export async function renderTask(container, params, signal) {
  const slot = el('div', {}, loading());
  container.append(slot);
  let assignment;
  try {
    ({ assignment } = await worker.getMyAssignment(params.assignmentId));
  } catch (error) {
    if (!signal.aborted) replace(slot, errorNotice(error, 'HIT'), el('p', {}, el('a', { href: '/worker' }, 'Back to HITs')));
    return;
  }
  if (signal.aborted) return;

  const heading = el(
    'div',
    { className: 'task-head panel' },
    el('div', {}, el('h2', { className: 'task-title' }, assignment.title), assignment.description ? el('p', { className: 'muted' }, assignment.description) : null),
  );
  if (assignment.status !== 'Accepted' || !assignment.task) {
    replace(
      slot,
      heading,
      notice('info', `This HIT is ${statusLabel(assignment.status).toLowerCase()}`, assignment.status === 'Abandoned' ? 'The time allotted ran out before it was submitted. You can accept the HIT again from the list.' : null),
      el('p', {}, el('a', { href: '/worker' }, 'Back to HITs'), ' · ', el('a', { href: '/worker/history' }, 'Your HITs')),
    );
    return;
  }

  const clock = el('strong', { className: 'task-clock tabular', id: 'time-left' }, timeLeft(assignment.deadline).text);
  const message = el('div', { className: 'task-message' });
  const autoNext = el('input', { type: 'checkbox', id: 'auto-next', checked: readAutoNext() });
  autoNext.addEventListener('change', () => writeAutoNext(autoNext.checked));
  const returnButton = el('button', { type: 'button', className: 'btn' }, 'Return HIT');
  let busy = false;

  function tick() {
    const left = timeLeft(assignment.deadline);
    clock.textContent = left.text;
    clock.classList.toggle('text-warning', left.seconds !== null && left.seconds < 60);
    if (left.expired) {
      clearInterval(timer);
      replace(message, notice('warning', 'Time is up', 'The time allotted for this HIT has run out, so it can no longer be submitted. Go back to the list to accept it again.'));
    }
  }
  const timer = setInterval(tick, 1000);

  async function submit(answers) {
    if (busy) return;
    busy = true;
    replace(message, notice('info', 'Submitting…', null));
    try {
      await worker.submitAssignment(assignment.assignmentId, answers);
    } catch (error) {
      busy = false;
      replace(message, errorNotice(error, 'Submit'));
      return;
    }
    toast.success('HIT submitted.');
    if (autoNext.checked) {
      try {
        const { assignment: next } = await worker.acceptHit(assignment.batchId);
        navigate(taskPath(next.assignmentId));
        return;
      } catch (error) {
        if (!isApiError(error, 'INVALID_REQUEST')) toast.error('Could not accept the next HIT', error.message);
        else toast.info('That was the last HIT in this batch for you.');
      }
    }
    navigate('/worker');
  }

  returnButton.addEventListener('click', async () => {
    const ok = await confirmModal({ title: 'Return this HIT?', message: 'Your answers are not saved and the HIT goes back to other workers. You can accept it again later.', okText: 'Return HIT' });
    if (!ok) return;
    try {
      await worker.returnAssignment(assignment.assignmentId);
      toast.info('HIT returned.');
      navigate('/worker');
    } catch (error) {
      toast.error('Could not return the HIT', error.message);
    }
  });

  const frame = previewFrame({ html: assignment.task.html, row: assignment.task.row, height: 760, title: 'Task', showSubmitted: false, onSubmit: (answers) => void submit(answers) });
  heading.append(
    el(
      'div',
      { className: 'task-meta' },
      el('span', {}, 'Reward ', el('strong', {}, formatMoney(assignment.reward))),
      el('span', {}, 'Time left ', clock),
      el('label', { className: 'checkbox', for: 'auto-next' }, autoNext, 'Accept the next HIT in this batch after I submit'),
      returnButton,
    ),
  );
  replace(slot, heading, message, el('div', { className: 'task-frame' }, frame.node));
  tick();
  return () => {
    clearInterval(timer);
    frame.destroy();
  };
}

// ---- /worker/history ---------------------------------------------------------------------------

export async function renderHistory(container, _params, signal) {
  const slot = el('div', {}, loading());
  container.append(el('div', { className: 'page-title' }, el('h2', {}, 'Your HITs')), slot);
  let data;
  try {
    data = await worker.listMyAssignments();
  } catch (error) {
    if (!signal.aborted) replace(slot, errorNotice(error, 'Your HITs'));
    return;
  }
  if (signal.aborted) return;
  const { summary, assignments } = data;
  const stat = (label, value, detail) => el('div', { className: 'stat' }, el('div', { className: 'stat-label' }, label), el('div', { className: 'stat-value tabular' }, value), detail ? el('div', { className: 'muted small' }, detail) : null);
  replace(
    slot,
    el(
      'div',
      { className: 'worker-summary' },
      stat('Approved', String(summary.approved), `${summary.approvedReward} earned`),
      stat('Pending review', String(summary.submitted), `${summary.pendingReward} if approved`),
      stat('Rejected', String(summary.rejected)),
      stat('In progress', String(summary.inProgress)),
    ),
    table({
      rowKey: (a) => a.assignmentId,
      rows: assignments,
      empty: 'You have not worked on any HITs yet.',
      columns: [
        { title: 'Title', render: (a) => a.title },
        { title: 'Status', render: (a) => statusTag(a.status) },
        { title: 'Reward', align: 'right', render: (a) => formatMoney(a.reward) },
        { title: 'Accepted', render: (a) => formatDateTime(a.acceptTime) },
        { title: 'Submitted', render: (a) => formatDateTime(a.submitTime) },
        { title: 'Requester feedback', render: (a) => a.feedback ?? '–' },
        { title: '', align: 'right', render: (a) => (a.status === 'Accepted' ? el('a', { className: 'btn btn-small', href: taskPath(a.assignmentId) }, 'Continue') : null) },
      ],
    }),
  );
}
