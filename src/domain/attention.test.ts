import { describe, expect, it } from 'vitest';
import type { AttentionRule } from '../api/types';
import { isAttentionName, judgeAttention } from './attention';

const rule: AttentionRule = {
  namePrefix: 'attention_',
  expectedValue: 'not_grounded',
  minCorrectRatio: 1.0,
};

describe('isAttentionName', () => {
  it('prefix로 시작하는 name만 attention 문항이다', () => {
    expect(isAttentionName('attention_10_1')).toBe(true);
    expect(isAttentionName('general_0_1')).toBe(false);
    expect(isAttentionName('general_attention_1')).toBe(false);
    expect(isAttentionName('check_1', 'check_')).toBe(true);
  });
});

describe('judgeAttention', () => {
  it('attention 문항이 전부 정답이면 통과', () => {
    const result = judgeAttention(
      [
        { name: 'general_0_1', value: 'grounded' },
        { name: 'attention_10_1', value: 'not_grounded' },
        { name: 'attention_10_2', value: 'not_grounded' },
      ],
      rule,
    );
    expect(result).toEqual({ total: 2, correct: 2, passed: true });
  });

  it('기준이 1.0이면 하나만 틀려도 미통과', () => {
    const result = judgeAttention(
      [
        { name: 'attention_10_1', value: 'grounded' },
        { name: 'attention_10_2', value: 'not_grounded' },
      ],
      rule,
    );
    expect(result).toEqual({ total: 2, correct: 1, passed: false });
  });

  it('minCorrectRatio를 낮추면 일부 오답도 통과', () => {
    const answers = [
      { name: 'attention_1', value: 'not_grounded' },
      { name: 'attention_2', value: 'not_grounded' },
      { name: 'attention_3', value: 'grounded' },
    ];
    expect(judgeAttention(answers, { ...rule, minCorrectRatio: 2 / 3 })?.passed).toBe(true);
    expect(judgeAttention(answers, { ...rule, minCorrectRatio: 0.7 })?.passed).toBe(false);
  });

  it('실제 문항의 값은 판정에 영향을 주지 않는다', () => {
    const result = judgeAttention(
      [
        { name: 'general_0_1', value: 'not_grounded' },
        { name: 'attention_10_1', value: 'grounded' },
      ],
      rule,
    );
    expect(result).toEqual({ total: 1, correct: 0, passed: false });
  });

  it('정답 값은 표기까지 같아야 한다 (템플릿마다 표기가 다르다)', () => {
    const answers = [{ name: 'attention_4_1_coverage', value: 'Not Covered' }];
    expect(judgeAttention(answers, { ...rule, expectedValue: 'Not Covered' })?.passed).toBe(true);
    expect(judgeAttention(answers, { ...rule, expectedValue: 'not_covered' })?.passed).toBe(false);
  });

  it('attention 문항이 없거나 rule이 없으면 null(판정 불가)', () => {
    expect(judgeAttention([{ name: 'general_0_coverage', value: 'Yes' }], rule)).toBeNull();
    expect(judgeAttention([], rule)).toBeNull();
    expect(judgeAttention([{ name: 'attention_1', value: 'not_grounded' }], null)).toBeNull();
  });
});
