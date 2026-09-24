// "조건으로 채우기". 조건에 맞는 worker 수를 먼저 보여주고, 확인하면 그 worker 들을 pool 에 넣는다.
// 넣는 대상은 미리보기에 나온 목록 그대로다. 조건 판정은 listWorkers 로 받은 목록에 대해 이 파일의 순수 함수로 한다
// (서버의 custom filter 에 기대지 않는다). matchesCriteria 와 eligibleWorkers 는 Node 에서 테스트한다.

import { api } from '../../api-client/client.js';
import { el } from '../../components/dom.js';
import { numberInput } from '../../components/filters.js';
import { formatPercent } from '../../components/format.js';
import { openModal } from '../../components/modal.js';
import { errorNotice, loading, notice } from '../../components/notice.js';
import { num, table } from '../../components/table.js';
import { replace } from '../../components/render.js';
import { MAX_PAGE, countWorkers, workerActions, workerPath } from './shared.js';

const PREVIEW_ROWS = 10;

// 비율은 화면에서 % 로 받고 판정은 0–1 로 한다. null 은 그 조건을 쓰지 않는다는 뜻이다.
// 예시 조건: 승인 ≥ 20건, attention 실패 0건, 일치율 ≥ 90%
export const DEFAULT_CRITERIA = {
  minApproved: 20,
  maxAttentionFailPercent: 0,
  minAgreementPercent: 90,
  maxRejectPercent: null,
};

/** 통계 값이 없는(null) worker 는 조건을 만족하지 않는 것으로 본다 ("조건으로 채우기"가 보수적으로 동작한다). */
function threshold(actual, limit, test) {
  if (limit === null || limit === undefined || limit === '') return true;
  return actual !== null && actual !== undefined && test(actual, Number(limit));
}

export function matchesCriteria(worker, criteria) {
  const s = worker.stats;
  return (
    threshold(s.approved, criteria.minApproved, (a, l) => a >= l) &&
    threshold(s.attentionFailRate, criteria.maxAttentionFailPercent, (a, l) => a <= l / 100 + 1e-9) &&
    threshold(s.majorityAgreement, criteria.minAgreementPercent, (a, l) => a >= l / 100 - 1e-9) &&
    threshold(s.rejectRate, criteria.maxRejectPercent, (a, l) => a <= l / 100 + 1e-9)
  );
}

/**
 * 조건에 맞는 worker 를 { eligible, blocked } 로 나눈다. 이미 pool 에 있는 worker 는 뺀다.
 * 차단한 worker 는 pool 에 넣지 않지만, 몇 명이 빠졌는지 알려주려고 따로 센다. 승인 수가 많은 순서다.
 */
export function eligibleWorkers(workers, criteria, pool) {
  const matched = workers.filter((w) => !pool.workerIds.includes(w.WorkerId) && matchesCriteria(w, criteria)).sort((a, b) => b.stats.approved - a.stats.approved || a.WorkerId.localeCompare(b.WorkerId));
  return { eligible: matched.filter((w) => !w.blocked), blocked: matched.filter((w) => w.blocked) };
}

export function openFillByCriteria({ pool, onDone }) {
  const criteria = { ...DEFAULT_CRITERIA };
  let workers = null;
  let loadError = null;
  let maxApproved;
  let eligible = [];

  const previewColumns = [
    { title: 'Worker', render: (w) => el('a', { href: workerPath(w.WorkerId), target: '_blank' }, el('code', { className: 'worker-id' }, w.WorkerId)) },
    { title: 'Approved', align: 'right', width: 90, render: (w) => num(w.stats.approved) },
    { title: 'Attn fail', align: 'right', width: 90, render: (w) => num(formatPercent(w.stats.attentionFailRate)) },
    { title: 'Agree', align: 'right', width: 80, render: (w) => num(formatPercent(w.stats.majorityAgreement)) },
    { title: 'Rej%', align: 'right', width: 70, render: (w) => num(formatPercent(w.stats.rejectRate)) },
  ];

  const result = el('div', { className: 'fill-result', id: 'fill-result' }, loading());
  function paint() {
    if (loadError) {
      replace(result, errorNotice(loadError, 'Workers'));
      modal.setButton('ok', { label: 'Add workers', disabled: true });
      return;
    }
    if (!workers) return;
    const split = eligibleWorkers(workers, criteria, pool);
    eligible = split.eligible;
    const blockedCount = split.blocked.length;
    const truncated = workers.length >= MAX_PAGE;
    replace(result, 
      el(
        'p',
        { className: 'fill-count' },
        el('strong', { id: 'fill-match-count' }, `${countWorkers(eligible.length)} match${eligible.length === 1 ? 'es' : ''}`),
        ' ',
        el('span', { className: 'muted' }, '(not yet in this pool)'),
        blockedCount > 0 ? el('span', { className: 'muted' }, ` · ${blockedCount} blocked ${blockedCount === 1 ? 'worker also matches and is' : 'workers also match and are'} left out`) : null,
      ),
      eligible.length === 0
        ? notice('info', 'No workers match all of these criteria', `Loosen a criterion and the count updates.${maxApproved !== undefined ? ` For reference, the most approved assignments any worker has is ${maxApproved}.` : ''}`)
        : [
            table({ columns: previewColumns, rows: eligible.slice(0, PREVIEW_ROWS), rowKey: (w) => w.WorkerId, className: 'fill-preview' }),
            eligible.length > PREVIEW_ROWS ? el('p', { className: 'muted small' }, `and ${eligible.length - PREVIEW_ROWS} more`) : null,
          ],
      truncated ? el('p', { className: 'text-warning small' }, `More than ${MAX_PAGE} workers exist. Only the first ${MAX_PAGE} were checked; run the fill again for the rest.`) : null,
    );
    modal.setButton('ok', { label: `Add ${countWorkers(eligible.length)}`, disabled: eligible.length === 0 });
  }

  const set = (key, value) => {
    criteria[key] = value;
    paint();
  };
  const form = el(
    'div',
    { className: 'form-grid criteria' },
    numberInput({ id: 'crit-min-approved', label: 'Minimum approved assignments', value: criteria.minApproved, min: 0, placeholder: 'No limit', width: 160, onChange: (v) => set('minApproved', v) }),
    numberInput({ id: 'crit-max-attention', label: 'Maximum attention-fail rate', value: criteria.maxAttentionFailPercent, min: 0, max: 100, suffix: '%', placeholder: 'No limit', width: 120, onChange: (v) => set('maxAttentionFailPercent', v) }),
    numberInput({ id: 'crit-min-agreement', label: 'Minimum majority agreement', value: criteria.minAgreementPercent, min: 0, max: 100, suffix: '%', placeholder: 'No limit', width: 120, onChange: (v) => set('minAgreementPercent', v) }),
    numberInput({ id: 'crit-max-reject', label: 'Maximum reject rate (optional)', value: criteria.maxRejectPercent, min: 0, max: 100, suffix: '%', placeholder: 'No limit', width: 120, onChange: (v) => set('maxRejectPercent', v) }),
  );

  const modal = openModal({
    title: `Fill "${pool.name}" by criteria`,
    width: 640,
    className: 'modal-fill',
    content: [
      el('p', { className: 'muted' }, 'Finds workers by their record across all batches. Workers already in this pool and blocked workers are left out. A worker with no data for a criterion (for example, no attention checks yet) does not match it.'),
      form,
      result,
    ],
    buttons: [
      { key: 'cancel', label: 'Cancel', onClick: (h) => h.close() },
      {
        key: 'ok',
        label: 'Add workers',
        kind: 'primary',
        disabled: true,
        onClick: async (h) => {
          if (eligible.length === 0) return;
          if (await workerActions.addToPool(pool, eligible.map((w) => w.WorkerId))) {
            h.close();
            onDone?.(pool);
          }
        },
      },
    ],
  });

  api
    .listWorkers({ page: 1, pageSize: MAX_PAGE, sort: { field: 'stats.approved', order: 'desc' } })
    .then((list) => {
      workers = list.items;
      // fixture 가 작아서 기본 조건으로는 0명이 나온다. 어디까지 낮춰야 하는지 가늠할 기준을 함께 보여준다.
      maxApproved = list.items[0]?.stats.approved;
      paint();
    })
    .catch((error) => {
      loadError = error;
      paint();
    });
  return modal;
}
