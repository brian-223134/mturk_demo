// 재모집 계산(pages/manage/topUp.js) 검사: 9/10 규칙, 선택한 HIT 의 최대 추가 수, 비용, 결과 문구.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_FIXED_ADD, describeTopUp, feePercent, maxAddable, planBatchTopUp, planTopUp, roomOf, unitCostCents } from '../src/pages/manage/topUp.js';

const hit = (MaxAssignments, initialMaxAssignments = MaxAssignments, shortfall = 0) => ({ MaxAssignments, initialMaxAssignments, progress: { shortfall } });
const batch = (Reward = '0.05', requirements = []) => ({ settings: { Reward, QualificationRequirements: requirements } });

describe('planTopUp (9/10 규칙)', () => {
  it('부족분이 없으면 건너뛴다', () => {
    const plan = planTopUp(hit(3), { shortfall: 0 }, 'fill-to-target');
    assert.equal(plan.add, 0);
    assert.match(plan.reason, /No shortfall/);
  });
  it('10 미만으로 만든 HIT 는 합계 9 를 넘을 수 없다', () => {
    assert.deepEqual(planTopUp(hit(3, 3), { shortfall: 2 }, 'fill-to-target'), { add: 2 });
    assert.deepEqual(planTopUp(hit(3, 3), { shortfall: 0 }, 6), { add: 6 });
    const over = planTopUp(hit(3, 3), { shortfall: 0 }, 7);
    assert.equal(over.add, 0);
    assert.match(over.reason, /cannot exceed 9 \(now 3, requested \+7\)/);
    const full = planTopUp(hit(9, 3), { shortfall: 1 }, 'fill-to-target');
    assert.equal(full.add, 0);
  });
  it('10 이상으로 만든 HIT 는 제한이 없다', () => {
    assert.deepEqual(planTopUp(hit(12, 10), { shortfall: 0 }, 50), { add: 50 });
  });
  it('음수나 정수가 아닌 수는 오류다', () => {
    assert.throws(() => planTopUp(hit(3), { shortfall: 0 }, -1), RangeError);
    assert.throws(() => planTopUp(hit(3), { shortfall: 0 }, 1.5), RangeError);
  });
});

describe('roomOf / maxAddable', () => {
  it('HIT 하나의 남은 자리와 선택 전체의 최소값', () => {
    assert.equal(roomOf(hit(3, 3)), 6);
    assert.equal(roomOf(hit(9, 3)), 0);
    assert.equal(roomOf(hit(10, 10)), Infinity);
    assert.equal(maxAddable([hit(3, 3), hit(6, 3), hit(10, 10)]), 3);
    assert.equal(maxAddable([hit(10, 10)]), Infinity);
    assert.equal(maxAddable([]), Infinity);
    assert.equal(MAX_FIXED_ADD, 8);
  });
});

describe('unitCostCents / planBatchTopUp', () => {
  it('수수료는 MaxAssignments 10 미만 20%, 이상 40%, 최소 1센트', () => {
    assert.equal(feePercent(3, false), 20);
    assert.equal(feePercent(10, false), 40);
    assert.equal(feePercent(3, true), 25);
    assert.equal(unitCostCents(batch('0.05'), hit(3)), 6);
    assert.equal(unitCostCents(batch('0.10'), hit(10)), 14);
    assert.equal(unitCostCents(batch('0.01'), hit(3)), 2);
  });
  it('추가될 수와 비용, 건너뛰는 HIT 수를 한꺼번에 센다', () => {
    const hits = [hit(3, 3, 2), hit(5, 3, 0), hit(9, 3, 1)];
    assert.deepEqual(planBatchTopUp(batch('0.05'), hits, 'fill-to-target'), { addTotal: 2, costCents: 12, hitsAdded: 1, skipped: 2 });
    assert.deepEqual(planBatchTopUp(batch('0.05'), hits, 2), { addTotal: 4, costCents: 24, hitsAdded: 2, skipped: 1 });
  });
});

describe('describeTopUp', () => {
  it('추가, 연장, 건너뜀을 문장으로 만든다', () => {
    const { title, lines } = describeTopUp({
      added: [{ HITId: 'a', count: 2, expirationExtended: true }, { HITId: 'b', count: 0, expirationExtended: true }],
      skipped: [{ HITId: 'c', reason: 'MTurk limit' }, { HITId: 'd', reason: 'MTurk limit' }],
    });
    assert.equal(title, 'Top-up done');
    assert.deepEqual(lines, ['Added 2 assignment(s) across 1 HIT(s).', 'Extended the expiration of 2 expired HIT(s) so workers can see them again.', 'Skipped 2 HIT(s): MTurk limit']);
  });
  it('아무것도 없으면 그렇다고 말한다', () => {
    assert.deepEqual(describeTopUp({ added: [], skipped: [] }), { title: 'Nothing to top up', lines: ['No HITs needed more assignments.'] });
  });
});
