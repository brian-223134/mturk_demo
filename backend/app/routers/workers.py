"""Worker Pool 화면의 REST: worker 목록과 상세(지표, batch 별 이력), 메모, pool 만들기와 편집, 차단. prototype/src/api/mock/
handlers.ts 의 listWorkers … unblockWorkers 와 같은 검증과 결과다.

worker 목록은 모든 assignment 를 훑어 지표(app/domain/worker_stats.py)를 계산한 것이다. 응답이 없어도 pool 에 들어 있거나
메모·차단이 붙은 worker 는 빈 지표(EMPTY_STATS)로 목록에 나온다. 기본 순서는 응답에 처음 나온 순서, 그 뒤에 pool 의 worker,
그 뒤에 메모가 붙은 worker 다 (프로토타입의 buildWorkers 와 같다).
"""

from __future__ import annotations

from typing import Callable

from fastapi import Request, Response

from app.db import Store
from app.domain.js import js_number_of, js_string, locale_key, slug
from app.domain.list_query import apply_list_query
from app.domain.progress import count_by_status
from app.domain.worker_stats import EMPTY_STATS, WorkerStatsRecord, compute_worker_stats
from app.errors import invalid, not_found
from app.routers.common import (attention_prefix_of, body_field, db_of, find_pool, list_query_of, no_content, object_body,
                                read_body, string_array, unique_slug_id)


def build_workers(store: Store) -> list[dict]:
    """Worker 목록 (WorkerId, stats, poolIds, blocked, note)."""
    prefixes = {batch["id"]: attention_prefix_of(batch) for batch in store.list_batches()}
    records = [WorkerStatsRecord(assignment, batch_id, row_index, prefixes.get(batch_id, attention_prefix_of(None)))
               for assignment, batch_id, row_index in store.assignment_records()]
    stats = compute_worker_stats(records)
    pools = store.list_pools()
    meta = store.all_worker_meta()

    ids: dict[str, None] = dict.fromkeys(stats)
    for pool in pools:
        ids.update(dict.fromkeys(pool.get("workerIds", [])))
    ids.update(dict.fromkeys(meta))
    return [{
        "WorkerId": worker_id,
        "stats": stats.get(worker_id, dict(EMPTY_STATS)),
        "poolIds": [pool["id"] for pool in pools if worker_id in pool.get("workerIds", [])],
        "blocked": bool(meta.get(worker_id, {}).get("blocked", False)),
        "note": meta.get(worker_id, {}).get("note", ""),
    } for worker_id in ids]


def find_worker(store: Store, id: str) -> dict:
    for worker in build_workers(store):
        if worker["WorkerId"] == id:
            return worker
    raise not_found("Worker", id)


def _threshold(pick: Callable[[dict], object], test: Callable[[float, float], bool]) -> Callable[[dict, object], bool]:
    """통계 값이 없는(null) worker 는 조건을 만족하지 않는 것으로 본다. "조건으로 채우기" 가 보수적으로 동작한다."""
    def matches(worker: dict, value: object) -> bool:
        actual = pick(worker)
        return actual is not None and test(actual, js_number_of(value))
    return matches


WORKER_FILTERS = {
    "search": lambda worker, value: js_string(value).lower() in worker["WorkerId"].lower(),
    "poolId": lambda worker, value: js_string(value) in worker["poolIds"],
    "notInPool": lambda worker, value: js_string(value) not in worker["poolIds"],
    "minApproved": _threshold(lambda w: w["stats"]["approved"], lambda actual, limit: actual >= limit),
    "maxRejectRate": _threshold(lambda w: w["stats"]["rejectRate"], lambda actual, limit: actual <= limit),
    "maxAttentionFailRate": _threshold(lambda w: w["stats"]["attentionFailRate"], lambda actual, limit: actual <= limit),
    "minAgreement": _threshold(lambda w: w["stats"]["majorityAgreement"], lambda actual, limit: actual >= limit),
}


async def list_workers(request: Request) -> dict:
    query = list_query_of(request)
    with db_of(request).transaction() as store:
        workers = build_workers(store)
    return apply_list_query(workers, query, WORKER_FILTERS)


async def get_worker(request: Request, id: str) -> dict:
    """WorkerDetail: Worker + blockReason(있을 때만) + batch 별 이력 + 최근 제출부터의 assignment 요약."""
    with db_of(request).transaction() as store:
        worker = find_worker(store, id)
        meta = store.worker_meta(id) or {}
        names = store.batch_names()
        own = store.assignments_of_worker(id)
    own.sort(key=lambda entry: locale_key(js_string(entry[0].get("SubmitTime", ""))), reverse=True)
    detail = dict(worker)
    if "blockReason" in meta:
        detail["blockReason"] = meta["blockReason"]

    per_batch: dict[str, list[dict]] = {}
    for assignment, batch_id, _ in own:
        per_batch.setdefault(batch_id, []).append(assignment)
    detail["batches"] = []
    for batch_id, assignments in per_batch.items():
        counts = count_by_status(a.get("AssignmentStatus", "") for a in assignments)
        detail["batches"].append({"batchId": batch_id, "batchName": names.get(batch_id, batch_id), "total": len(assignments),
                                  "approved": counts.approved, "rejected": counts.rejected, "pending": counts.submitted})
    detail["assignments"] = []
    for assignment, batch_id, row_index in own:
        summary = {
            "AssignmentId": assignment["AssignmentId"], "HITId": assignment["HITId"], "batchId": batch_id, "rowIndex": row_index,
            "AssignmentStatus": assignment.get("AssignmentStatus"), "SubmitTime": assignment.get("SubmitTime"),
            "workTimeInSeconds": assignment.get("workTimeInSeconds"), "attention": assignment.get("attention"),
        }
        if "RequesterFeedback" in assignment:
            summary["RequesterFeedback"] = assignment["RequesterFeedback"]
        detail["assignments"].append(summary)
    return detail


def _meta_of(store: Store, worker_id: str) -> dict:
    return store.worker_meta(worker_id) or {"blocked": False, "note": ""}


async def update_worker_note(request: Request, id: str) -> dict:
    body = await read_body(request)
    note = body_field(body, "note")
    if not isinstance(note, str):
        raise invalid('"note" must be a string.')
    with db_of(request).transaction(write=True) as store:
        worker = find_worker(store, id)
        meta = _meta_of(store, id)
        meta["note"] = note
        store.set_worker_meta(id, meta)
    return {**worker, "note": note}


# ---- Pools ----------------------------------------------------------------------------------


async def create_pool(request: Request) -> dict:
    body = await read_body(request)
    object_body(body, "pool")
    name = body.get("name").strip() if isinstance(body.get("name"), str) else ""
    if not name:
        raise invalid("Pool name is required.")
    description = body.get("description").strip() if isinstance(body.get("description"), str) else ""
    with db_of(request).transaction(write=True) as store:
        pools = store.list_pools()
        if any(pool["name"].lower() == name.lower() for pool in pools):
            raise invalid(f'A pool named "{name}" already exists.')
        pool = {"id": unique_slug_id("pool", slug(name) or "pool", {p["id"] for p in pools}), "name": name,
                "description": description, "workerIds": []}
        store.insert_pool(pool)
        return pool


async def add_workers_to_pool(request: Request, poolId: str) -> dict:
    body = await read_body(request)
    worker_ids = body_field(body, "workerIds")
    with db_of(request).transaction(write=True) as store:
        pool = find_pool(store, poolId)
        string_array(worker_ids, "workerIds")
        if len(worker_ids) == 0:
            raise invalid("No workers selected.")
        pool["workerIds"] = list(dict.fromkeys([*pool.get("workerIds", []), *worker_ids]))
        store.update_pool(pool)
        return pool


async def remove_workers_from_pool(request: Request, poolId: str) -> dict:
    body = await read_body(request)
    worker_ids = body_field(body, "workerIds")
    with db_of(request).transaction(write=True) as store:
        pool = find_pool(store, poolId)
        remove = set(string_array(worker_ids, "workerIds"))
        pool["workerIds"] = [id for id in pool.get("workerIds", []) if id not in remove]
        store.update_pool(pool)
        return pool


# ---- Block ----------------------------------------------------------------------------------


async def block_workers(request: Request) -> Response:
    body = await read_body(request)
    ids, reason = body_field(body, "ids"), body_field(body, "reason")
    string_array(ids, "ids")
    if len(ids) == 0:
        raise invalid("No workers selected.")
    if not isinstance(reason, str) or not reason.strip():
        raise invalid("A reason is required to block a worker. MTurk records it.")
    with db_of(request).transaction(write=True) as store:
        for id in ids:
            meta = _meta_of(store, id)
            meta["blocked"] = True
            meta["blockReason"] = reason.strip()
            store.set_worker_meta(id, meta)
    return no_content()


async def unblock_workers(request: Request) -> Response:
    body = await read_body(request)
    ids = string_array(body_field(body, "ids"), "ids")
    with db_of(request).transaction(write=True) as store:
        for id in ids:
            meta = _meta_of(store, id)
            meta["blocked"] = False
            meta.pop("blockReason", None)
            store.set_worker_meta(id, meta)
    return no_content()


IMPLEMENTED: dict[str, Callable] = {
    "listWorkers": list_workers,
    "getWorker": get_worker,
    "updateWorkerNote": update_worker_note,
    "createPool": create_pool,
    "addWorkersToPool": add_workers_to_pool,
    "removeWorkersFromPool": remove_workers_from_pool,
    "blockWorkers": block_workers,
    "unblockWorkers": unblock_workers,
}
