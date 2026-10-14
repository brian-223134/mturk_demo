// pages/manage/iaa.js: Results 의 범위별 IAA 표 (세 범위, 해석 구간, 문항 범위 문구).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { IAA_SCOPES, alphaBand, iaaRow, kappaBand } from '../src/pages/manage/iaa.js';

// backend 테스트의 시작 데이터 batch-1000001 값
const IAA = {
  approved: { assignments: 108, workers: 27, items: 420, fleissKappa: 0.730594, kappaItemCount: 420, krippendorffAlpha: 0.730808, alphaItemCount: 420 },
  pending: { assignments: 6, workers: 6, items: 70, fleissKappa: null, kappaItemCount: 0, krippendorffAlpha: 0.242277, alphaItemCount: 70 },
  submitted: { assignments: 114, workers: 29, items: 490, fleissKappa: 0.730594, kappaItemCount: 420, krippendorffAlpha: 0.710026, alphaItemCount: 490 },
};

describe('IAA bands', () => {
  it('κ 는 Landis & Koch, α 는 Krippendorff 의 0.800 / 0.667 구간이다', () => {
    assert.deepEqual([-0.1, 0.1, 0.3, 0.5, 0.7, 0.9].map(kappaBand), ['poor', 'slight', 'fair', 'moderate', 'substantial', 'almost perfect']);
    assert.deepEqual([0.85, 0.8, 0.7, 0.667, 0.66].map(alphaBand), ['reliable', 'reliable', 'tentative', 'tentative', 'unreliable']);
  });
});

describe('iaaRow', () => {
  it('값, 해석, 그 값을 계산한 문항 범위와 응답 수를 글로 만든다', () => {
    assert.deepEqual(iaaRow(IAA.submitted, 3), {
      kappa: '0.731', kappaBand: 'substantial', kappaCoverage: '420 of 490 items × 3 votes',
      alpha: '0.710', alphaBand: 'tentative', alphaCoverage: '490 items with 2+ votes',
      responses: '114 responses from 29 workers',
    });
    // 검수 대기 응답만으로는 투표가 3건인 문항이 없어 κ 를 계산할 수 없다
    const pending = iaaRow(IAA.pending, 3);
    assert.deepEqual([pending.kappa, pending.kappaBand, pending.alpha, pending.alphaBand], ['–', 'not enough votes', '0.242', 'unreliable']);
    const empty = iaaRow({ assignments: 1, workers: 1, items: 1, fleissKappa: null, kappaItemCount: 0, krippendorffAlpha: null, alphaItemCount: 0 }, 3);
    assert.equal(empty.kappaBand, 'not enough votes');
    assert.equal(empty.alphaCoverage, '0 items with 2+ votes');
    assert.equal(empty.responses, '1 response from 1 worker');
    assert.deepEqual(IAA_SCOPES.map((s) => s.key), ['approved', 'pending', 'submitted']);
  });
});
