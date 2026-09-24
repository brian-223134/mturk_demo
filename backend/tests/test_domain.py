"""app/domain/ 의 계산 규칙이 프로토타입 테스트의 기대값과 같은지 확인한다.

기대값은 prototype/src/domain/{progress,cost,attention}.test.ts 에서 그대로 옮긴 것이다 (각 테스트의 주석에 출처를 적었다).
TS 의 number 연산과 같은 결과여야 하므로 정수/실수 구분(60 이지 60.0 이 아님)과 반올림 방향까지 본다.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.domain.attention import is_attention_name, judge_attention
from app.domain.cost import (MASTERS_QUALIFICATION_TYPE_IDS, batch_cost, estimate_cost, fee_cents_per_assignment, fee_percent,
                             format_cents, js_number, js_round, reward_to_cents, uses_masters)
from app.domain.progress import (AssignmentCounts, batch_status, count_by_status, hit_progress, is_expired, reject_rate,
                                 summarize_progress)
from app.domain.template import extract_placeholders

# ---- progress.test.ts -------------------------------------------------------------------------


def test_count_by_status() -> None:
    """progress.test.ts 'countByStatus': Approved, Approved, Rejected, Submitted → (submitted 1, approved 2, rejected 1)."""
    assert count_by_status(["Approved", "Approved", "Rejected", "Submitted"]) == AssignmentCounts(1, 2, 1)
    # Submitted, Approved 가 아닌 상태는 모두 rejected 로 센다 (TS 와 같다)
    assert count_by_status(["Whatever"]) == AssignmentCounts(0, 0, 1)


@pytest.mark.parametrize(
    "max_assignments, counts, expected",
    [
        # progress.test.ts 'hitProgress' (target 3)
        (3, (0, 3, 0), {"open": 0, "completed": True, "shortfall": 0}),    # 승인이 target 만큼 차면 완료
        (3, (0, 2, 1), {"open": 0, "completed": False, "shortfall": 1}),   # 반려는 자리를 다시 열어 주지 않는다
        (3, (1, 1, 0), {"open": 1, "completed": False, "shortfall": 0}),   # 검수 대기와 열린 자리는 부족분이 아니다
        (5, (1, 1, 2), {"open": 1, "completed": False, "shortfall": 0}),   # 재모집으로 MaxAssignments 가 늘어난 HIT
        (3, (0, 4, 0), {"open": 0, "completed": True, "shortfall": 0}),    # open 은 음수가 되지 않는다
    ],
)
def test_hit_progress(max_assignments: int, counts: tuple[int, int, int], expected: dict) -> None:
    progress = hit_progress(max_assignments, AssignmentCounts(*counts), target=3)
    assert {key: getattr(progress, key) for key in expected} == expected
    assert (progress.submitted, progress.approved, progress.rejected) == counts


def test_is_expired() -> None:
    """progress.test.ts 'isExpired': 2025-11-08T07:30:20Z 는 07:30:19Z 에는 살아 있고 같은 시각이면 만료다."""
    expiration = "2025-11-08T07:30:20Z"
    assert is_expired(expiration, datetime(2025, 11, 8, 7, 30, 19, tzinfo=timezone.utc)) is False
    assert is_expired(expiration, datetime(2025, 11, 8, 7, 30, 20, tzinfo=timezone.utc)) is True
    # 읽을 수 없는 시각은 JS 의 NaN 비교처럼 False
    assert is_expired("not a date", datetime.now(timezone.utc)) is False


def test_batch_status() -> None:
    """progress.test.ts 'batchStatus'."""
    assert batch_status([(True, True)]) == "completed"                    # 모든 HIT 가 완료되면 completed (만료 여부와 무관)
    assert batch_status([(True, True), (False, True)]) == "expired"       # 미완료 HIT 가 전부 만료됐으면 expired
    assert batch_status([(False, True), (False, False)]) == "in_progress"  # 살아 있는 미완료 HIT 가 하나라도 있으면


def test_reject_rate() -> None:
    """progress.test.ts 'rejectRate': 반려 / (승인 + 반려). 검수한 건이 없으면 null."""
    assert reject_rate(108, 18) == pytest.approx(18 / 126)
    assert reject_rate(0, 0) is None
    # 0 과 1 은 JS 의 JSON 처럼 정수로
    assert reject_rate(48, 0) == 0 and isinstance(reject_rate(48, 0), int)
    assert reject_rate(0, 3) == 1 and isinstance(reject_rate(0, 3), int)


def test_summarize_progress() -> None:
    """progress.test.ts 'summarizeProgress': HIT 별 진행률을 batch 단위로 합친다."""
    summary = summarize_progress([
        hit_progress(3, AssignmentCounts(0, 3, 0), 3),
        hit_progress(4, AssignmentCounts(1, 1, 1), 3),
    ])
    assert summary == {
        "hitsTotal": 2, "hitsCompleted": 1, "submitted": 1, "approved": 4, "rejected": 1, "open": 1, "rejectRate": 1 / 5,
    }
    assert summarize_progress([]) == {
        "hitsTotal": 0, "hitsCompleted": 0, "submitted": 0, "approved": 0, "rejected": 0, "open": 0, "rejectRate": None,
    }


# ---- cost.test.ts -----------------------------------------------------------------------------


def test_reward_to_cents() -> None:
    """cost.test.ts 'rewardToCents': "0.10" → 10, "0.05" → 5, "1.15" → 115 (1.15 * 100 = 114.99999999999999)."""
    assert reward_to_cents("0.10") == 10
    assert reward_to_cents("0.05") == 5
    assert reward_to_cents("1.15") == 115
    for bad in ("", "-0.10", "abc"):  # 숫자가 아니거나 음수면 오류 (TS 의 RangeError)
        with pytest.raises(ValueError):
            reward_to_cents(bad)


def test_js_round_and_number() -> None:
    assert js_round(2.5) == 3 and js_round(114.99999999999999) == 115 and js_round(0.4) == 0
    assert js_number(60.0) == 60 and isinstance(js_number(60.0), int)
    assert js_number(2.4) == 2.4


def test_fee_percent() -> None:
    """cost.test.ts 'feePercent': 기본 20%, MaxAssignments ≥ 10 이면 40%, Masters 면 +5%p."""
    assert fee_percent(3, False) == 20
    assert fee_percent(9, False) == 20
    assert fee_percent(10, False) == 40
    assert fee_percent(3, True) == 25
    assert fee_percent(10, True) == 45


def test_fee_cents_per_assignment() -> None:
    """cost.test.ts 'feeCentsPerAssignment': assignment 당 최소 수수료는 $0.01."""
    assert fee_cents_per_assignment(10, 20) == 2
    assert fee_cents_per_assignment(5, 20) == 1
    assert fee_cents_per_assignment(2, 20) == 1  # 0.4 센트 → 1 센트


def test_estimate_cost() -> None:
    """cost.test.ts 'estimateCost'."""
    # 160 HIT × 3명 × $0.10 = $48.00 + 수수료 $9.60 = $57.60
    assert estimate_cost(160, 3, "0.10", False) == {"rewardCents": 4800, "feeCents": 960, "totalCents": 5760, "feePercent": 20}
    # MaxAssignments 가 10 이상이면 수수료 40%
    assert estimate_cost(10, 10, "0.10", False) == {"rewardCents": 1000, "feeCents": 400, "totalCents": 1400, "feePercent": 40}
    # reward 가 작으면 최소 수수료가 적용된다
    assert estimate_cost(100, 3, "0.02", False) == {"rewardCents": 600, "feeCents": 300, "totalCents": 900, "feePercent": 20}
    # Masters 는 +5%p
    assert estimate_cost(160, 3, "0.10", True)["feePercent"] == 25
    # JSON 으로 나가는 값은 JS 처럼 정수다
    for value in estimate_cost(160, 3, "0.10", False).values():
        assert isinstance(value, int)


def test_uses_masters() -> None:
    """cost.test.ts 'usesMasters': Masters Qualification 조건이 있는지 본다."""
    assert uses_masters([]) is False
    assert uses_masters([{"QualificationTypeId": "000000000000000000L0", "Comparator": "GreaterThanOrEqualTo"}]) is False
    assert uses_masters([{"QualificationTypeId": MASTERS_QUALIFICATION_TYPE_IDS[0], "Comparator": "Exists"}]) is True


def test_batch_cost() -> None:
    """cost.test.ts 'batchCost': 지출은 Approved 만, 예상은 반려를 뺀 모든 자리."""
    cost = batch_cost(
        [
            {"MaxAssignments": 3, "approved": 3, "rejected": 0},
            {"MaxAssignments": 4, "approved": 2, "rejected": 1},  # 1건 반려 후 1건 재모집, 1자리 남음
        ],
        "0.10",
        False,
    )
    assert cost == {"spentCents": 5 * 12, "estimatedCents": (3 + 3) * 12}
    assert isinstance(cost["spentCents"], int) and isinstance(cost["estimatedCents"], int)
    # MaxAssignments ≥ 10 인 HIT 는 40% 수수료로, Masters 는 +5%p 로 계산한다
    assert batch_cost([{"MaxAssignments": 10, "approved": 10, "rejected": 0}], "0.10", False) == {"spentCents": 140, "estimatedCents": 140}
    assert batch_cost([{"MaxAssignments": 3, "approved": 3, "rejected": 0}], "1.00", True) == {"spentCents": 375, "estimatedCents": 375}


def test_format_cents() -> None:
    """cost.test.ts 'formatCents': 달러로 표시한다."""
    assert format_cents(5760) == "$57.60"
    assert format_cents(0) == "$0.00"
    assert format_cents(2.4) == "$0.02"


# ---- attention.test.ts ------------------------------------------------------------------------

RULE = {"namePrefix": "attention_", "expectedValue": "not_grounded", "minCorrectRatio": 1.0}


def test_is_attention_name() -> None:
    """attention.test.ts 'isAttentionName': prefix 로 시작하는 name 만 attention 문항이다."""
    assert is_attention_name("attention_10_1") is True
    assert is_attention_name("general_0_1") is False
    assert is_attention_name("general_attention_1") is False
    assert is_attention_name("check_1", "check_") is True


def test_judge_attention() -> None:
    """attention.test.ts 'judgeAttention'."""
    # attention 문항이 전부 정답이면 통과
    assert judge_attention(
        [{"name": "general_0_1", "value": "grounded"},
         {"name": "attention_10_1", "value": "not_grounded"},
         {"name": "attention_10_2", "value": "not_grounded"}],
        RULE,
    ) == {"total": 2, "correct": 2, "passed": True}
    # 기준이 1.0 이면 하나만 틀려도 미통과
    assert judge_attention(
        [{"name": "attention_10_1", "value": "grounded"}, {"name": "attention_10_2", "value": "not_grounded"}], RULE,
    ) == {"total": 2, "correct": 1, "passed": False}
    # minCorrectRatio 를 낮추면 일부 오답도 통과
    answers = [{"name": "attention_1", "value": "not_grounded"},
               {"name": "attention_2", "value": "not_grounded"},
               {"name": "attention_3", "value": "grounded"}]
    assert judge_attention(answers, {**RULE, "minCorrectRatio": 2 / 3})["passed"] is True
    assert judge_attention(answers, {**RULE, "minCorrectRatio": 0.7})["passed"] is False
    # 실제 문항의 값은 판정에 영향을 주지 않는다
    assert judge_attention(
        [{"name": "general_0_1", "value": "not_grounded"}, {"name": "attention_10_1", "value": "grounded"}], RULE,
    ) == {"total": 1, "correct": 0, "passed": False}
    # 정답 값은 표기까지 같아야 한다 (템플릿마다 표기가 다르다)
    coverage = [{"name": "attention_4_1_coverage", "value": "Not Covered"}]
    assert judge_attention(coverage, {**RULE, "expectedValue": "Not Covered"})["passed"] is True
    assert judge_attention(coverage, {**RULE, "expectedValue": "not_covered"})["passed"] is False
    # attention 문항이 없거나 rule 이 없으면 null (판정 불가)
    assert judge_attention([{"name": "general_0_coverage", "value": "Yes"}], RULE) is None
    assert judge_attention([], RULE) is None
    assert judge_attention([{"name": "attention_1", "value": "not_grounded"}], None) is None


# ---- template.ts -------------------------------------------------------------------------------


def test_extract_placeholders() -> None:
    """`${컬럼명}` 을 처음 나온 순서대로, 중복 없이 뽑는다 (prototype/src/domain/template.ts 와 같은 정규식)."""
    assert extract_placeholders("<p>${idx} ${qid} ${idx} ${_x1}</p> ${1bad} ${a-b}") == ["idx", "qid", "_x1"]
    assert extract_placeholders("") == []
