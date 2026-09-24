// 8.2 Attention 판정

import type { AnswerItem, AttentionResult, AttentionRule } from '../api/types';

export const DEFAULT_ATTENTION_PREFIX = 'attention_';

export function isAttentionName(name: string, prefix: string = DEFAULT_ATTENTION_PREFIX): boolean {
  return name.startsWith(prefix);
}

/**
 * name이 `namePrefix`로 시작하는 항목 중 값이 `expectedValue`와 같은 비율이 `minCorrectRatio` 이상이면 통과다.
 * rule이 없거나 attention 항목이 하나도 없으면 null(판정 불가)이다.
 */
export function judgeAttention(
  answers: AnswerItem[],
  rule: AttentionRule | null,
): AttentionResult | null {
  if (!rule) return null;
  const items = answers.filter((a) => isAttentionName(a.name, rule.namePrefix));
  if (items.length === 0) return null;
  const correct = items.filter((a) => a.value === rule.expectedValue).length;
  // 2/3 ≥ 0.667 같은 비교에서 부동소수 오차로 떨어지지 않게 한다
  const passed = correct / items.length >= rule.minCorrectRatio - 1e-9;
  return { total: items.length, correct, passed };
}
