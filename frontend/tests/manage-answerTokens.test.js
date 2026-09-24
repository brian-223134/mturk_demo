// Review 표의 Answers 열에 쓰는 약어(pages/manage/answerTokens.js) 검사. prototype 의 answerTokens.test.ts 와 같은 사례다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EMPTY_TOKEN, abbreviate, legendEntries, normalizeLabel, tokenWidthOf } from '../src/pages/manage/answerTokens.js';

const tokensOf = (values) => Object.fromEntries(abbreviate(values));

describe('abbreviate', () => {
  it('단어의 첫 글자를 대문자로 이어 붙인다', () => {
    assert.deepEqual(tokensOf(['grounded', 'not_grounded']), { grounded: 'G', not_grounded: 'NG' });
    assert.deepEqual(tokensOf(['Covered', 'Not Covered']), { Covered: 'C', 'Not Covered': 'NC' });
    assert.deepEqual(tokensOf(['partially-covered', 'yes']), { 'partially-covered': 'PC', yes: 'Y' });
  });

  it('겹치면 첫 단어의 글자를 늘려 구분한다', () => {
    assert.deepEqual(tokensOf(['cat', 'car']), { cat: 'Cat', car: 'Car' });
    assert.deepEqual(tokensOf(['cat', 'car', 'dog']), { cat: 'Cat', car: 'Car', dog: 'D' });
    assert.deepEqual(tokensOf(['grounded', 'good']), { grounded: 'Gr', good: 'Go' });
    assert.deepEqual(tokensOf(['not_grounded', 'nearly_grounded']), { not_grounded: 'NoG', nearly_grounded: 'NeG' });
  });

  it('첫 단어를 다 써도 겹치면 값 전체를 쓴다', () => {
    assert.deepEqual(tokensOf(['cat', 'cats']), { cat: 'cat', cats: 'Cats' });
    assert.deepEqual(tokensOf(['a b', 'a-b']), { 'a b': 'a b', 'a-b': 'a-b' });
  });

  it('대소문자와 앞뒤 공백만 다른 값은 같은 토큰을 받는다 (LLM 라벨 ↔ worker 답)', () => {
    assert.deepEqual(tokensOf(['Not covered', 'Not Covered', 'Covered']), { 'Not covered': 'NC', 'Not Covered': 'NC', Covered: 'C' });
    assert.deepEqual(tokensOf(['grounded', ' Grounded ']), { grounded: 'G', ' Grounded ': 'G' });
  });

  it('빈 값과 기호만 있는 값은 약어를 만들지 않는다', () => {
    assert.deepEqual(tokensOf(['', '   ', 'grounded']), { '': EMPTY_TOKEN, '   ': EMPTY_TOKEN, grounded: 'G' });
    assert.deepEqual(tokensOf(['?', '---', 'yes']), { '?': '?', '---': '---', yes: 'Y' });
  });

  it('입력 순서와 중복에 관계없이 같은 결과다', () => {
    assert.deepEqual(tokensOf(['car', 'cat', 'dog', 'cat']), tokensOf(['dog', 'cat', 'car']));
    assert.deepEqual(abbreviate([]), new Map());
  });
});

describe('legendEntries', () => {
  it('토큰 순으로, 토큰과 같은 값은 빼고 표기 차이는 묶는다', () => {
    const tokens = abbreviate(['Not covered', 'Not Covered', 'Covered', '?']);
    assert.deepEqual(legendEntries(tokens), [
      { token: 'C', values: ['Covered'] },
      { token: 'NC', values: ['Not Covered', 'Not covered'] },
    ]);
  });
});

describe('tokenWidthOf / normalizeLabel', () => {
  it('가장 긴 토큰 + 1ch, 12ch 에서 자른다', () => {
    assert.equal(tokenWidthOf(new Map()), 2);
    assert.equal(tokenWidthOf(abbreviate(['grounded', 'not_grounded'])), 3);
    assert.equal(tokenWidthOf(new Map([['x', 'a-very-long-token-value']])), 13);
  });
  it('normalizeLabel 은 앞뒤 공백을 지우고 소문자로 만든다', () => {
    assert.equal(normalizeLabel('  Not Covered '), 'not covered');
    assert.equal(normalizeLabel(1), '1');
  });
});
