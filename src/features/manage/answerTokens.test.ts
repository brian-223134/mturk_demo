import { describe, expect, it } from 'vitest';
import { EMPTY_TOKEN, abbreviate, legendEntries } from './answerTokens';

const tokensOf = (values: string[]) => Object.fromEntries(abbreviate(values));

describe('abbreviate', () => {
  it('단어의 첫 글자를 대문자로 이어 붙인다', () => {
    expect(tokensOf(['grounded', 'not_grounded'])).toEqual({ grounded: 'G', not_grounded: 'NG' });
    expect(tokensOf(['Covered', 'Not Covered'])).toEqual({ Covered: 'C', 'Not Covered': 'NC' });
    expect(tokensOf(['partially-covered', 'yes'])).toEqual({ 'partially-covered': 'PC', yes: 'Y' });
  });

  it('겹치면 첫 단어의 글자를 늘려 구분한다', () => {
    expect(tokensOf(['cat', 'car'])).toEqual({ cat: 'Cat', car: 'Car' });
    expect(tokensOf(['cat', 'car', 'dog'])).toEqual({ cat: 'Cat', car: 'Car', dog: 'D' });
    // 두 글자면 구분되므로 거기서 멈춘다
    expect(tokensOf(['grounded', 'good'])).toEqual({ grounded: 'Gr', good: 'Go' });
    expect(tokensOf(['not_grounded', 'nearly_grounded'])).toEqual({ not_grounded: 'NoG', nearly_grounded: 'NeG' });
  });

  it('첫 단어를 다 써도 겹치면 값 전체를 쓴다', () => {
    expect(tokensOf(['cat', 'cats'])).toEqual({ cat: 'cat', cats: 'Cats' });
    expect(tokensOf(['a b', 'a-b'])).toEqual({ 'a b': 'a b', 'a-b': 'a-b' });
  });

  it('대소문자와 앞뒤 공백만 다른 값은 같은 토큰을 받는다 (LLM 라벨 ↔ worker 답)', () => {
    expect(tokensOf(['Not covered', 'Not Covered', 'Covered'])).toEqual({ 'Not covered': 'NC', 'Not Covered': 'NC', Covered: 'C' });
    expect(tokensOf(['grounded', ' Grounded '])).toEqual({ grounded: 'G', ' Grounded ': 'G' });
  });

  it('빈 값과 기호만 있는 값은 약어를 만들지 않는다', () => {
    expect(tokensOf(['', '   ', 'grounded'])).toEqual({ '': EMPTY_TOKEN, '   ': EMPTY_TOKEN, grounded: 'G' });
    expect(tokensOf(['?', '---', 'yes'])).toEqual({ '?': '?', '---': '---', yes: 'Y' });
  });

  it('입력 순서와 중복에 관계없이 같은 결과다', () => {
    const a = tokensOf(['car', 'cat', 'dog', 'cat']);
    const b = tokensOf(['dog', 'cat', 'car']);
    expect(a).toEqual(b);
    expect(abbreviate([])).toEqual(new Map());
  });
});

describe('legendEntries', () => {
  it('토큰 순으로, 토큰과 같은 값은 빼고 표기 차이는 묶는다', () => {
    const tokens = abbreviate(['Not covered', 'Not Covered', 'Covered', '?']);
    expect(legendEntries(tokens)).toEqual([
      { token: 'C', values: ['Covered'] },
      { token: 'NC', values: ['Not Covered', 'Not covered'] },
    ]);
  });
});
