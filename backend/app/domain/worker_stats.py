"""Worker 지표 (WorkerStats). 모든 batch 를 합산한다. prototype/src/domain/workerStats.ts 를 그대로 옮겼다.

workerStats.test.ts 의 기대값:
    median([5, 1, 3]) == 3, median([4, 1, 3, 2]) == 2.5, median([]) is None
    W1: Approved 2, Rejected 1, Submitted 1 → total 4, approved 2, rejected 1, pending 1, rejectRate 1/3
    검수된 건이 없으면 rejectRate 는 None. attention 실패율은 판정이 있는 assignment 만 분모 (passed, failed, 없음 → 0.5)
    medianWorkTimeInSeconds 100 (60, 400, 100), batchCount 2, lastActiveAt 는 가장 늦은 SubmitTime
    majority 일치율: q1 에 W1=a, W2=a, W3=b → W3 는 [a, a] 와 비교되어 0, W1 은 [a, b] 동률이라 None
                   W1=a, W2=b 둘뿐이면 둘 다 0 (자기 표를 빼면 상대의 표와 비교된다)
                   4 문항 예시: W1 0.5, W2 1 (다른 표가 동률인 문항은 제외)
                   attention 문항은 세지 않는다. 반려된 응답은 비교 기준에 들어가지 않지만 평가 대상은 된다
                   같은 rowIndex 라도 batch 가 다르면 다른 문항이다
"""

from __future__ import annotations

from dataclasses import dataclass

from app.domain.agreement import majority_of_tally
from app.domain.attention import is_attention_name
from app.domain.js import js_number
from app.domain.progress import reject_rate

EMPTY_STATS = {
    "total": 0, "approved": 0, "rejected": 0, "pending": 0,
    "rejectRate": None, "attentionFailRate": None, "medianWorkTimeInSeconds": None, "majorityAgreement": None,
    "batchCount": 0, "lastActiveAt": None,
}


@dataclass(frozen=True)
class WorkerStatsRecord:
    assignment: dict
    batch_id: str
    row_index: int
    attention_prefix: str   # 실제 문항과 attention 문항을 가르는 prefix


def median(values: list[float]) -> float | int | None:
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    return ordered[mid] if len(ordered) % 2 == 1 else js_number((ordered[mid - 1] + ordered[mid]) / 2)


def _real_answers(record: WorkerStatsRecord) -> list[dict]:
    return [a for a in record.assignment.get("answers", []) if not is_attention_name(str(a.get("name", "")), record.attention_prefix)]


def compute_worker_stats(records: list[WorkerStatsRecord]) -> dict[str, dict]:
    """WorkerId → WorkerStats. worker 의 순서는 records 에 처음 나온 순서다 (목록의 기본 순서가 된다).

    majority 일치율은 이 worker 의 응답이 "같은 문항의 다른 worker 들" majority 와 같은 비율이다. 자기 표는 빼고, 다른 worker 의
    표가 없거나 동률이면 그 문항은 제외한다. 비교 기준이 되는 다른 worker 의 표는 Rejected 가 아닌 assignment 에서만 모은다.
    """
    def question_key(record: WorkerStatsRecord, name: str) -> str:
        return f"{record.batch_id}|{record.row_index}:{name}"

    tallies: dict[str, dict[str, int]] = {}
    for record in records:
        if record.assignment.get("AssignmentStatus") == "Rejected":
            continue
        for answer in _real_answers(record):
            counts = tallies.setdefault(question_key(record, answer["name"]), {})
            counts[answer["value"]] = counts.get(answer["value"], 0) + 1

    by_worker: dict[str, list[WorkerStatsRecord]] = {}
    for record in records:
        by_worker.setdefault(record.assignment["WorkerId"], []).append(record)

    result: dict[str, dict] = {}
    for worker_id, own in by_worker.items():
        approved = rejected = pending = 0
        attention_judged = attention_failed = 0
        compared = agreed = 0
        last_active_at: str | None = None

        for record in own:
            assignment = record.assignment
            status = assignment.get("AssignmentStatus")
            if status == "Approved":
                approved += 1
            elif status == "Rejected":
                rejected += 1
            else:
                pending += 1

            attention = assignment.get("attention")
            if attention:
                attention_judged += 1
                if not attention.get("passed"):
                    attention_failed += 1
            submit_time = assignment.get("SubmitTime")
            if last_active_at is None or submit_time > last_active_at:
                last_active_at = submit_time

            own_vote_counted = status != "Rejected"
            for answer in _real_answers(record):
                others = dict(tallies.get(question_key(record, answer["name"]), {}))
                if own_vote_counted:
                    others[answer["value"]] = others.get(answer["value"], 0) - 1
                others_majority = majority_of_tally(others)
                if others_majority is None:
                    continue
                compared += 1
                if others_majority == answer["value"]:
                    agreed += 1

        result[worker_id] = {
            "total": len(own),
            "approved": approved,
            "rejected": rejected,
            "pending": pending,
            "rejectRate": reject_rate(approved, rejected),
            "attentionFailRate": None if attention_judged == 0 else js_number(attention_failed / attention_judged),
            "medianWorkTimeInSeconds": median([record.assignment.get("workTimeInSeconds", 0) for record in own]),
            "majorityAgreement": None if compared == 0 else js_number(agreed / compared),
            "batchCount": len({record.batch_id for record in own}),
            "lastActiveAt": last_active_at,
        }
    return result
