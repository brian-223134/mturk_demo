"""Attention 판정. prototype/src/domain/attention.ts 를 옮기고, 기대 답 컬럼 방식을 더했다.

batch.attentionRule 의 두 모양:
    {"namePrefix": "attention_", "expectedValue": "x", "minCorrectRatio": 1}   이름이 접두어로 시작하는 답이 attention 이고
                                                                            기대 값은 모두 expectedValue (프로토타입과 같다)
    {"column": "attention_expected", "minCorrectRatio": 1}                  HIT 입력의 그 컬럼 셀이 {답 이름: 기대 값} 이다.
                                                                            그 키인 답이 attention 이다 (이름으로는 가릴 수 없다)

attention.test.ts 의 요지: rule 이 없거나 attention 항목이 없으면 None, 정답 비율이 minCorrectRatio 이상이면 passed.
2/3 ≥ 0.667 같은 비교에서 부동소수 오차로 떨어지지 않게 1e-9 를 뺀다.
컬럼 방식은 기대 답의 키 수가 total, 답 값이 기대 값과 정확히 같은 키 수가 correct 다 (답이 없으면 틀림). 키가 없으면 None.
"""

from __future__ import annotations

from app.domain.js import js_string
from app.domain.reference import as_label, parse_reference_cell

DEFAULT_ATTENTION_PREFIX = "attention_"


def is_attention_name(name: str, prefix: str = DEFAULT_ATTENTION_PREFIX) -> bool:
    return name.startswith(prefix)


def attention_column_of(rule: object) -> str | None:
    """컬럼 방식 rule 이면 그 컬럼 이름, 아니면 None."""
    column = rule.get("column") if isinstance(rule, dict) else None
    return column if isinstance(column, str) and column else None


def expected_attention_answers(rule: object, hit_input: dict | None) -> dict[str, str | None] | None:
    """컬럼 방식 rule 이면 그 HIT 의 {attention 답 이름: 기대 값}, 아니면 None.

    셀은 대조 기준 컬럼과 같은 규칙(parse_reference_cell: JSON, Python 리터럴)으로 읽는다. 비었거나 객체가 아니면 빈 dict 다.
    기대 값은 문자열로 바꾼다 (숫자, 참거짓은 String() 처럼). 목록이나 객체는 None 이라 어떤 답과도 같지 않다.
    """
    column = attention_column_of(rule)
    if column is None:
        return None
    cell = (hit_input or {}).get(column)
    parsed = parse_reference_cell("" if cell is None else js_string(cell))
    if not isinstance(parsed, dict):
        return {}
    return {str(name): as_label(value) for name, value in parsed.items()}


def judge_attention(answers: list[dict], rule: dict | None, hit_input: dict | None = None) -> dict | None:
    """attention 답 중 기대 값과 같은 비율이 minCorrectRatio 이상이면 통과. hit_input 은 그 HIT 의 입력(컬럼 방식에서 읽는다).

    접두어 방식은 name 이 namePrefix 로 시작하는 답의 값이 expectedValue 와 같은지 본다.
    rule 이 없거나 attention 항목이 하나도 없으면 None (판정 불가). 결과는 {total, correct, passed} (AttentionResult).
    """
    if not rule:
        return None
    expected = expected_attention_answers(rule, hit_input)
    if expected is not None:
        if not expected:
            return None
        given = {str(a.get("name", "")): a.get("value") for a in answers}
        correct = sum(1 for name, value in expected.items() if value is not None and name in given and given[name] == value)
        total = len(expected)
    else:
        prefix = rule.get("namePrefix", DEFAULT_ATTENTION_PREFIX)
        items = [a for a in answers if is_attention_name(str(a.get("name", "")), prefix)]
        if not items:
            return None
        correct = sum(1 for a in items if a.get("value") == rule.get("expectedValue"))
        total = len(items)
    passed = correct / total >= float(rule.get("minCorrectRatio", 1.0)) - 1e-9
    return {"total": total, "correct": correct, "passed": passed}
