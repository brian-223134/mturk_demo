// lib/api-usage.js: admin 의 API usage 화면이 최근 호출을 현지 날짜로 묶고 오늘·7일·30일 합계를 내는 계산.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ACCOUNT_ROUTES } from '../src/api-client/routes.js';
import { formatUsd, summarizeUsage } from '../src/lib/api-usage.js';

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).toISOString();

describe('summarizeUsage', () => {
  const now = new Date(2026, 10, 11, 15); // 11월 11일 15시 (현지)
  const rows = [
    { at: at(2026, 11, 11, 9), calls: 1, tokens: 100, cost: 0.002 },
    { at: at(2026, 11, 11, 1), calls: 2, tokens: 50, cost: null },
    { at: at(2026, 11, 5), calls: 1, tokens: 10, cost: 0.01 },
    { at: at(2026, 11, 4), calls: 1, tokens: 10, cost: 0.1 },
    { at: at(2026, 10, 20), calls: 4, tokens: 40, cost: 1 },
  ];

  it('오늘, 오늘을 포함한 7일, 30일의 합계를 내고 가격이 없는 호출은 따로 센다', () => {
    const summary = summarizeUsage(rows, now);
    assert.deepEqual(summary.today, { calls: 3, tokens: 150, cost: 0.002, unpriced: 1 });
    assert.equal(summary.last7.calls, 4);
    assert.ok(Math.abs(summary.last7.cost - 0.012) < 1e-9);
    assert.equal(summary.last30.calls, 9);
    assert.ok(Math.abs(summary.last30.cost - 1.112) < 1e-9);
  });

  it('현지 날짜로 묶고 최근 날짜부터 놓는다', () => {
    const { byDay } = summarizeUsage(rows, now);
    assert.deepEqual(byDay.map((d) => d.day), ['2026-11-11', '2026-11-05', '2026-11-04', '2026-10-20']);
    assert.equal(byDay[0].calls, 3);
  });

  it('기록이 없으면 모두 0 이다', () => {
    assert.deepEqual(summarizeUsage([], now), { today: { calls: 0, tokens: 0, cost: 0, unpriced: 0 }, last7: { calls: 0, tokens: 0, cost: 0, unpriced: 0 }, last30: { calls: 0, tokens: 0, cost: 0, unpriced: 0 }, byDay: [] });
  });
});

describe('formatUsd', () => {
  it('작은 값은 넷째 자리까지, 큰 값은 둘째 자리까지 보인다', () => {
    assert.equal(formatUsd(0.00234), '$0.0023');
    assert.equal(formatUsd(222.991), '$222.99');
    assert.equal(formatUsd(0.00001), '<$0.0001');
    assert.equal(formatUsd(0), '$0');
    assert.equal(formatUsd(null), '—');
  });
});

describe('getApiUsage 경로', () => {
  it('admin 아래에 있다 (backend 와의 대조는 backend 테스트가 한다)', () => {
    assert.deepEqual(ACCOUNT_ROUTES.getApiUsage, { method: 'GET', path: '/admin/usage', args: [] });
  });
});
