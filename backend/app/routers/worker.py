"""worker 의 작업 API (app/routes.py 의 WORKER_ROUTES). worker 계정만 부른다. 규칙은 app/domain/tasks.py 에 있다.

    GET  /api/worker/hit-groups                    받을 수 있는 HIT 가 남은 batch (MTurk 의 HIT group)
    POST /api/worker/hit-groups/{batchId}/accept   그 batch 에서 다음 HIT 를 받는다 → {assignment}. 이미 푸는 중이면 그것을 돌려준다
    GET  /api/worker/assignments                   내 assignment (푸는 중, 제출, 승인, 반려)와 금액 요약
    GET  /api/worker/assignments/{id}              assignment 하나. 푸는 중이면 작업 화면(task: 템플릿과 보여도 되는 입력)을 함께
    POST /api/worker/assignments/{id}/submit       {answers: [{name, value}]} → Submitted
    POST /api/worker/assignments/{id}/return       반납 → Returned (자리가 다시 열린다)

HIT 를 받는 처리는 쓰기 트랜잭션 안에서 자리를 세고 assignment 를 만들므로 (쓰기는 하나씩 처리된다, app/db.py) 자리보다 많이
나가지 않는다. 제한 시간이 지난 Accepted 는 자리를 차지하지 않고, 쓰기 요청이 올 때 Abandoned 로 바꾼다.
Requester 가 차단한 worker 는 그 Requester 의 batch 를 받을 수 없고, batch 의 requiredPoolIds 와 excludedPoolIds 를 따른다.
"""

from __future__ import annotations

from datetime import datetime
from typing import Callable

from fastapi import APIRouter, Request
from starlette.concurrency import run_in_threadpool

from app.accounts import forbidden
from app.auth import current_user, require_roles
from app.db import Store
from app.domain.attention import judge_attention
from app.domain.cost import format_cents, reward_to_cents
from app.domain.progress import is_expired, parse_time
from app.domain.tasks import ACCEPTED, check_answers, ineligible_reason, visible_row
from app.errors import invalid, not_found
from app.routers.common import after_seconds, body_field, db_of, find_batch, iso, mturk_like_id, now, read_body, resync_hits
from app.routes import WORKER_ROUTES, fastapi_path

LISTED_STATUSES = (ACCEPTED, "Submitted", "Approved", "Rejected")   # 내 HIT 목록 (반납과 시간 초과는 보이지 않는다)


def _worker_id(request: Request) -> str:
    worker_id = current_user(request).get("worker_id")
    if not worker_id:
        raise forbidden("This account has no Worker ID.")
    return worker_id


def _effective_status(assignment: dict, at: datetime) -> str:
    """제한 시간이 지난 Accepted 는 아직 저장되지 않았어도 Abandoned 로 본다."""
    status = assignment.get("AssignmentStatus")
    if status == ACCEPTED:
        deadline = parse_time(assignment.get("Deadline"))
        if deadline is not None and deadline <= at:
            return "Abandoned"
    return status


def sweep_abandoned(store: Store, at: datetime) -> int:
    """제한 시간이 지난 Accepted 를 Abandoned 로 바꾸고 그 HIT 의 필드를 맞춘다. 바꾼 수."""
    stale = store.stale_accepted()
    for assignment in stale:
        assignment["AssignmentStatus"] = "Abandoned"
        assignment["AbandonTime"] = assignment.get("Deadline")
        store.update_assignment(assignment)
    if stale:
        resync_hits(store, [a["HITId"] for a in stale], at)
    return len(stale)


def _assignment_json(assignment: dict, batch: dict, row_index: int, at: datetime) -> dict:
    settings = batch["settings"]
    status = _effective_status(assignment, at)
    result = {
        "assignmentId": assignment["AssignmentId"],
        "batchId": batch["id"],
        "hitId": assignment["HITId"],
        "rowIndex": row_index,
        "status": status,
        "title": settings.get("Title", batch["name"]),
        "description": settings.get("Description", ""),
        "reward": settings.get("Reward"),
        "assignmentDurationInSeconds": settings.get("AssignmentDurationInSeconds"),
        "acceptTime": assignment.get("AcceptTime"),
        "deadline": assignment.get("Deadline") if status == ACCEPTED else None,
        "submitTime": assignment.get("SubmitTime"),
        "feedback": assignment.get("RequesterFeedback") if status in ("Approved", "Rejected") else None,
    }
    return result


# ---- 목록과 받기 ----------------------------------------------------------------------------------


async def list_hit_groups(request: Request) -> dict:
    worker_id = _worker_id(request)
    at = now()
    with db_of(request).transaction() as store:
        batches = store.list_batches()
        owners = store.owners_of_batches()
        names = store.display_names()
        blockers = store.blockers_of(worker_id)
        pools = {pool["id"]: pool for pool in store.list_pools()}
        slots = store.hit_slots(worker_id)
        active = {row["batch_id"]: row["doc"]["AssignmentId"] for row in store.worker_task_rows(worker_id)
                  if _effective_status(row["doc"], at) == ACCEPTED}

    available: dict[str, int] = {}
    latest: dict[str, str] = {}
    for slot in slots:
        if is_expired(slot["expiration"], at) or slot["used"] >= slot["max_assignments"] or slot["mine"]:
            continue
        available[slot["batch_id"]] = available.get(slot["batch_id"], 0) + 1
        latest[slot["batch_id"]] = max(latest.get(slot["batch_id"], ""), slot["expiration"])

    groups = []
    for batch in sorted(batches, key=lambda b: b["createdAt"], reverse=True):
        count, assignment_id = available.get(batch["id"], 0), active.get(batch["id"])
        if count == 0 and assignment_id is None:
            continue
        owner_id = owners.get(batch["id"])
        if assignment_id is None and ineligible_reason(batch, worker_id, pools, owner_id is not None and owner_id in blockers):
            continue
        settings = batch["settings"]
        groups.append({
            "batchId": batch["id"],
            "title": settings.get("Title", batch["name"]),
            "description": settings.get("Description", ""),
            "keywords": settings.get("Keywords", ""),
            "reward": settings.get("Reward"),
            "assignmentDurationInSeconds": settings.get("AssignmentDurationInSeconds"),
            "availableHits": count,
            "expiresAt": latest.get(batch["id"]),
            "requester": names.get(owner_id or "", "Lab"),
            "activeAssignmentId": assignment_id,
        })
    return {"groups": groups}


async def accept_hit(request: Request, batchId: str) -> dict:
    worker_id = _worker_id(request)
    db = db_of(request)

    def work() -> dict:
        with db.transaction(write=True) as store:
            at = now()
            sweep_abandoned(store, at)
            batch = find_batch(store, batchId)
            owner_id = store.owner_of_batch(batchId)
            reason = ineligible_reason(batch, worker_id, {p["id"]: p for p in store.list_pools()},
                                       owner_id is not None and store.blocked_by(owner_id, worker_id))
            if reason:
                raise forbidden(reason)
            for row in store.worker_task_rows(worker_id):   # 이 batch 에서 푸는 중인 HIT 가 있으면 그것을 이어서 한다
                if row["batch_id"] == batchId and _effective_status(row["doc"], at) == ACCEPTED:
                    return _assignment_json(row["doc"], batch, row["row_index"], at)
            candidates = [slot for slot in store.hit_slots(worker_id, batchId)
                          if not is_expired(slot["expiration"], at) and slot["used"] < slot["max_assignments"] and not slot["mine"]]
            if not candidates:
                raise invalid("There are no more HITs in this batch for you.")
            slot = candidates[0]
            previous = store.assignment_for(slot["id"], worker_id)   # 반납했거나 시간이 지난 HIT 를 다시 받는 경우
            assignment = {
                "AssignmentId": previous["AssignmentId"] if previous else mturk_like_id(),
                "HITId": slot["id"],
                "WorkerId": worker_id,
                "AssignmentStatus": ACCEPTED,
                "AcceptTime": iso(at),
                "Deadline": iso(after_seconds(at, batch["settings"]["AssignmentDurationInSeconds"])),
            }
            if previous:
                store.update_assignment(assignment)
            else:
                store.insert_assignment(assignment)
            resync_hits(store, [slot["id"]], at)
            return _assignment_json(assignment, batch, slot["row_index"], at)

    return {"assignment": await run_in_threadpool(work)}


# ---- 내 assignment ------------------------------------------------------------------------------


async def list_my_assignments(request: Request) -> dict:
    worker_id = _worker_id(request)
    at = now()
    with db_of(request).transaction() as store:
        rows = store.worker_task_rows(worker_id)
        batches = {batch_id: store.get_batch(batch_id) for batch_id in {row["batch_id"] for row in rows}}
    items = [_assignment_json(row["doc"], batches[row["batch_id"]], row["row_index"], at) for row in rows]
    items = [item for item in items if item["status"] in LISTED_STATUSES]
    cents = {"Approved": 0, "Submitted": 0}
    counts = {status: 0 for status in LISTED_STATUSES}
    for item in items:
        counts[item["status"]] += 1
        if item["status"] in cents:
            cents[item["status"]] += reward_to_cents(item["reward"] or "0")
    return {"assignments": items, "summary": {
        "inProgress": counts[ACCEPTED], "submitted": counts["Submitted"], "approved": counts["Approved"], "rejected": counts["Rejected"],
        "approvedReward": format_cents(cents["Approved"]), "pendingReward": format_cents(cents["Submitted"]),
    }}


def _own_assignment(store: Store, id: str, worker_id: str) -> dict:
    assignment = store.any_assignment(id)
    if assignment is None or assignment.get("WorkerId") != worker_id:
        raise not_found("Assignment", id)
    return assignment


async def get_my_assignment(request: Request, id: str) -> dict:
    worker_id = _worker_id(request)
    at = now()
    with db_of(request).transaction() as store:
        assignment = _own_assignment(store, id, worker_id)
        hit = store.get_hit(assignment["HITId"])
        batch = find_batch(store, hit["batchId"])
    result = _assignment_json(assignment, batch, hit["rowIndex"], at)
    if result["status"] == ACCEPTED:
        result["task"] = {"html": batch.get("templateHtml") or "", "row": visible_row(batch, hit.get("input"))}
    return {"assignment": result}


async def submit_assignment(request: Request, id: str) -> dict:
    worker_id = _worker_id(request)
    try:
        answers = check_answers(body_field(await read_body(request), "answers"))
    except ValueError as error:
        raise invalid(str(error)) from None
    with db_of(request).transaction(write=True) as store:
        at = now()
        assignment = _own_assignment(store, id, worker_id)
        status = _effective_status(assignment, at)
        if status == "Abandoned":
            raise invalid("The time for this HIT ran out, so it was not submitted. Accept the HIT again to work on it.")
        if status != ACCEPTED:
            raise invalid(f"This assignment is already {status.lower()}.")
        hit = store.get_hit(assignment["HITId"])
        batch = find_batch(store, hit["batchId"])
        accepted_at = parse_time(assignment.get("AcceptTime")) or at
        assignment.update({
            "AssignmentStatus": "Submitted",
            "SubmitTime": iso(at),
            "AutoApprovalTime": iso(after_seconds(at, batch["settings"].get("AutoApprovalDelayInSeconds", 0))),
            "answers": answers,
            "workTimeInSeconds": max(0, int((at - accepted_at).total_seconds())),
            "attention": judge_attention(answers, batch.get("attentionRule"), hit.get("input")),
        })
        assignment.pop("Deadline", None)
        store.update_assignment(assignment)
        resync_hits(store, [hit["HITId"]], at)
        return {"assignment": _assignment_json(assignment, batch, hit["rowIndex"], at)}


async def return_assignment(request: Request, id: str) -> dict:
    worker_id = _worker_id(request)
    with db_of(request).transaction(write=True) as store:
        at = now()
        assignment = _own_assignment(store, id, worker_id)
        if _effective_status(assignment, at) != ACCEPTED:
            raise invalid(f"Only a HIT you are working on can be returned (this one is {_effective_status(assignment, at).lower()}).")
        assignment["AssignmentStatus"] = "Returned"
        assignment["ReturnTime"] = iso(at)
        assignment.pop("Deadline", None)
        store.update_assignment(assignment)
        resync_hits(store, [assignment["HITId"]], at)
        hit = store.get_hit(assignment["HITId"])
        batch = find_batch(store, hit["batchId"])
        return {"assignment": _assignment_json(assignment, batch, hit["rowIndex"], at)}


HANDLERS: dict[str, Callable] = {
    "listHitGroups": list_hit_groups,
    "acceptHit": accept_hit,
    "listMyAssignments": list_my_assignments,
    "getMyAssignment": get_my_assignment,
    "submitAssignment": submit_assignment,
    "returnAssignment": return_assignment,
}


def build_worker_router() -> APIRouter:
    router = APIRouter(dependencies=[require_roles("worker")])
    for name, route in WORKER_ROUTES.items():
        router.add_api_route(fastapi_path(route.path), HANDLERS[name], methods=[route.method], name=name, operation_id=name)
    return router
