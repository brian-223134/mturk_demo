// 8.5 Worker 지표. 모든 batch를 합산한다.

import type { Assignment, WorkerStats } from '../api/types';
import { majorityOfTally } from './agreement';
import { isAttentionName } from './attention';
import { rejectRate } from './progress';

export interface WorkerStatsRecord {
  assignment: Assignment;
  batchId: string;
  rowIndex: number;
  attentionPrefix: string; // 실제 문항과 attention 문항을 가르는 prefix
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * majority 일치율은 이 worker의 응답이 "같은 문항의 다른 worker들" majority와 같은 비율이다.
 * 3명 중 1명일 때 자기 표가 majority를 좌우하므로 자기 표는 뺀다. 다른 worker의 표가 없거나 동률이면 그 문항은 제외한다.
 *
 * 비교 기준이 되는 다른 worker의 표는 Rejected가 아닌 assignment에서만 모은다. 반려된 응답이 기준을 흐리지 않게
 * 하되, 검수 전(Submitted)에도 일치율을 볼 수 있어야 하기 때문이다. 평가 대상은 상태와 무관하게 이 worker의 모든 응답이다.
 */
export function computeWorkerStats(records: WorkerStatsRecord[]): Map<string, WorkerStats> {
  const questionKey = (r: WorkerStatsRecord, name: string) => `${r.batchId}|${r.rowIndex}:${name}`;
  const realAnswers = (r: WorkerStatsRecord) =>
    r.assignment.answers.filter((a) => !isAttentionName(a.name, r.attentionPrefix));

  const tallies = new Map<string, Map<string, number>>();
  for (const r of records) {
    if (r.assignment.AssignmentStatus === 'Rejected') continue;
    for (const a of realAnswers(r)) {
      const key = questionKey(r, a.name);
      const counts = tallies.get(key) ?? new Map<string, number>();
      counts.set(a.value, (counts.get(a.value) ?? 0) + 1);
      tallies.set(key, counts);
    }
  }

  const byWorker = new Map<string, WorkerStatsRecord[]>();
  for (const r of records) {
    const list = byWorker.get(r.assignment.WorkerId) ?? [];
    list.push(r);
    byWorker.set(r.assignment.WorkerId, list);
  }

  const result = new Map<string, WorkerStats>();
  for (const [workerId, own] of byWorker) {
    let approved = 0;
    let rejected = 0;
    let pending = 0;
    let attentionJudged = 0;
    let attentionFailed = 0;
    let compared = 0;
    let agreed = 0;
    let lastActiveAt: string | null = null;

    for (const r of own) {
      const a = r.assignment;
      if (a.AssignmentStatus === 'Approved') approved += 1;
      else if (a.AssignmentStatus === 'Rejected') rejected += 1;
      else pending += 1;

      if (a.attention) {
        attentionJudged += 1;
        if (!a.attention.passed) attentionFailed += 1;
      }
      if (lastActiveAt === null || a.SubmitTime > lastActiveAt) lastActiveAt = a.SubmitTime;

      const ownVoteCounted = a.AssignmentStatus !== 'Rejected';
      for (const answer of realAnswers(r)) {
        const others = new Map(tallies.get(questionKey(r, answer.name)));
        if (ownVoteCounted) others.set(answer.value, (others.get(answer.value) ?? 0) - 1);
        const othersMajority = majorityOfTally(others);
        if (othersMajority === null) continue;
        compared += 1;
        if (othersMajority === answer.value) agreed += 1;
      }
    }

    result.set(workerId, {
      total: own.length,
      approved,
      rejected,
      pending,
      rejectRate: rejectRate(approved, rejected),
      attentionFailRate: attentionJudged === 0 ? null : attentionFailed / attentionJudged,
      medianWorkTimeInSeconds: median(own.map((r) => r.assignment.workTimeInSeconds)),
      majorityAgreement: compared === 0 ? null : agreed / compared,
      batchCount: new Set(own.map((r) => r.batchId)).size,
      lastActiveAt,
    });
  }
  return result;
}
