"""HIT 진행률과 batch 상태. prototype/src/domain/progress.ts 를 그대로 옮겼다 (같은 계산, 같은 반올림 없음).

progress.test.ts 의 기대값:
    count_by_status([Approved, Approved, Rejected, Submitted]) == (submitted 1, approved 2, rejected 1)
    hit_progress(3, (0, 3, 0), target 3)  → open 0, completed True,  shortfall 0
    hit_progress(3, (0, 2, 1), target 3)  → open 0, completed False, shortfall 1   (반려는 자리를 다시 열어 주지 않는다)
    hit_progress(3, (1, 1, 0), target 3)  → open 1, completed False, shortfall 0   (검수 대기와 열린 자리는 부족분이 아니다)
    hit_progress(5, (1, 1, 2), target 3)  → open 1, completed False, shortfall 0   (재모집으로 MaxAssignments 가 늘어난 HIT)
    hit_progress(3, (0, 4, 0), target 3)  → open 0                                  (open 은 음수가 되지 않는다)
    is_expired("2025-11-08T07:30:20Z", 2025-11-08T07:30:19Z) is False, 같은 시각이면 True
    batch_status([(completed True, expired True)]) == "completed"
    batch_status([(True, True), (False, True)]) == "expired"
    batch_status([(False, True), (False, False)]) == "in_progress"
    reject_rate(108, 18) == 18 / 126, reject_rate(0, 0) is None
    summarize_progress([hit_progress(3, (0,3,0), 3), hit_progress(4, (1,1,1), 3)])
        == {hitsTotal 2, hitsCompleted 1, submitted 1, approved 4, rejected 1, open 1, rejectRate 1/5}
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable

BatchStatus = str  # "in_progress" | "completed" | "expired"


@dataclass(frozen=True)
class AssignmentCounts:
    submitted: int = 0
    approved: int = 0
    rejected: int = 0


@dataclass(frozen=True)
class HitProgress:
    submitted: int
    approved: int
    rejected: int
    open: int          # 아직 아무도 제출하지 않은 자리
    completed: bool    # approved ≥ target
    shortfall: int     # 'fill-to-target' 재모집으로 추가해야 할 수


def count_by_status(statuses: Iterable[str]) -> AssignmentCounts:
    """AssignmentStatus 값들을 상태별로 센다. Submitted, Approved 가 아닌 것은 모두 Rejected 로 센다 (TS 와 같다)."""
    submitted = approved = rejected = 0
    for status in statuses:
        if status == "Submitted":
            submitted += 1
        elif status == "Approved":
            approved += 1
        else:
            rejected += 1
    return AssignmentCounts(submitted, approved, rejected)


def hit_progress(max_assignments: int, counts: AssignmentCounts, target: int) -> HitProgress:
    """target 은 batch.settings.MaxAssignments(목표 라벨 수)다. hit.MaxAssignments 는 재모집으로 더 클 수 있다."""
    submitted, approved, rejected = counts.submitted, counts.approved, counts.rejected
    open_slots = max(0, max_assignments - (approved + rejected + submitted))
    return HitProgress(
        submitted=submitted,
        approved=approved,
        rejected=rejected,
        open=open_slots,
        completed=approved >= target,
        shortfall=max(0, target - approved - submitted - open_slots),
    )


def parse_time(text: str) -> datetime | None:
    """ISO 8601 문자열 → aware datetime. JS 의 new Date() 가 NaN 이 되는 값은 None."""
    if not isinstance(text, str) or not text:
        return None
    try:
        value = datetime.fromisoformat(text.replace("Z", "+00:00") if text.endswith("Z") else text)
    except ValueError:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value


def is_expired(expiration: str, now: datetime) -> bool:
    """만료 시각이 now 이하이면 True. 시각을 읽을 수 없으면 JS 처럼 (NaN 비교) False."""
    value = parse_time(expiration)
    return value is not None and value <= now


def batch_status(hits: Iterable[tuple[bool, bool]]) -> BatchStatus:
    """(completed, expired) 목록. 모든 HIT 가 완료되면 completed, 남은 미완료 HIT 가 전부 만료됐으면 expired, 그 외 in_progress."""
    incomplete = [expired for completed, expired in hits if not completed]
    if not incomplete:
        return "completed"
    return "expired" if all(incomplete) else "in_progress"


def reject_rate(approved: int, rejected: int) -> float | int | None:
    """반려 / (승인 + 반려). 검수한 건이 없으면 None. 0 과 1 은 JS 의 JSON 처럼 정수로 (0.0 이 아니라 0)."""
    reviewed = approved + rejected
    if reviewed == 0:
        return None
    rate = rejected / reviewed
    return int(rate) if rate.is_integer() else rate


def summarize_progress(hits: list[HitProgress]) -> dict:
    """HIT 별 진행률을 batch 단위(BatchProgress)로 합친다."""
    approved = sum(h.approved for h in hits)
    rejected = sum(h.rejected for h in hits)
    return {
        "hitsTotal": len(hits),
        "hitsCompleted": sum(1 for h in hits if h.completed),
        "submitted": sum(h.submitted for h in hits),
        "approved": approved,
        "rejected": rejected,
        "open": sum(h.open for h in hits),
        "rejectRate": reject_rate(approved, rejected),
    }


# ---- 재모집 --------------------------------------------------------------------------------------
# progress.test.ts 'planTopUp' 의 기대값:
#     plan_top_up(3, 3, shortfall 2, "fill-to-target") == TopUpPlan(2)
#     plan_top_up(3, 3, shortfall 0, "fill-to-target") == TopUpPlan(0, "No shortfall: …")
#     plan_top_up(6, 6, shortfall 0, 4)  → add 0, reason "MTurk limit: … cannot exceed 9 (now 6, requested +4)."
#     plan_top_up(10, 10, shortfall 0, 5) == TopUpPlan(5)     (처음부터 10 이상이면 상한이 없다)

MAX_TOTAL_WHEN_CREATED_UNDER_10 = 9   # 처음에 10 미만으로 만든 HIT 는 추가해도 합계가 10 이상이 될 수 없다 (MTurk 제약)
HIGH_VOLUME_THRESHOLD = 10


@dataclass(frozen=True)
class TopUpPlan:
    add: int                   # 0 이면 건너뛴다
    reason: str | None = None  # 건너뛴 사유


def plan_top_up(max_assignments: int, initial_max_assignments: int, shortfall: int, mode: int | str) -> TopUpPlan:
    """HIT 1개에 assignment 를 몇 개 추가할지. mode 가 숫자면 그만큼, 'fill-to-target' 이면 부족분만큼.

    상한을 넘으면 일부만 추가하지 않고 그 HIT 를 건너뛴다 (일부만 추가해도 목표를 채울 수 없다).
    """
    requested = shortfall if mode == "fill-to-target" else mode
    if isinstance(requested, bool) or not isinstance(requested, (int, float)) or requested != int(requested) or requested < 0:
        raise ValueError(f"Invalid number of assignments to add: {mode}")
    requested = int(requested)
    if requested == 0:
        return TopUpPlan(0, "No shortfall: open and submitted assignments already cover the target.")
    if initial_max_assignments < HIGH_VOLUME_THRESHOLD:
        room = MAX_TOTAL_WHEN_CREATED_UNDER_10 - max_assignments
        if requested > room:
            return TopUpPlan(0, f"MTurk limit: a HIT created with fewer than 10 assignments cannot exceed "
                                f"{MAX_TOTAL_WHEN_CREATED_UNDER_10} (now {max_assignments}, requested +{requested}).")
    return TopUpPlan(requested)
