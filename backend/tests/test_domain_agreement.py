"""app/domain/agreement.py (majority, Fleiss' κ, 문항 묶기) 가 프로토타입 테스트의 기대값과 같은지 확인한다.

기대값은 prototype/src/domain/agreement.test.ts, domain2.test.ts ('fleissKappa', 'collectItems, summarizeResults',
'agreementWithOthers') 와 handlers.test.ts 의 κ 기준값(statsmodels 0.14 로 계산)에서 온 것이다.
"""

from __future__ import annotations

import json

import pytest

from app.domain.agreement import (Vote, agreement_with_others, collect_items, fleiss_kappa, item_key, majority, majority_of_tally,
                                  summarize_results, tally)
from app.domain.attention import is_attention_name
from app.domain.export_formats import build_labels_json
from helpers import DATA_DIR

# ---- majority ---------------------------------------------------------------------------------


def test_item_key() -> None:
    assert item_key(12, "general_0_1") == "12:general_0_1"


def test_majority() -> None:
    assert majority(["grounded", "grounded", "not_grounded"]) == "grounded"
    assert majority(["Yes"]) == "Yes"
    assert majority(["grounded", "not_grounded"]) is None                 # 동률
    assert majority(["a", "a", "b", "b", "c"]) is None
    assert majority(["a", "b", "a", "b", "c", "c", "c"]) == "c"           # 뒤에 나온 값이 동률을 깨면 그 값
    assert majority([]) is None


def test_majority_of_tally_ignores_non_positive_counts() -> None:
    """0 이하인 득표는 없는 것으로 본다 (자기 표를 뺀 집계에서 생긴다)."""
    assert majority_of_tally({"a": 0, "b": 1}) == "b"
    assert majority_of_tally({"a": 0}) is None


def test_tally() -> None:
    assert tally(["a", "b", "a"]) == {"a": 2, "b": 1}
    assert list(tally(["b", "a"])) == ["b", "a"]


# ---- Fleiss' κ ---------------------------------------------------------------------------------


def test_fleiss_kappa_fleiss_1971_example() -> None:
    """Fleiss(1971) 의 예제: 문항 10개, 평가자 14명, 범주 5개 → κ = 0.210."""
    counts = [
        [0, 0, 0, 0, 14], [0, 2, 6, 4, 2], [0, 0, 3, 5, 6], [0, 3, 9, 2, 0], [2, 2, 8, 1, 1],
        [7, 7, 0, 0, 0], [3, 2, 6, 3, 0], [2, 5, 3, 2, 2], [6, 5, 2, 1, 0], [0, 2, 2, 3, 7],
    ]
    items = [[f"c{category}" for category, n in enumerate(row) for _ in range(n)] for row in counts]
    assert fleiss_kappa(items) == pytest.approx(0.21, abs=5e-4)


def test_fleiss_kappa_edge_cases() -> None:
    assert fleiss_kappa([["a", "a", "a"], ["b", "b", "b"]]) == 1
    assert fleiss_kappa([]) is None
    assert fleiss_kappa([["a"], ["b"]]) is None                          # 평가자가 1명
    assert fleiss_kappa([["a", "a", "a"], ["a", "a", "a"]]) is None      # 모든 표가 한 범주라 P̄e = 1
    with pytest.raises(ValueError):
        fleiss_kappa([["a", "b"], ["a", "b", "a"]])


def approved_votes(batch_id: str) -> list[Vote]:
    """data/ 의 Approved 응답에서 attention 을 뺀 표 (handlers.ts 의 approvedVotes 와 같은 규칙)."""
    folder = DATA_DIR / "batches" / batch_id
    batch = json.loads((folder / "batch.json").read_text(encoding="utf-8"))
    prefix = (batch.get("attentionRule") or {}).get("namePrefix", "attention_")
    row_index = {h["HITId"]: h["rowIndex"] for h in json.loads((folder / "hits.json").read_text(encoding="utf-8"))}
    votes = []
    for a in json.loads((folder / "assignments.json").read_text(encoding="utf-8")):
        if a["AssignmentStatus"] != "Approved":
            continue
        for answer in a["answers"]:
            if not is_attention_name(answer["name"], prefix):
                votes.append(Vote(row_index[a["HITId"]], answer["name"], answer["value"], a["WorkerId"]))
    return votes


@pytest.mark.parametrize("batch_id, item_count, kappa", [
    ("batch-1000001", 420, 0.730594),
    ("batch-1000003", 241, 0.938407),
    ("batch-1000002", 326, 0.856749),
])
def test_fleiss_kappa_matches_statsmodels_on_seed_data(batch_id: str, item_count: int, kappa: float) -> None:
    """M2 완료 기준 (8.4): 기존 *_iaa.py 가 쓰는 statsmodels 의 fleiss_kappa 와 소수 여섯째 자리까지 같다 (투표 3건인 문항만)."""
    items = collect_items(approved_votes(batch_id))
    summary = summarize_results(items, 3)
    assert summary["kappaItemCount"] == item_count
    assert round(summary["fleissKappa"], 6) == kappa


# ---- collect_items, summarize_results ------------------------------------------------------------


def votes_example() -> list[Vote]:
    return [
        Vote(1, "general_10_1", "a", "W1"), Vote(0, "general_2_1", "a", "W1"), Vote(0, "general_2_1", "a", "W2"), Vote(0, "general_2_1", "a", "W3"),
        Vote(0, "general_10_1", "a", "W1"), Vote(0, "general_10_1", "b", "W2"), Vote(1, "general_10_1", "b", "W2"),
    ]


def test_collect_items_groups_and_sorts_naturally() -> None:
    """문항별로 묶고 행, 문항 이름(숫자 순)으로 정렬한다: general_2_1 < general_10_1."""
    items = collect_items(votes_example())
    assert [item.key for item in items] == ["0:general_2_1", "0:general_10_1", "1:general_10_1"]
    assert items[0].to_json() == {"key": "0:general_2_1", "rowIndex": 0, "answerName": "general_2_1", "votes": ["a", "a", "a"],
                                  "workers": ["W1", "W2", "W3"], "majority": "a", "unanimous": True}
    assert items[1].majority is None and items[1].unanimous is False
    assert collect_items([]) == []


def test_summarize_results_uses_full_items_for_kappa() -> None:
    """κ 와 만장일치 비율은 투표 수가 target 인 문항만, 라벨 분포는 전체 표로 센다. 정수 값의 비율은 정수(1)다."""
    items = collect_items(votes_example())
    summary = summarize_results(items, 3)
    assert summary["kappaItemCount"] == 1 and summary["unanimousRatio"] == 1 and isinstance(summary["unanimousRatio"], int)
    assert summary["labelDistribution"] == {"a": 5, "b": 2}
    assert summary["fleissKappa"] is None       # 문항 하나가 전부 a 라 P̄e = 1
    assert summarize_results([], 3) == {"unanimousRatio": None, "fleissKappa": None, "kappaItemCount": 0, "labelDistribution": {}}


def test_labels_json_shape() -> None:
    labels = json.loads(build_labels_json(collect_items(votes_example())))
    assert labels["0:general_2_1"] == {"votes": ["a", "a", "a"], "majority": "a", "workers": ["W1", "W2", "W3"]}
    assert list(labels) == ["0:general_2_1", "0:general_10_1", "1:general_10_1"]


def test_agreement_with_others() -> None:
    """다른 worker 들의 majority 와 같은 비율. 동률이거나 표가 없는 문항은 제외한다."""
    def answers(values: dict) -> list[dict]:
        return [{"name": name, "value": value} for name, value in values.items()]

    own = answers({"q1": "a", "q2": "a", "q3": "a", "q4": "a"})
    others = [answers({"q1": "a", "q2": "b", "q3": "a"}), answers({"q1": "a", "q2": "b", "q3": "b"})]
    assert agreement_with_others(own, others) == 0.5    # q1 일치, q2 불일치, q3 동률, q4 표 없음
    assert agreement_with_others(own, []) is None
