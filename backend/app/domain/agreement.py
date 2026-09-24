"""Majority 와 Fleiss' κ. prototype/src/domain/agreement.ts 를 그대로 옮겼다.

agreement.test.ts 의 기대값:
    item_key(12, "general_0_1") == "12:general_0_1"
    majority(["grounded", "grounded", "not_grounded"]) == "grounded", majority(["Yes"]) == "Yes"
    majority(["grounded", "not_grounded"]) is None, majority(["a", "a", "b", "b", "c"]) is None   (동률)
    majority(["a", "b", "a", "b", "c", "c", "c"]) == "c"                                          (뒤의 값이 동률을 깬다)
    majority([]) is None
    majority_of_tally({"a": 0, "b": 1}) == "b", majority_of_tally({"a": 0}) is None               (0 이하는 없는 표)
    tally(["a", "b", "a"]) == {"a": 2, "b": 1}
handlers.test.ts 의 κ (data/ 의 Approved, attention 제외, 투표 3건인 문항; statsmodels 0.14 와 소수 다섯째 자리까지 같다):
    batch-1000001  420 문항  0.730594
    batch-1000003  241 문항  0.938407
    batch-1000002  326 문항  0.856749
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

from app.domain.js import js_number, natural_key


def item_key(row_index: int, answer_name: str) -> str:
    """문항 키. 라벨 JSON export 의 키와 같다."""
    return f"{row_index}:{answer_name}"


def tally(votes: Iterable[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for vote in votes:
        counts[vote] = counts.get(vote, 0) + 1
    return counts


def majority_of_tally(counts: dict[str, int]) -> str | None:
    """최다 득표 값. 표가 없거나 동률이면 None."""
    best: str | None = None
    best_count = 0
    tied = False
    for value, count in counts.items():
        if count <= 0:
            continue
        if count > best_count:
            best, best_count, tied = value, count, False
        elif count == best_count:
            tied = True
    return None if tied else best


def majority(votes: list[str]) -> str | None:
    return majority_of_tally(tally(votes))


@dataclass
class Vote:
    row_index: int
    answer_name: str
    value: str
    worker_id: str


@dataclass
class VotedItem:
    key: str
    rowIndex: int
    answerName: str
    votes: list[str] = field(default_factory=list)
    workers: list[str] = field(default_factory=list)   # votes 와 같은 순서
    majority: str | None = None
    unanimous: bool = False

    def to_json(self) -> dict:
        return {"key": self.key, "rowIndex": self.rowIndex, "answerName": self.answerName, "votes": self.votes,
                "workers": self.workers, "majority": self.majority, "unanimous": self.unanimous}


def collect_items(votes: Iterable[Vote]) -> list[VotedItem]:
    """표를 문항별로 묶는다 (rowIndex, answerName 의 자연 순서). 어떤 표를 넣을지(Approved 만, attention 제외)는 호출하는 쪽이 정한다."""
    by_key: dict[str, VotedItem] = {}
    for vote in votes:
        key = item_key(vote.row_index, vote.answer_name)
        item = by_key.get(key)
        if item is None:
            item = by_key[key] = VotedItem(key, vote.row_index, vote.answer_name)
        item.votes.append(vote.value)
        item.workers.append(vote.worker_id)
    items = list(by_key.values())
    for item in items:
        item.majority = majority(item.votes)
        item.unanimous = len(item.votes) > 1 and len(set(item.votes)) == 1
    items.sort(key=lambda item: (item.rowIndex, natural_key(item.answerName)))
    return items


def fleiss_kappa(items: list[list[str]]) -> float | None:
    """Fleiss' κ. 모든 문항의 투표 수가 같아야 한다 (평가자 n 명).

        P_i = (Σ_j n_ij² - n) / (n(n-1)),  P̄ = mean(P_i),  p_j = Σ_i n_ij / (N·n),  P̄e = Σ_j p_j²,  κ = (P̄ - P̄e) / (1 - P̄e)

    문항이 없거나, n < 2 이거나, 모든 표가 한 범주라 P̄e = 1 이면 None.
    """
    total_items = len(items)
    if total_items == 0:
        return None
    n = len(items[0])
    if n < 2:
        return None
    if any(len(votes) != n for votes in items):
        raise ValueError("fleiss_kappa: every item must have the same number of votes")

    category_totals: dict[str, int] = {}
    sum_p = 0.0
    for votes in items:
        sum_squares = 0
        for value, count in tally(votes).items():
            sum_squares += count * count
            category_totals[value] = category_totals.get(value, 0) + count
        sum_p += (sum_squares - n) / (n * (n - 1))
    mean_p = sum_p / total_items
    expected = 0.0
    for total in category_totals.values():
        expected += (total / (total_items * n)) ** 2
    if 1 - expected < 1e-12:
        return None
    return (mean_p - expected) / (1 - expected)


def summarize_results(items: list[VotedItem], target: int) -> dict:
    """κ 와 만장일치 비율은 투표 수가 정확히 target 인 문항만으로 계산한다 (기존 *_iaa.py 와 같은 기준)."""
    full = [item for item in items if len(item.votes) == target]
    label_distribution: dict[str, int] = {}
    for item in items:
        for value in item.votes:
            label_distribution[value] = label_distribution.get(value, 0) + 1
    unanimous = None if not full else js_number(sum(1 for item in full if item.unanimous) / len(full))
    kappa = fleiss_kappa([item.votes for item in full])
    return {
        "unanimousRatio": unanimous,
        "fleissKappa": None if kappa is None else js_number(kappa),
        "kappaItemCount": len(full),
        "labelDistribution": label_distribution,
    }


def agreement_with_others(own: list[dict], others: list[list[dict]]) -> float | int | None:
    """assignment 1건의 일치율: 각 문항에서 "같은 HIT 의 다른 worker 들" majority 와 같은 비율. 비교할 문항이 없으면 None."""
    tallies: dict[str, dict[str, int]] = {}
    for answers in others:
        for answer in answers:
            counts = tallies.setdefault(answer["name"], {})
            counts[answer["value"]] = counts.get(answer["value"], 0) + 1
    compared = agreed = 0
    for answer in own:
        others_majority = majority_of_tally(tallies.get(answer["name"], {}))
        if others_majority is None:
            continue
        compared += 1
        if others_majority == answer["value"]:
            agreed += 1
    return None if compared == 0 else js_number(agreed / compared)
