// lib/layout-check.js: 요청한 배치대로인지의 자동 확인. 측정(measureLayout)은 실제로 그려야 해서 브라우저 검사가 맡고,
// 여기서는 판정 결과를 다시 묻는 글로 바꾸는 부분과, 측정 함수가 미리보기 bridge 에 들어가는지를 본다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fixedFromOutline, layoutNotes, layoutRequest, layoutSummary, measureLayout } from '../src/lib/layout-check.js';
import { renderTemplate } from '../src/lib/template.js';

const checks = [
  { wish: 'question at the top', result: 'met', evidence: 'first block' },
  { wish: 'facts on the right', result: 'not_met', evidence: 'facts start at x 0%' },
  { wish: 'green option', result: 'unclear', evidence: '' },
];

describe('layout-check', () => {
  it('맞지 않은 바람만 다시 묻는 글로 바꾸고, unclear 는 보내지 않는다', () => {
    assert.deepEqual(layoutNotes(checks), ['Not as requested: facts on the right (facts start at x 0%)']);
    assert.deepEqual(layoutNotes([]), []);
    assert.deepEqual(layoutNotes(undefined), []);
  });

  it('결과를 센다', () => {
    assert.deepEqual(layoutSummary(checks), { met: 1, not_met: 1, unclear: 1 });
  });

  it('판정 요청에는 요청 문장, 측정값, 페이지가 바꿀 수 없는 규칙이 들어간다', () => {
    const request = layoutRequest('Put it left.', { width: 1, blocks: [] }, ['X is fixed.']);
    assert.equal(request.request, 'Put it left.');
    assert.deepEqual(request.page, { width: 1, blocks: [] });
    assert.ok(request.fixed.some((rule) => rule.includes('never shown to workers')));
    assert.ok(request.fixed.some((rule) => rule.includes('header above its options')), '문항 제목을 숨기라는 판정이 나오지 않게');
    assert.equal(request.fixed.at(-1), 'X is fixed.');
  });

  it('항목마다 다른 값은 한 번만 보일 수 없다는 규칙이 된다', () => {
    const fixed = fixedFromOutline({ values: [{ label: 'Query', perItem: true }, { label: 'Title', perItem: false }] });
    assert.deepEqual(fixed, ['"Query" differs between items, so it is shown once for each item, never once for the whole page.']);
  });

  it('측정 함수는 미리보기 iframe 안에서 그대로 돌도록 bridge 에 들어가 측정값을 보낸다', () => {
    const page = renderTemplate('<p>x</p>', {}, { preview: true });
    assert.ok(page.includes('var measureLayout = function measureLayout(doc, win)'));
    assert.ok(page.includes("send({ type: 'layout', page: page })"));
    assert.ok(!/=>/.test(measureLayout.toString()), 'ES5 로 써야 iframe 안에서 그대로 돈다');
  });
});
