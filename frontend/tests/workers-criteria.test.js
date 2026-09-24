// "조건으로 채우기"의 판정(pages/workers/fillByCriteria.js)과 표 선택(components/selection.js) 검사.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSelection } from '../src/components/selection.js';
import { DEFAULT_CRITERIA, eligibleWorkers, matchesCriteria } from '../src/pages/workers/fillByCriteria.js';

const worker = (WorkerId, stats, extra = {}) => ({
  WorkerId,
  stats: { approved: 0, rejectRate: null, attentionFailRate: null, majorityAgreement: null, ...stats },
  poolIds: [],
  blocked: false,
  ...extra,
});

describe('matchesCriteria', () => {
  const good = worker('W1', { approved: 20, attentionFailRate: 0, majorityAgreement: 0.95, rejectRate: 0.1 });
  it('기본 조건: 승인 ≥ 20, attention 실패 0%, 일치율 ≥ 90%', () => {
    assert.equal(matchesCriteria(good, DEFAULT_CRITERIA), true);
    assert.equal(matchesCriteria(worker('W2', { approved: 19, attentionFailRate: 0, majorityAgreement: 0.95 }), DEFAULT_CRITERIA), false);
    assert.equal(matchesCriteria(worker('W3', { approved: 20, attentionFailRate: 0.05, majorityAgreement: 0.95 }), DEFAULT_CRITERIA), false);
    assert.equal(matchesCriteria(worker('W4', { approved: 20, attentionFailRate: 0, majorityAgreement: 0.89 }), DEFAULT_CRITERIA), false);
  });
  it('null 인 조건은 쓰지 않고, 값이 null 인 worker 는 그 조건을 만족하지 않는다', () => {
    assert.equal(matchesCriteria(worker('W5', { approved: 3 }), { minApproved: 1, maxAttentionFailPercent: null, minAgreementPercent: null, maxRejectPercent: null }), true);
    assert.equal(matchesCriteria(worker('W6', { approved: 3 }), { minApproved: 1, maxAttentionFailPercent: 100, minAgreementPercent: null, maxRejectPercent: null }), false);
    assert.equal(matchesCriteria(good, { ...DEFAULT_CRITERIA, maxRejectPercent: 5 }), false);
    assert.equal(matchesCriteria(good, { ...DEFAULT_CRITERIA, maxRejectPercent: 10 }), true);
  });
  it('% 는 0–1 비율과 반올림 오차 없이 비교한다', () => {
    assert.equal(matchesCriteria(worker('W7', { approved: 1, majorityAgreement: 0.9 }), { minApproved: 0, maxAttentionFailPercent: null, minAgreementPercent: 90, maxRejectPercent: null }), true);
    assert.equal(matchesCriteria(worker('W8', { approved: 1, attentionFailRate: 1 / 3 }), { minApproved: 0, maxAttentionFailPercent: 33.3, minAgreementPercent: null, maxRejectPercent: null }), false);
  });
});

describe('eligibleWorkers', () => {
  const pool = { id: 'pool-trusted', name: 'Trusted', workerIds: ['W1'] };
  const workers = [
    worker('W1', { approved: 20, attentionFailRate: 0, majorityAgreement: 0.95 }),
    worker('W2', { approved: 8, attentionFailRate: 0, majorityAgreement: 0.92 }),
    worker('W3', { approved: 12, attentionFailRate: 0, majorityAgreement: 0.91 }, { blocked: true }),
    worker('W4', { approved: 6, attentionFailRate: 0, majorityAgreement: 0.99 }),
    worker('W5', { approved: 30, attentionFailRate: 0.5, majorityAgreement: 0.99 }),
  ];
  it('이미 pool 에 있는 worker 는 빼고, 차단한 worker 는 따로 세며, 승인 수 순으로 정렬한다', () => {
    const { eligible, blocked } = eligibleWorkers(workers, { ...DEFAULT_CRITERIA, minApproved: 5 }, pool);
    assert.deepEqual(eligible.map((w) => w.WorkerId), ['W2', 'W4']);
    assert.deepEqual(blocked.map((w) => w.WorkerId), ['W3']);
  });
  it('기본 조건으로는 W1 만 맞지만 이미 pool 에 있어 0명이다', () => {
    assert.deepEqual(eligibleWorkers(workers, DEFAULT_CRITERIA, pool), { eligible: [], blocked: [] });
  });
});

describe('createSelection', () => {
  const rows = [{ id: 'a', s: 'Submitted' }, { id: 'b', s: 'Submitted' }, { id: 'c', s: 'Approved' }];
  it('toggle, setAll, invert, clear 가 키로 행을 관리하고 구독자에게 알린다', () => {
    const sel = createSelection((r) => r.id);
    let calls = 0;
    sel.subscribe(() => (calls += 1));
    sel.toggle(rows[0]);
    assert.equal(sel.size, 1);
    assert.ok(sel.has(rows[0]) && sel.hasKey('a'));
    sel.setAll(rows, true);
    assert.equal(sel.size, 3);
    assert.ok(sel.allSelected(rows));
    sel.invert(rows.slice(0, 2)); // a, b 해제
    assert.deepEqual(sel.keys(), ['c']);
    assert.ok(sel.someSelected(rows) && !sel.allSelected(rows));
    sel.replace([rows[1]]);
    assert.deepEqual(sel.values(), [rows[1]]);
    sel.clear();
    assert.equal(sel.size, 0);
    assert.equal(calls, 5);
  });
  it('같은 키의 새 행으로 바꾸면 값이 갱신된다', () => {
    const sel = createSelection((r) => r.id);
    sel.toggle(rows[0], true);
    sel.toggle({ id: 'a', s: 'Rejected' }, true);
    assert.equal(sel.values()[0].s, 'Rejected');
    assert.equal(sel.size, 1);
  });
});
