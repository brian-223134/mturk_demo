"""비용 계산. prototype/src/domain/cost.ts 를 그대로 옮겼다. 금액은 센트 단위 숫자이고 수수료율은 정수 % 다.

JS 의 number 연산을 그대로 따라간다: (rewardCents * percent) / 100 은 정수 곱 뒤 실수 나눗셈, Math.round 는
0.5 를 올린다 (Python 의 round 는 짝수로 가므로 쓰지 않는다). JSON 으로 내보낼 때 정수 값의 실수(60.0)는 JS 처럼
정수(60)로 적기 위해 js_number 를 거친다.

cost.test.ts 의 기대값:
    reward_to_cents("0.10") == 10, ("0.05") == 5, ("1.15") == 115   (1.15 * 100 = 114.99999999999999 를 반올림)
    reward_to_cents("") 와 ("-0.10") 은 ValueError
    fee_percent(3, False) == 20, (9, False) == 20, (10, False) == 40, (3, True) == 25, (10, True) == 45
    fee_cents_per_assignment(10, 20) == 2, (5, 20) == 1, (2, 20) == 1   (0.4 센트 → 최소 1 센트)
    estimate_cost(160 HIT × 3 × "0.10") == {rewardCents 4800, feeCents 960, totalCents 5760, feePercent 20}
    estimate_cost(10 × 10 × "0.10") → rewardCents 1000, feeCents 400, totalCents 1400   (10 개 이상은 40%)
    estimate_cost(100 × 3 × "0.02") → rewardCents 600, feeCents 300, totalCents 900     (최소 수수료)
    uses_masters([]) is False, 일반 Qualification 은 False, MASTERS_QUALIFICATION_TYPE_IDS[0] 이 있으면 True
    batch_cost([{3, approved 3, rejected 0}, {4, approved 2, rejected 1}], "0.10", False)
        → spentCents 5 * 12, estimatedCents (3 + 3) * 12
    format_cents(5760) == "$57.60", (0) == "$0.00", (2.4) == "$0.02"
"""

from __future__ import annotations

import math
import re

# 연동 전에 MTurk 공식 요금표로 다시 확인한다.
FEE_PERCENT = 20
FEE_PERCENT_10_OR_MORE = 40  # MaxAssignments ≥ 10
MASTERS_EXTRA_PERCENT = 5
MIN_FEE_CENTS = 1  # assignment 당 최소 수수료 $0.01
HIGH_FEE_MIN_ASSIGNMENTS = 10

# Masters Qualification ID. 1 단계에서는 쓰이지 않는다.
MASTERS_QUALIFICATION_TYPE_IDS = (
    "2F1QJWKUDD8XADTFD2Q0G6UTO95ALH",  # production
    "2ARFPLSP75KLA8M8DH1HTEQVJT3SY6",  # sandbox
)

# JS Number.parseFloat 가 읽는 앞부분: 부호, 숫자, 소수점, 지수
_PARSE_FLOAT_RE = re.compile(r"^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)")


def parse_float(text: object) -> float:
    """JS 의 Number.parseFloat(String(text)). 숫자로 시작하지 않으면 NaN."""
    match = _PARSE_FLOAT_RE.match(str(text))
    return float(match.group(1)) if match else math.nan


def js_round(value: float) -> int:
    """JS 의 Math.round: 0.5 는 +∞ 쪽으로."""
    return int(math.floor(value + 0.5))


def js_number(value: float | int) -> int | float:
    """JSON.stringify 처럼 정수 값의 실수는 정수로 (60.0 → 60)."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def reward_to_cents(reward: str) -> int:
    """MTurk 의 문자열 Reward("0.10") → 센트. 숫자가 아니거나 음수면 ValueError (TS 의 RangeError)."""
    dollars = parse_float(reward)
    if not math.isfinite(dollars) or dollars < 0:
        raise ValueError(f"Invalid Reward: {reward!r}")
    return js_round(dollars * 100)


def uses_masters(requirements: list) -> bool:
    """Masters Qualification 조건이 있는지 본다."""
    return any(isinstance(r, dict) and r.get("QualificationTypeId") in MASTERS_QUALIFICATION_TYPE_IDS
               for r in requirements or [])


def fee_percent(max_assignments: int, masters: bool) -> int:
    base = FEE_PERCENT_10_OR_MORE if max_assignments >= HIGH_FEE_MIN_ASSIGNMENTS else FEE_PERCENT
    return base + (MASTERS_EXTRA_PERCENT if masters else 0)


def fee_cents_per_assignment(reward_cents: int, percent: int) -> float:
    return max((reward_cents * percent) / 100, MIN_FEE_CENTS)


def estimate_cost(hit_count: int, max_assignments: int, reward: str, masters: bool) -> dict:
    """게시 전 견적. 반려 후 재모집분은 포함되지 않는다."""
    assignments = hit_count * max_assignments
    percent = fee_percent(max_assignments, masters)
    reward_cents = assignments * reward_to_cents(reward)
    fee_cents = assignments * fee_cents_per_assignment(reward_to_cents(reward), percent)
    return {
        "rewardCents": js_number(reward_cents),
        "feeCents": js_number(fee_cents),
        "totalCents": js_number(reward_cents + fee_cents),
        "feePercent": percent,
    }


def batch_cost(hits: list[dict], reward: str, masters: bool) -> dict:
    """게시된 batch 의 지출과 예상 총액 (BatchCost). hits 의 원소는 {MaxAssignments, approved, rejected}.

    지출은 Approved 만 센다 (반려분은 과금되지 않는다). 예상은 반려를 뺀 모든 자리가 승인된다고 볼 때의 총액이다.
    """
    reward_cents = reward_to_cents(reward)
    spent = 0.0
    estimated = 0.0
    for hit in hits:
        unit = reward_cents + fee_cents_per_assignment(reward_cents, fee_percent(hit["MaxAssignments"], masters))
        spent += hit["approved"] * unit
        estimated += max(0, hit["MaxAssignments"] - hit["rejected"]) * unit
    return {"spentCents": js_number(spent), "estimatedCents": js_number(estimated)}


def format_cents(cents: float) -> str:
    """달러 표시. JS 의 toFixed(2) 처럼 센트 단위에서 0.5 를 올려 반올림한다 (2.4 센트 → $0.02, 12.5 센트 → $0.13)."""
    return f"${math.floor(cents + 0.5) / 100:.2f}"


def unit_cost_cents(reward: str, hit_max_assignments: int, masters: bool) -> float | int:
    """assignment 1건의 값 (reward + 수수료). HIT 의 MaxAssignments 에 따라 수수료율이 달라진다 (handlers.ts 의 unitCostCents).

        unit_cost_cents("0.05", 3, False) == 6,  unit_cost_cents("0.10", 3, False) == 12,  unit_cost_cents("0.05", 10, False) == 7
    """
    reward_cents = reward_to_cents(reward)
    return js_number(reward_cents + fee_cents_per_assignment(reward_cents, fee_percent(hit_max_assignments, masters)))
