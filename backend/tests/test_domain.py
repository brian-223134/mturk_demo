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


# ---- reference.test.ts -------------------------------------------------------------------------

from app.domain.reference import (agreement_with_reference, majority_reference, map_reference_to_answers, normalize_label,  # noqa: E402
                                  parse_reference_cell)

PREFIX = "attention_"


def test_normalize_label() -> None:
    assert normalize_label("  Not Covered ") == "not covered"
    assert normalize_label("Not covered") == normalize_label("Not Covered")


def test_parse_reference_cell_json_python_and_plain() -> None:
    assert parse_reference_cell('{"general_0_1": "Covered", "n": 2}') == {"general_0_1": "Covered", "n": 2}
    assert parse_reference_cell('["grounded", "not_grounded"]') == ["grounded", "not_grounded"]
    assert parse_reference_cell("3") == 3 and parse_reference_cell(" true ") is True
    # Python repr (fixture 의 LLM 라벨 형식)
    assert parse_reference_cell("{'general_0_1': 'Covered', 'general_1_1': 'Not covered'}") == {"general_0_1": "Covered", "general_1_1": "Not covered"}
    assert parse_reference_cell("[{'Core subquery1': 'Covered'}, {'Core subquery1': 'Not covered'}]") == [{"Core subquery1": "Covered"}, {"Core subquery1": "Not covered"}]
    assert parse_reference_cell("{'a': True, 'b': False, 'c': None, 'd': 'None'}") == {"a": True, "b": False, "c": None, "d": "None"}
    assert parse_reference_cell("{'a': 'it\\'s', 'b': 'line\\nbreak', 'c': '\\xe9'}") == {"a": "it's", "b": "line\nbreak", "c": "é"}
    # 값 안의 작은따옴표로 깨지거나 큰따옴표가 든 셀은 평문
    assert parse_reference_cell("{'a': 'don't'}") == "{'a': 'don't'}"
    assert parse_reference_cell("{'a': \"don't\"}") == "{'a': \"don't\"}"
    assert parse_reference_cell("{'a': 'unterminated}") == "{'a': 'unterminated}"
    # JSON 도 Python 리터럴도 아니면 셀 전체가 값 하나. 빈 셀은 None
    assert parse_reference_cell("") is None and parse_reference_cell("   ") is None
    assert parse_reference_cell("Covered") == "Covered" and parse_reference_cell(" not_grounded ") == "not_grounded"
    assert parse_reference_cell("Synthetic statement: Lorem ipsum.") == "Synthetic statement: Lorem ipsum."
    assert parse_reference_cell("NaN") == "NaN"     # JSON.parse 는 NaN 을 받지 않는다


def test_map_reference_to_answers() -> None:
    answers = [{"name": "general_0_1_coverage"}, {"name": "general_1_1_coverage"}, {"name": "attention_2_1_coverage"}]
    parsed = {"general_0_1": "Covered", "general_1_1": "Not covered", "general_1_1_coverage": "Exact", "general": "x"}
    assert map_reference_to_answers(parsed, answers, PREFIX) == {"general_0_1_coverage": "Covered", "general_1_1_coverage": "Exact"}
    assert map_reference_to_answers({"general_1": "short", "general_1_1": "long"}, [{"name": "general_1_1_x"}, {"name": "general_10_1"}], PREFIX) == {"general_1_1_x": "long"}
    assert map_reference_to_answers({"general_0_1": ["Covered"], "general_1_1": 1, "attention_2_1": True}, answers, PREFIX) == {
        "general_1_1_coverage": "1", "attention_2_1_coverage": "true"}
    assert map_reference_to_answers({"general_1_1": 2.0}, answers, PREFIX) == {"general_1_1_coverage": "2"}       # String(2) 는 "2"
    assert map_reference_to_answers(["a", "b", "c"], answers, PREFIX) == {"general_0_1_coverage": "a", "general_1_1_coverage": "b", "attention_2_1_coverage": "c"}
    assert map_reference_to_answers(["a", "b"], answers, PREFIX) == {"general_0_1_coverage": "a", "general_1_1_coverage": "b"}
    assert map_reference_to_answers(["a"], answers, PREFIX) == {}
    assert map_reference_to_answers(["a", {"nested": 1}], answers, PREFIX) == {"general_0_1_coverage": "a"}
    assert map_reference_to_answers("grounded", [{"name": "general_1"}, {"name": "attention_1"}], PREFIX) == {"general_1": "grounded"}
    assert map_reference_to_answers(1, [{"name": "general_1"}], PREFIX) == {"general_1": "1"}
    assert map_reference_to_answers("grounded", answers, PREFIX) == {}
    assert map_reference_to_answers(None, [{"name": "general_1"}], PREFIX) == {}


def test_majority_reference_and_agreement_with_reference() -> None:
    others = [
        [{"name": "q1", "value": "a"}, {"name": "q2", "value": "a"}, {"name": "q3", "value": "a"}],
        [{"name": "q1", "value": "a"}, {"name": "q2", "value": "b"}],
        [{"name": "q1", "value": "b"}, {"name": "q2", "value": "b"}],
    ]
    assert majority_reference(others) == {"q1": "a", "q2": "b", "q3": "a"}
    assert majority_reference([[{"name": "q1", "value": "a"}], [{"name": "q1", "value": "b"}]]) == {}
    assert majority_reference([]) == {}

    answers = [{"name": "general_0_1_coverage", "value": "Not Covered"}, {"name": "general_1_1_coverage", "value": "Covered"},
               {"name": "general_2_1_coverage", "value": "Covered"}, {"name": "attention_3_1_coverage", "value": "Covered"}]
    reference = {"general_0_1_coverage": "Not covered", "general_1_1_coverage": "Not covered", "attention_3_1_coverage": "Not Covered"}
    assert agreement_with_reference(answers, reference, PREFIX) == 0.5    # 0_1 일치, 1_1 불일치, 2_1 기준 없음, attention 제외
    assert agreement_with_reference([{"name": "general_1", "value": "a"}], {}, PREFIX) is None
    assert agreement_with_reference([{"name": "attention_1", "value": "a"}], {"attention_1": "a"}, PREFIX) is None
    assert agreement_with_reference([], {"general_1": "a"}, PREFIX) is None
    assert agreement_with_reference([{"name": "q", "value": "a"}], {"q": "A "}, PREFIX) == 1 and isinstance(agreement_with_reference([{"name": "q", "value": "a"}], {"q": "a"}, PREFIX), int)


# ---- workerStats.test.ts -----------------------------------------------------------------------

from app.domain.worker_stats import WorkerStatsRecord, compute_worker_stats, median  # noqa: E402

_seq = 0


def record(worker_id: str, answers: dict, status: str = "Approved", row_index: int = 0, batch_id: str = "b1", work_time: int = 300,
           attention_passed: bool | None = None, submit_time: str = "2025-10-09T11:05:00Z") -> WorkerStatsRecord:
    global _seq
    _seq += 1
    assignment = {
        "AssignmentId": f"A{_seq}", "HITId": f"H{row_index}", "WorkerId": worker_id, "AssignmentStatus": status,
        "AcceptTime": "2025-10-09T11:00:00Z", "SubmitTime": submit_time, "AutoApprovalTime": "2025-11-08T11:05:00Z",
        "answers": [{"name": name, "value": value} for name, value in answers.items()], "workTimeInSeconds": work_time,
        "attention": None if attention_passed is None else {"total": 1, "correct": int(attention_passed), "passed": attention_passed},
    }
    return WorkerStatsRecord(assignment, batch_id, row_index, "attention_")


def test_median() -> None:
    assert median([5, 1, 3]) == 3 and median([4, 1, 3, 2]) == 2.5 and median([]) is None
    assert median([2, 4]) == 3 and isinstance(median([2, 4]), int)


def test_worker_stats_counts_and_rates() -> None:
    stats = compute_worker_stats([
        record("W1", {"q": "a"}, "Approved", 0), record("W1", {"q": "a"}, "Approved", 1),
        record("W1", {"q": "a"}, "Rejected", 2), record("W1", {"q": "a"}, "Submitted", 3),
    ])["W1"]
    assert {k: stats[k] for k in ("total", "approved", "rejected", "pending")} == {"total": 4, "approved": 2, "rejected": 1, "pending": 1}
    assert stats["rejectRate"] == pytest.approx(1 / 3)
    assert compute_worker_stats([record("W1", {"q": "a"}, "Submitted")])["W1"]["rejectRate"] is None
    stats = compute_worker_stats([record("W1", {"q": "a"}, row_index=0, attention_passed=True),
                                  record("W1", {"q": "a"}, row_index=1, attention_passed=False),
                                  record("W1", {"q": "a"}, row_index=2)])["W1"]
    assert stats["attentionFailRate"] == 0.5
    stats = compute_worker_stats([
        record("W1", {"q": "a"}, row_index=0, work_time=60, submit_time="2025-10-09T11:05:00Z"),
        record("W1", {"q": "a"}, row_index=1, work_time=400, batch_id="b2", submit_time="2025-11-19T12:00:00Z"),
        record("W1", {"q": "a"}, row_index=2, work_time=100, submit_time="2025-10-10T00:00:00Z"),
    ])["W1"]
    assert stats["medianWorkTimeInSeconds"] == 100 and stats["batchCount"] == 2 and stats["lastActiveAt"] == "2025-11-19T12:00:00Z"


def test_worker_stats_majority_agreement() -> None:
    """자기 표를 빼고 다른 worker 들의 majority 와 비교한다. 동률이거나 표가 없으면 제외. attention 제외. 반려된 응답은 기준에 안 들어간다."""
    stats = compute_worker_stats([record("W1", {"q1": "a"}), record("W2", {"q1": "a"}), record("W3", {"q1": "b"})])
    assert stats["W3"]["majorityAgreement"] == 0 and stats["W1"]["majorityAgreement"] is None
    stats = compute_worker_stats([record("W1", {"q1": "a"}), record("W2", {"q1": "b"})])
    assert stats["W1"]["majorityAgreement"] == 0 and stats["W2"]["majorityAgreement"] == 0
    stats = compute_worker_stats([
        record("W1", {"q1": "a", "q2": "a", "q3": "b", "q4": "a"}),
        record("W2", {"q1": "a", "q2": "a", "q3": "a", "q4": "b"}),
        record("W3", {"q1": "a", "q2": "a", "q3": "a", "q4": "b"}),
    ])
    assert stats["W1"]["majorityAgreement"] == 0.5 and stats["W2"]["majorityAgreement"] == 1
    stats = compute_worker_stats([record("W1", {"q1": "a", "attention_1": "x"}), record("W2", {"q1": "a", "attention_1": "y"}),
                                  record("W3", {"q1": "a", "attention_1": "y"})])
    assert stats["W1"]["majorityAgreement"] == 1
    stats = compute_worker_stats([record("W1", {"q1": "a"}), record("W2", {"q1": "a"}), record("W4", {"q1": "b"}, "Rejected")])
    assert stats["W4"]["majorityAgreement"] == 0 and stats["W1"]["majorityAgreement"] == 1
    stats = compute_worker_stats([record("W1", {"q1": "a"}, batch_id="b1"), record("W2", {"q1": "b"}, batch_id="b2")])
    assert stats["W1"]["majorityAgreement"] is None
    assert list(compute_worker_stats([record("W9", {}), record("W8", {}), record("W9", {})])) == ["W9", "W8"]   # 처음 나온 순서


# ---- exportFormats (domain2.test.ts) ---------------------------------------------------------------

from app.domain.export_formats import build_mturk_csv, to_csv, to_mturk_time  # noqa: E402


def test_to_csv_and_mturk_time() -> None:
    assert to_csv(["a", "b"], [["1", "x,y"], ['say "hi"', "line\nbreak"]]) == 'a,b\r\n1,"x,y"\r\n"say ""hi""","line\nbreak"\r\n'
    assert to_mturk_time("2025-10-09T07:30:20Z") == "Thu Oct 09 07:30:20 UTC 2025"
    assert to_mturk_time("2026-09-25T00:00:00.123Z") == "Fri Sep 25 00:00:00 UTC 2026"
    assert to_mturk_time(None) == "" and to_mturk_time("") == ""


def test_build_mturk_csv_columns_and_answers() -> None:
    batch = {"id": "batch-1", "inputColumns": ["idx", "text"], "settings": {"Title": "T", "Description": "D", "Keywords": "k", "Reward": "0.05",
             "AssignmentDurationInSeconds": 1800, "AutoApprovalDelayInSeconds": 86400, "LifetimeInSeconds": 86400}}
    hits = [{"HITId": "H1", "MaxAssignments": 3, "CreationTime": "2025-10-09T07:30:20Z", "Expiration": "2025-10-10T07:30:20Z",
             "input": {"idx": "1", "text": 'a "quoted", cell'}}]
    assignments = [{"AssignmentId": "A1", "HITId": "H1", "WorkerId": "W1", "AssignmentStatus": "Approved", "AcceptTime": "2025-10-09T08:00:00Z",
                    "SubmitTime": "2025-10-09T08:05:00Z", "AutoApprovalTime": "2025-10-10T08:05:00Z", "ApprovalTime": "2025-10-09T09:00:00Z",
                    "workTimeInSeconds": 300, "answers": [{"name": "q", "value": "yes"}]},
                   {"AssignmentId": "A2", "HITId": "H-unknown", "WorkerId": "W2", "AssignmentStatus": "Submitted", "answers": []}]
    text = build_mturk_csv(batch, hits, assignments)
    lines = text.split("\r\n")
    header = lines[0].split(",")
    assert header[:3] == ["HITId", "HITTypeId", "Title"] and header[-5:] == ["Input.idx", "Input.text", "Answer.taskAnswers", "Approve", "Reject"]
    assert len(lines) == 3 and lines[2] == ""                                     # 모르는 HIT 의 응답은 빠지고, 끝은 CRLF
    row = lines[1]
    assert row.startswith("H1,,T,D,k,$0.05,Thu Oct 09 07:30:20 UTC 2025,3,BatchId:batch-1;,1800,86400,Fri Oct 10 07:30:20 UTC 2025,,86400,A1,W1,Approved,")
    assert ',Thu Oct 09 09:00:00 UTC 2025,,,300,,,,1,"a ""quoted"", cell","[{""input_answers"":""[{\\""name\\"":\\""q\\"",\\""value\\"":\\""yes\\""}]""}]",,' in row


# ---- app/domain/js.py (JS 와 같은 값 동작) -------------------------------------------------------------

from app.domain.js import (is_js_integer, js_equal, js_len, js_number_of, js_slice, js_string, js_truthy, locale_key, natural_key,  # noqa: E402
                           normalize_numbers, slug, to_fixed)


def test_js_compat_helpers() -> None:
    assert is_js_integer(3) and is_js_integer(3.0) and not is_js_integer(2.5) and not is_js_integer(True) and not is_js_integer("3")
    assert js_number_of("120") == 120 and js_number_of(" 1e3 ") == 1000 and js_number_of("") == 0 and js_number_of(None) == 0
    assert js_number_of("abc") != js_number_of("abc") and js_number_of(True) == 1 and js_number_of([5]) == 5     # NaN 은 자기와 다르다
    assert js_string(2.0) == "2" and js_string(1.5) == "1.5" and js_string(True) == "true" and js_string(None) == "null" and js_string(1e21) == "1e+21"
    assert js_equal(1, 1.0) and not js_equal(1, True) and not js_equal("1", 1) and js_equal(None, None) and not js_equal([], [])
    assert js_truthy({}) and js_truthy([]) and not js_truthy(0) and not js_truthy("") and not js_truthy(None) and js_truthy("0")
    assert js_len("a😀") == 3 and js_slice("a😀b", 1) == "a" and js_slice("héllo", 2) == "hé"
    assert to_fixed(500.125, 2) == "500.13" and to_fixed(0.1, 2) == "0.10" and to_fixed(2.4 / 100 + 500, 2) == "500.02"
    assert locale_key("a") < locale_key("B") < locale_key("c") and locale_key("alpha") < locale_key("Alpha")
    assert natural_key("general_2_1") < natural_key("general_10_1") < natural_key("general_10_2")
    assert normalize_numbers({"a": 1.0, "b": [2.5, 3.0], "c": {"d": 1.0}}) == {"a": 1, "b": [2.5, 3], "c": {"d": 1}}
    assert isinstance(normalize_numbers({"a": 1.0})["a"], int)
    assert slug("Pilot regulars!") == "pilot-regulars" and slug("  ") == "" and slug("Sentence-passage relevance (sample)") == "sentence-passage-relevance-sample"


# ---- progress.ts planTopUp (domain2.test.ts) -----------------------------------------------------------

from app.domain.progress import TopUpPlan, plan_top_up  # noqa: E402


def test_plan_top_up() -> None:
    assert plan_top_up(3, 3, 2, "fill-to-target") == TopUpPlan(2)
    assert plan_top_up(3, 3, 0, 2) == TopUpPlan(2)
    assert plan_top_up(3, 3, 0, "fill-to-target").add == 0
    assert plan_top_up(6, 3, 3, "fill-to-target") == TopUpPlan(3)
    over = plan_top_up(8, 3, 2, "fill-to-target")
    assert over.add == 0 and "cannot exceed 9" in over.reason
    assert plan_top_up(12, 12, 0, 5) == TopUpPlan(5)      # 처음부터 10 이상이면 상한이 없다
    with pytest.raises(ValueError):
        plan_top_up(3, 3, 0, -1)
    with pytest.raises(ValueError):
        plan_top_up(3, 3, 0, 1.5)


# ---- cost.ts unitCostCents (handlers.ts) -------------------------------------------------------------

from app.domain.cost import unit_cost_cents  # noqa: E402


def test_unit_cost_cents() -> None:
    assert unit_cost_cents("0.05", 3, False) == 6 and unit_cost_cents("0.10", 3, False) == 12
    assert unit_cost_cents("0.05", 10, False) == 7                   # 10개 이상은 40%
    assert unit_cost_cents("0.07", 3, False) == 8.4 and unit_cost_cents("0.02", 3, False) == 3     # 최소 수수료 1센트
