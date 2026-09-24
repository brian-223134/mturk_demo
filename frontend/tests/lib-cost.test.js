// lib/cost.js: 비용 견적. 기대값은 prototype/src/domain/cost.test.ts 에서 왔다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MASTERS_QUALIFICATION_TYPE_IDS,
  batchCost,
  estimateCost,
  feeCentsPerAssignment,
  feePercent,
  formatCents,
  rewardToCents,
  usesMasters,
} from '../src/lib/cost.js';

describe('rewardToCents', () => {
  it('MTurk 의 문자열 Reward 를 센트로 바꾼다', () => {
    assert.equal(rewardToCents('0.10'), 10);
    assert.equal(rewardToCents('0.05'), 5);
    assert.equal(rewardToCents('1.15'), 115); // 1.15 * 100 = 114.99999999999999
  });

  it('숫자가 아니거나 음수면 오류', () => {
    assert.throws(() => rewardToCents(''), RangeError);
    assert.throws(() => rewardToCents('-0.10'), RangeError);
  });
});

describe('feePercent', () => {
  it('기본 20%, MaxAssignments ≥ 10 이면 40%, Masters 면 +5%p', () => {
    assert.equal(feePercent(3, false), 20);
    assert.equal(feePercent(9, false), 20);
    assert.equal(feePercent(10, false), 40);
    assert.equal(feePercent(3, true), 25);
    assert.equal(feePercent(10, true), 45);
  });
});

describe('feeCentsPerAssignment', () => {
  it('assignment 당 최소 수수료는 $0.01', () => {
    assert.equal(feeCentsPerAssignment(10, 20), 2);
    assert.equal(feeCentsPerAssignment(5, 20), 1);
    assert.equal(feeCentsPerAssignment(2, 20), 1); // 0.4센트 → 1센트
  });
});

describe('estimateCost', () => {
  it('명세의 예: 160 HIT × 3명 × $0.10 = $48.00 + 수수료 $9.60 = $57.60', () => {
    assert.deepEqual(estimateCost({ hitCount: 160, maxAssignments: 3, reward: '0.10', masters: false }), {
      rewardCents: 4800,
      feeCents: 960,
      totalCents: 5760,
      feePercent: 20,
    });
  });

  it('예시 파일(10행)과 기본 설정: $3.00 + $0.60 = $3.60', () => {
    assert.deepEqual(estimateCost({ hitCount: 10, maxAssignments: 3, reward: '0.10', masters: false }), {
      rewardCents: 300,
      feeCents: 60,
      totalCents: 360,
      feePercent: 20,
    });
  });

  it('MaxAssignments 가 10 이상이면 수수료 40%', () => {
    const cost = estimateCost({ hitCount: 10, maxAssignments: 10, reward: '0.10', masters: false });
    assert.equal(cost.rewardCents, 1000);
    assert.equal(cost.feeCents, 400);
    assert.equal(cost.totalCents, 1400);
  });

  it('reward 가 작으면 최소 수수료가 적용된다', () => {
    const cost = estimateCost({ hitCount: 100, maxAssignments: 3, reward: '0.02', masters: false });
    assert.equal(cost.rewardCents, 600);
    assert.equal(cost.feeCents, 300);
    assert.equal(cost.totalCents, 900);
  });
});

describe('usesMasters', () => {
  it('Masters Qualification 조건이 있는지 본다', () => {
    assert.equal(usesMasters([]), false);
    assert.equal(usesMasters([{ QualificationTypeId: '000000000000000000L0', Comparator: 'GreaterThanOrEqualTo' }]), false);
    assert.equal(usesMasters([{ QualificationTypeId: MASTERS_QUALIFICATION_TYPE_IDS[0], Comparator: 'Exists' }]), true);
  });
});

describe('batchCost', () => {
  it('지출은 Approved 만, 예상은 반려를 뺀 모든 자리', () => {
    const cost = batchCost(
      [
        { MaxAssignments: 3, approved: 3, rejected: 0 },
        { MaxAssignments: 4, approved: 2, rejected: 1 }, // 1건 반려 후 1건 재모집, 1자리 남음
      ],
      '0.10',
      false,
    );
    assert.equal(cost.spentCents, 5 * 12);
    assert.equal(cost.estimatedCents, (3 + 3) * 12);
  });
});

describe('formatCents', () => {
  it('달러로 표시한다', () => {
    assert.equal(formatCents(5760), '$57.60');
    assert.equal(formatCents(0), '$0.00');
    assert.equal(formatCents(2.4), '$0.02');
  });
});
