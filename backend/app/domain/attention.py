"""Attention 판정. prototype/src/domain/attention.ts 를 그대로 옮겼다.

attention.test.ts 의 요지: rule 이 없거나 attention 항목이 없으면 None, 정답 비율이 minCorrectRatio 이상이면 passed.
2/3 ≥ 0.667 같은 비교에서 부동소수 오차로 떨어지지 않게 1e-9 를 뺀다.
"""

from __future__ import annotations

DEFAULT_ATTENTION_PREFIX = "attention_"


def is_attention_name(name: str, prefix: str = DEFAULT_ATTENTION_PREFIX) -> bool:
    return name.startswith(prefix)


def judge_attention(answers: list[dict], rule: dict | None) -> dict | None:
    """name 이 namePrefix 로 시작하는 답 중 값이 expectedValue 와 같은 비율이 minCorrectRatio 이상이면 통과.

    rule 이 없거나 attention 항목이 하나도 없으면 None (판정 불가). 결과는 {total, correct, passed} (AttentionResult).
    """
    if not rule:
        return None
    prefix = rule.get("namePrefix", DEFAULT_ATTENTION_PREFIX)
    items = [a for a in answers if is_attention_name(str(a.get("name", "")), prefix)]
    if not items:
        return None
    correct = sum(1 for a in items if a.get("value") == rule.get("expectedValue"))
    passed = correct / len(items) >= float(rule.get("minCorrectRatio", 1.0)) - 1e-9
    return {"total": len(items), "correct": correct, "passed": passed}
