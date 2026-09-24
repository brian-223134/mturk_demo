import { describe, expect, it } from 'vitest';
import {
  batchStatus,
  countByStatus,
  hitProgress,
  isExpired,
  rejectRate,
  summarizeProgress,
} from './progress';

describe('countByStatus', () => {
  it('상태별로 센다', () => {
    const counts = countByStatus([
      { AssignmentStatus: 'Approved' },
      { AssignmentStatus: 'Approved' },
      { AssignmentStatus: 'Rejected' },
      { AssignmentStatus: 'Submitted' },
    ]);
    expect(counts).toEqual({ submitted: 1, approved: 2, rejected: 1 });
  });
});

describe('hitProgress', () => {
  const target = 3;

  it('승인이 target만큼 차면 완료', () => {
    const p = hitProgress({ MaxAssignments: 3 }, { submitted: 0, approved: 3, rejected: 0 }, target);
    expect(p).toMatchObject({ open: 0, completed: true, shortfall: 0 });
  });

  it('반려는 자리를 다시 열어 주지 않으므로 그만큼 부족분이 된다', () => {
    const p = hitProgress({ MaxAssignments: 3 }, { submitted: 0, approved: 2, rejected: 1 }, target);
    expect(p).toMatchObject({ open: 0, completed: false, shortfall: 1 });
  });

  it('검수 대기와 열린 자리는 아직 부족분이 아니다', () => {
    const p = hitProgress({ MaxAssignments: 3 }, { submitted: 1, approved: 1, rejected: 0 }, target);
    expect(p).toMatchObject({ open: 1, completed: false, shortfall: 0 });
  });

  it('재모집으로 MaxAssignments가 늘어난 HIT', () => {
    // 3으로 시작해 2건 반려, 2건 재모집: 승인 1 + 반려 2 + 제출 1 + 열림 1
    const p = hitProgress({ MaxAssignments: 5 }, { submitted: 1, approved: 1, rejected: 2 }, target);
    expect(p).toMatchObject({ open: 1, completed: false, shortfall: 0 });
  });

  it('assignment가 MaxAssignments보다 많아도 open은 음수가 되지 않는다', () => {
    const p = hitProgress({ MaxAssignments: 3 }, { submitted: 0, approved: 4, rejected: 0 }, target);
    expect(p.open).toBe(0);
  });
});

describe('isExpired', () => {
  it('만료 시각이 지났는지 본다', () => {
    const hit = { Expiration: '2025-11-08T07:30:20Z' };
    expect(isExpired(hit, new Date('2025-11-08T07:30:19Z'))).toBe(false);
    expect(isExpired(hit, new Date('2025-11-08T07:30:20Z'))).toBe(true);
  });
});

describe('batchStatus', () => {
  it('모든 HIT가 완료되면 completed (만료 여부와 무관)', () => {
    expect(batchStatus([{ completed: true, expired: true }])).toBe('completed');
  });

  it('미완료 HIT가 전부 만료됐으면 expired', () => {
    expect(
      batchStatus([
        { completed: true, expired: true },
        { completed: false, expired: true },
      ]),
    ).toBe('expired');
  });

  it('살아 있는 미완료 HIT가 하나라도 있으면 in_progress', () => {
    expect(
      batchStatus([
        { completed: false, expired: true },
        { completed: false, expired: false },
      ]),
    ).toBe('in_progress');
  });
});

describe('rejectRate', () => {
  it('반려 / (승인 + 반려). 검수한 건이 없으면 null', () => {
    expect(rejectRate(108, 18)).toBeCloseTo(18 / 126);
    expect(rejectRate(0, 0)).toBeNull();
  });
});

describe('summarizeProgress', () => {
  it('HIT별 진행률을 batch 단위로 합친다', () => {
    const summary = summarizeProgress([
      hitProgress({ MaxAssignments: 3 }, { submitted: 0, approved: 3, rejected: 0 }, 3),
      hitProgress({ MaxAssignments: 4 }, { submitted: 1, approved: 1, rejected: 1 }, 3),
    ]);
    expect(summary).toEqual({
      hitsTotal: 2,
      hitsCompleted: 1,
      submitted: 1,
      approved: 4,
      rejected: 1,
      open: 1,
      rejectRate: 1 / 5,
    });
  });
});
