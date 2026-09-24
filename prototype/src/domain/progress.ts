// 8.3 HIT 진행률, 4장의 batch 상태 계산

import type { Assignment, BatchProgress, BatchStatus, Hit } from '../api/types';

export interface AssignmentCounts {
  submitted: number;
  approved: number;
  rejected: number;
}

export interface HitProgress extends AssignmentCounts {
  open: number; // 아직 아무도 제출하지 않은 자리
  completed: boolean; // approved ≥ target
  shortfall: number; // 'fill-to-target' 재모집으로 추가해야 할 수
}

export function countByStatus(
  assignments: readonly Pick<Assignment, 'AssignmentStatus'>[],
): AssignmentCounts {
  const counts: AssignmentCounts = { submitted: 0, approved: 0, rejected: 0 };
  for (const a of assignments) {
    if (a.AssignmentStatus === 'Submitted') counts.submitted += 1;
    else if (a.AssignmentStatus === 'Approved') counts.approved += 1;
    else counts.rejected += 1;
  }
  return counts;
}

/** target은 batch.settings.MaxAssignments(목표 라벨 수)다. hit.MaxAssignments는 재모집으로 더 클 수 있다. */
export function hitProgress(
  hit: Pick<Hit, 'MaxAssignments'>,
  counts: AssignmentCounts,
  target: number,
): HitProgress {
  const { submitted, approved, rejected } = counts;
  const open = Math.max(0, hit.MaxAssignments - (approved + rejected + submitted));
  return {
    ...counts,
    open,
    completed: approved >= target,
    shortfall: Math.max(0, target - approved - submitted - open),
  };
}

export function isExpired(hit: Pick<Hit, 'Expiration'>, now: Date): boolean {
  return new Date(hit.Expiration).getTime() <= now.getTime();
}

/**
 * 모든 HIT가 완료되면 completed, 남은 미완료 HIT가 전부 만료됐으면 expired, 그 외는 in_progress.
 * 재모집으로 만료일을 연장한 HIT가 하나라도 살아 있으면 in_progress로 본다.
 */
export function batchStatus(hits: { completed: boolean; expired: boolean }[]): BatchStatus {
  const incomplete = hits.filter((h) => !h.completed);
  if (incomplete.length === 0) return 'completed';
  return incomplete.every((h) => h.expired) ? 'expired' : 'in_progress';
}

export function rejectRate(approved: number, rejected: number): number | null {
  const reviewed = approved + rejected;
  return reviewed === 0 ? null : rejected / reviewed;
}

export function summarizeProgress(hits: HitProgress[]): BatchProgress {
  const sum = (pick: (h: HitProgress) => number) => hits.reduce((acc, h) => acc + pick(h), 0);
  const approved = sum((h) => h.approved);
  const rejected = sum((h) => h.rejected);
  return {
    hitsTotal: hits.length,
    hitsCompleted: hits.filter((h) => h.completed).length,
    submitted: sum((h) => h.submitted),
    approved,
    rejected,
    open: sum((h) => h.open),
    rejectRate: rejectRate(approved, rejected),
  };
}

// ---------------------------------------------------------------------------
// 재모집 (8.3)

/** 처음에 MaxAssignments를 10 미만으로 만든 HIT는 추가해도 합계가 10 이상이 될 수 없다 (MTurk 제약). */
export const MAX_TOTAL_WHEN_CREATED_UNDER_10 = 9;
export const HIGH_VOLUME_THRESHOLD = 10;

export interface TopUpPlan {
  add: number; // 0이면 건너뛴다
  reason?: string; // 건너뛴 사유
}

/**
 * HIT 1개에 assignment를 몇 개 추가할지 정한다. mode가 숫자면 그만큼, 'fill-to-target'이면 부족분만큼이다.
 * 상한을 넘으면 일부만 추가하지 않고 그 HIT를 건너뛴다. 일부만 추가해도 목표를 채울 수 없기 때문이다.
 */
export function planTopUp(
  hit: Pick<Hit, 'MaxAssignments' | 'initialMaxAssignments'>,
  progress: Pick<HitProgress, 'shortfall'>,
  mode: number | 'fill-to-target',
): TopUpPlan {
  const requested = mode === 'fill-to-target' ? progress.shortfall : mode;
  if (!Number.isInteger(requested) || requested < 0) {
    throw new RangeError(`Invalid number of assignments to add: ${String(mode)}`);
  }
  if (requested === 0) {
    return { add: 0, reason: 'No shortfall: open and submitted assignments already cover the target.' };
  }
  if (hit.initialMaxAssignments < HIGH_VOLUME_THRESHOLD) {
    const room = MAX_TOTAL_WHEN_CREATED_UNDER_10 - hit.MaxAssignments;
    if (requested > room) {
      return {
        add: 0,
        reason: `MTurk limit: a HIT created with fewer than 10 assignments cannot exceed ${MAX_TOTAL_WHEN_CREATED_UNDER_10} (now ${hit.MaxAssignments}, requested +${requested}).`,
      };
    }
  }
  return { add: requested };
}
