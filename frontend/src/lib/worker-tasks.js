// worker 화면의 순수 로직. DOM 을 쓰지 않아 Node 테스트에서 그대로 import 한다.
//   workerColumns  worker 의 작업 화면에 보낼 입력 컬럼 (backend 의 app/domain/tasks.py 와 같은 규칙. 게시 화면이 미리 보여 준다)
//   timeLeft       제한 시간까지 남은 시간과 표시 글

import { extractPlaceholders } from './template.js';

/** 정답이 든 입력 컬럼: attention 규칙의 기대 답 컬럼, 대조 기준 컬럼. */
export function hiddenColumns({ attentionRule, reference }) {
  const hidden = [];
  if (attentionRule && typeof attentionRule.column === 'string' && attentionRule.column) hidden.push(attentionRule.column);
  if (reference?.source === 'column' && typeof reference.column === 'string' && reference.column) hidden.push(reference.column);
  return hidden;
}

/**
 * worker 에게 보낼 컬럼 (inputColumns 순서). 템플릿에 ${컬럼} 이 있으면 그 컬럼만, 없으면(window.TASK_DATA 로 읽는 템플릿)
 * 정답이 든 컬럼을 뺀 나머지다. { visible, hidden } 을 돌려준다 (hidden 은 inputColumns 중 보내지 않는 컬럼).
 */
export function workerColumns({ inputColumns = [], templateHtml = '', attentionRule = null, reference = null }) {
  const placeholders = new Set(extractPlaceholders(templateHtml));
  const answerKeys = new Set(hiddenColumns({ attentionRule, reference }));
  const visible = placeholders.size > 0 ? inputColumns.filter((c) => placeholders.has(c)) : inputColumns.filter((c) => !answerKeys.has(c));
  return { visible, hidden: inputColumns.filter((c) => !visible.includes(c)) };
}

/** deadline(ISO)까지 남은 시간. { seconds, expired, text: "12:34" 또는 "1:02:03" } */
export function timeLeft(deadline, nowMs = Date.now()) {
  const end = Date.parse(deadline ?? '');
  if (Number.isNaN(end)) return { seconds: null, expired: false, text: '–' };
  const seconds = Math.max(0, Math.floor((end - nowMs) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return { seconds, expired: seconds === 0, text: h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}` };
}

/** 초 → "30 minutes", "1 hour 30 minutes", "45 seconds". */
export function durationText(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '–';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const unit = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (h === 0 && m === 0) return unit(Math.round(seconds), 'second');
  return [h > 0 ? unit(h, 'hour') : null, m > 0 ? unit(m, 'minute') : null].filter(Boolean).join(' ');
}

const STATUS_LABELS = { Accepted: 'In progress', Submitted: 'Pending review', Approved: 'Approved', Rejected: 'Rejected', Abandoned: 'Time ran out', Returned: 'Returned' };

/** 내 HIT 목록의 상태 글. */
export function statusLabel(status) {
  return STATUS_LABELS[status] ?? String(status);
}
