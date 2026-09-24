// 색 배지: 환경(EnvBadge), batch/assignment 상태(StatusTag), agent job 과 step 의 상태 칩.
// 색만으로 구분하지 않도록 글자를 항상 함께 쓴다.

import { el } from './dom.js';

export function tag(text, color = 'default', attrs = {}) {
  return el('span', { ...attrs, className: `tag tag-${color}${attrs.className ? ` ${attrs.className}` : ''}` }, text);
}

// MOCK(회색), SANDBOX(파랑), PRODUCTION(빨강)
const ENV_COLORS = { mock: 'default', sandbox: 'blue', production: 'red' };

export function envBadge(env) {
  return tag(String(env).toUpperCase(), ENV_COLORS[env] ?? 'default', { className: 'env-badge', dataset: { env: String(env) } });
}

const STATUS_STYLES = {
  in_progress: ['processing', 'In progress'],
  completed: ['success', 'Completed'],
  expired: ['warning', 'Expired'],
  Submitted: ['gold', 'Submitted'],
  Approved: ['green', 'Approved'],
  Rejected: ['red', 'Rejected'],
};

export function statusTag(status) {
  const [color, label] = STATUS_STYLES[status] ?? ['default', String(status)];
  return tag(label, color, { className: 'status-tag', dataset: { status: String(status) } });
}

/** Submitted 가 1건 이상인 batch 에 붙는 표시. href 를 주면 Review 탭으로 가는 링크가 된다. */
export function needsReviewTag(submitted, href) {
  const title = `${submitted} submitted assignment(s) waiting for review`;
  const t = tag('Needs review', 'gold', { className: 'needs-review', title });
  return href ? el('a', { href, className: 'tag-link' }, t) : t;
}

/** attention 판정: "1/1 PASS", "0/1 FAIL". 판정이 없으면 "n/a". */
export function attentionTag(attention) {
  if (!attention) return el('span', { className: 'muted' }, 'n/a');
  return tag(`${attention.correct}/${attention.total} ${attention.passed ? 'PASS' : 'FAIL'}`, attention.passed ? 'green' : 'red');
}

const JOB_STATUS_COLORS = { queued: 'default', running: 'processing', succeeded: 'success', failed: 'red' };

export function jobStatusTag(status) {
  return tag(String(status), JOB_STATUS_COLORS[status] ?? 'default', { className: 'job-status', dataset: { status: String(status) } });
}

/** 파이프라인 단계 칩. pending / running / succeeded / failed / skipped. 실패한 단계는 오류를 title 로 보여 준다. */
export function stepChip(step) {
  const status = step.status ?? 'pending';
  return el(
    'span',
    { className: `chip chip-${status}`, dataset: { step: step.name, status }, title: step.error ? `${step.name}: ${step.error}` : undefined },
    el('span', { className: 'chip-name' }, step.name),
    el('span', { className: 'chip-status' }, status),
  );
}
