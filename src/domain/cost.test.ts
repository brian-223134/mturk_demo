import { describe, expect, it } from 'vitest';
import {
  MASTERS_QUALIFICATION_TYPE_IDS,
  batchCost,
  estimateCost,
  feeCentsPerAssignment,
  feePercent,
  formatCents,
  rewardToCents,
  usesMasters,
} from './cost';

describe('rewardToCents', () => {
  it('MTurk의 문자열 Reward를 센트로 바꾼다', () => {
    expect(rewardToCents('0.10')).toBe(10);
    expect(rewardToCents('0.05')).toBe(5);
    expect(rewardToCents('1.15')).toBe(115); // 1.15 * 100 = 114.99999999999999
  });

  it('숫자가 아니거나 음수면 오류', () => {
    expect(() => rewardToCents('')).toThrow(RangeError);
    expect(() => rewardToCents('-0.10')).toThrow(RangeError);
  });
});

describe('feePercent', () => {
  it('기본 20%, MaxAssignments ≥ 10이면 40%, Masters면 +5%p', () => {
    expect(feePercent(3, false)).toBe(20);
    expect(feePercent(9, false)).toBe(20);
    expect(feePercent(10, false)).toBe(40);
    expect(feePercent(3, true)).toBe(25);
    expect(feePercent(10, true)).toBe(45);
  });
});

describe('feeCentsPerAssignment', () => {
  it('assignment당 최소 수수료는 $0.01', () => {
    expect(feeCentsPerAssignment(10, 20)).toBe(2);
    expect(feeCentsPerAssignment(5, 20)).toBe(1);
    expect(feeCentsPerAssignment(2, 20)).toBe(1); // 0.4센트 → 1센트
  });
});

describe('estimateCost', () => {
  it('명세 8.1의 예: 160 HIT × 3명 × $0.10 = $48.00 + 수수료 $9.60 = $57.60', () => {
    const cost = estimateCost({ hitCount: 160, maxAssignments: 3, reward: '0.10', masters: false });
    expect(cost).toEqual({ rewardCents: 4800, feeCents: 960, totalCents: 5760, feePercent: 20 });
  });

  it('MaxAssignments가 10 이상이면 수수료 40%', () => {
    const cost = estimateCost({ hitCount: 10, maxAssignments: 10, reward: '0.10', masters: false });
    expect(cost).toMatchObject({ rewardCents: 1000, feeCents: 400, totalCents: 1400 });
  });

  it('reward가 작으면 최소 수수료가 적용된다', () => {
    const cost = estimateCost({ hitCount: 100, maxAssignments: 3, reward: '0.02', masters: false });
    expect(cost).toMatchObject({ rewardCents: 600, feeCents: 300, totalCents: 900 });
  });
});

describe('usesMasters', () => {
  it('Masters Qualification 조건이 있는지 본다', () => {
    expect(usesMasters([])).toBe(false);
    expect(
      usesMasters([{ QualificationTypeId: '000000000000000000L0', Comparator: 'GreaterThanOrEqualTo' }]),
    ).toBe(false);
    expect(
      usesMasters([{ QualificationTypeId: MASTERS_QUALIFICATION_TYPE_IDS[0]!, Comparator: 'Exists' }]),
    ).toBe(true);
  });
});

describe('batchCost', () => {
  it('지출은 Approved만, 예상은 반려를 뺀 모든 자리', () => {
    const cost = batchCost(
      [
        { MaxAssignments: 3, approved: 3, rejected: 0 },
        { MaxAssignments: 4, approved: 2, rejected: 1 }, // 1건 반려 후 1건 재모집, 1자리 남음
      ],
      '0.10',
      false,
    );
    expect(cost.spentCents).toBe(5 * 12);
    expect(cost.estimatedCents).toBe((3 + 3) * 12);
  });
});

describe('formatCents', () => {
  it('달러로 표시한다', () => {
    expect(formatCents(5760)).toBe('$57.60');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(2.4)).toBe('$0.02');
  });
});
