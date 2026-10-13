// pages/manage/iaa.js: Results 의 범위별 IAA 표 (해석 구간, 검수 전후 변화, 문항 범위 문구).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IAA_SCOPES, alphaBand, formatChange, iaaChange, iaaRow, kappaBand } from '../src/pages/manage/iaa.js';

// backend 테스트의 시작 데이터 batch-1000001 값
const IAA = {
  submitted: { assignments: 132, workers: 31, items: 520, fleissKappa: 0.598084, kappaItemCount: 310, krippendorffAlpha: 0.411499, alphaItemCount: 520 },
  approved: { assignments: 108, workers: 27, items: 420, fleissKappa: 0.730594, kappaItemCount: 420, krippendorffAlpha: 0.730808, alphaItemCount: 420 },
};

describe('IAA bands', () => {
  it('κ 는 Landis & Koch, α 는 Krippendorff 의 0.800 / 0.667 구간이다', () => {
    assert.deepEqual([-0.1, 0.1, 0.3, 0.5, 0.7, 0.9].map(kappaBand), ['poor', 'slight', 'fair', 'moderate', 'substantial', 'almost perfect']);
    assert.deepEqual([0.85, 0.8, 0.7, 0.667, 0.66].map(alphaBand), ['reliable', 'reliable', 'tentative', 'tentative', 'unreliable']);
  });
});

describe('iaaChange / formatChange', () => {
  it('승인만 − 제출 전체를 부호와 함께 보이고, 값이 없으면 —', () => {
    assert.equal(formatChange(iaaChange(IAA, 'krippendorffAlpha')), '+0.319');
    assert.equal(formatChange(iaaChange(IAA, 'fleissKappa')), '+0.133');
    assert.equal(formatChange(-0.0108), '−0.011');
    assert.equal(formatChange(0), '±0.000');
    assert.equal(iaaChange({ submitted: { fleissKappa: null }, approved: { fleissKappa: 0.5 } }, 'fleissKappa'), null);
    assert.equal(formatChange(null), '—');
  });
});

describe('iaaRow', () => {
  it('값, 해석, 그 값을 계산한 문항 범위와 응답 수를 글로 만든다', () => {
    assert.deepEqual(iaaRow(IAA.submitted, 3), {
      kappa: '0.598', kappaBand: 'moderate', kappaCoverage: '310 of 520 items × 3 votes',
      alpha: '0.411', alphaBand: 'unreliable', alphaCoverage: '520 items with 2+ votes',
      responses: '132 responses from 31 workers',
    });
    const empty = iaaRow({ assignments: 1, workers: 1, items: 1, fleissKappa: null, kappaItemCount: 0, krippendorffAlpha: null, alphaItemCount: 0 }, 3);
    assert.equal(empty.kappaBand, 'not enough votes');
    assert.equal(empty.alphaCoverage, '0 items with 2+ votes');
    assert.equal(empty.responses, '1 response from 1 worker');
    assert.deepEqual(IAA_SCOPES.map((s) => s.key), ['submitted', 'approved']);
  });
});
