// 5.3 Export 형식: MTurk 결과 CSV 호환 형식과 라벨 JSON

import type { Assignment, Batch, Hit } from '../api/types';
import type { VotedItem } from './agreement';

/** RFC 4180. 쉼표, 따옴표, 줄바꿈이 있는 셀만 따옴표로 감싼다. */
export function toCsv(header: string[], rows: string[][]): string {
  const cell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return [header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** MTurk 결과 CSV의 시각 표기. 시간대는 UTC로 쓴다: "Thu Oct 09 07:30:20 UTC 2025" */
export function toMturkTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} UTC ${d.getUTCFullYear()}`;
}

/**
 * MTurk Requester 웹사이트의 결과 CSV와 같은 컬럼. 기존 `*_iaa.py`는 AssignmentStatus, Input.*, Answer.taskAnswers를 읽는다.
 * Answer.taskAnswers는 MTurk와 같이 `[{"input_answers": "<JSON 문자열>"}]` 모양이다.
 * 입력 컬럼명을 38자로 자르는 MTurk의 동작은 흉내 내지 않는다 (부록 A).
 */
export function buildMturkCsv(batch: Batch, hits: Hit[], assignments: Assignment[]): string {
  const hitById = new Map(hits.map((h) => [h.HITId, h]));
  const s = batch.settings;
  const header = [
    'HITId', 'HITTypeId', 'Title', 'Description', 'Keywords', 'Reward', 'CreationTime', 'MaxAssignments',
    'RequesterAnnotation', 'AssignmentDurationInSeconds', 'AutoApprovalDelayInSeconds', 'Expiration',
    'NumberOfSimilarHITs', 'LifetimeInSeconds', 'AssignmentId', 'WorkerId', 'AssignmentStatus', 'AcceptTime',
    'SubmitTime', 'AutoApprovalTime', 'ApprovalTime', 'RejectionTime', 'RequesterFeedback', 'WorkTimeInSeconds',
    'LifetimeApprovalRate', 'Last30DaysApprovalRate', 'Last7DaysApprovalRate',
    ...batch.inputColumns.map((c) => `Input.${c}`),
    'Answer.taskAnswers', 'Approve', 'Reject',
  ];
  const rows: string[][] = [];
  for (const a of assignments) {
    const hit = hitById.get(a.HITId);
    if (!hit) continue;
    rows.push([
      hit.HITId, '', s.Title, s.Description, s.Keywords, `$${s.Reward}`, toMturkTime(hit.CreationTime),
      String(hit.MaxAssignments), `BatchId:${batch.id};`, String(s.AssignmentDurationInSeconds),
      String(s.AutoApprovalDelayInSeconds), toMturkTime(hit.Expiration), '', String(s.LifetimeInSeconds),
      a.AssignmentId, a.WorkerId, a.AssignmentStatus, toMturkTime(a.AcceptTime), toMturkTime(a.SubmitTime),
      toMturkTime(a.AutoApprovalTime), toMturkTime(a.ApprovalTime), toMturkTime(a.RejectionTime),
      a.RequesterFeedback ?? '', String(a.workTimeInSeconds), '', '', '',
      ...batch.inputColumns.map((c) => hit.input[c] ?? ''),
      JSON.stringify([{ input_answers: JSON.stringify(a.answers) }]), '', '',
    ]);
  }
  return toCsv(header, rows);
}

/** `{ "<rowIndex>:<answerName>": { votes, majority, workers } }` */
export function buildLabelsJson(items: VotedItem[]): string {
  const labels: Record<string, { votes: string[]; majority: string | null; workers: string[] }> = {};
  for (const item of items) {
    labels[item.key] = { votes: item.votes, majority: item.majority, workers: item.workers };
  }
  return JSON.stringify(labels, null, 2);
}
