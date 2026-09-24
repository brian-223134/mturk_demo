"""Manage 와 Review 화면의 REST: HIT 목록과 상세, assignment 목록, 승인과 반려, 재모집, 만료, 결과(majority, Fleiss' κ), export.
prototype/src/api/mock/handlers.ts 의 listHits … exportBatch 와 같은 검증, 같은 상태 변화, 같은 잔액 계산이다.

잔액 (MTurk 의 동작): 반려하면 그 assignment 의 값(reward + 수수료)을 돌려받고, 반려를 번복해 승인하면 다시 내며(30일 이내만),
재모집으로 자리를 늘리면 늘린 만큼 미리 낸다. 잔액이 모자라면 상태를 바꾸기 전에 400 으로 막는다.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Callable

from fastapi import Request, Response

from app.db import Store
from app.domain.agreement import Vote, collect_items, summarize_results
from app.domain.attention import is_attention_name
from app.domain.export_formats import build_labels_json, build_mturk_csv
from app.domain.js import is_js_integer, js_len, js_number_of, js_slice, js_string, js_truthy, locale_key, slug
from app.domain.list_query import apply_list_query
from app.domain.progress import AssignmentCounts, count_by_status, hit_progress, is_expired, parse_time, plan_top_up
from app.domain.reference import agreement_with_reference, majority_reference, map_reference_to_answers, parse_reference_cell
from app.errors import invalid, not_found
from app.routers.common import (adjust_balance, after_seconds, attention_prefix_of, body_field, db_of, ensure_balance, find_batch,
                                hit_unit_cost, iso, list_query_of, no_content, now, read_body, string_array, sync_hit)

REJECTION_OVERRIDE_DAYS = 30   # MTurk: 반려 번복은 30일 이내
INPUT_PREVIEW_CHARS = 200


def _progress_json(max_assignments: int, counts: AssignmentCounts, target: int) -> dict:
    progress = hit_progress(max_assignments, counts, target)
    return {"submitted": progress.submitted, "approved": progress.approved, "rejected": progress.rejected,
            "open": progress.open, "completed": progress.completed, "shortfall": progress.shortfall}


def _find_assignments(store: Store, ids: object) -> list[dict]:
    """ids 순서대로 assignment 문서. 같은 id 가 두 번 오면 같은 문서가 두 번 들어간다 (프로토타입과 같다)."""
    string_array(ids, "ids")
    if len(ids) == 0:
        raise invalid("No assignments selected.")
    found = store.get_assignments(ids)
    targets = []
    for id in ids:
        if id not in found:
            raise not_found("Assignment", id)
        targets.append(found[id])
    return targets


def _resync_hits(store: Store, hit_ids: list[str], at) -> None:
    by_hit = store.assignments_of_hits(hit_ids)
    for hit_id in dict.fromkeys(hit_ids):
        hit = store.get_hit(hit_id)
        if hit is not None:
            sync_hit(hit, by_hit.get(hit_id, []), at)
            store.update_hit(hit)


def _approved_votes(store: Store, batch: dict) -> list[Vote]:
    """Approved 응답의 일반 문항(attention 제외) 표. 저장 순서."""
    row_index_of = {hit.id: hit.row_index for hit in store.hits_of_batch(batch["id"])}
    prefix = attention_prefix_of(batch)
    votes: list[Vote] = []
    for assignment in store.assignments_of_batch(batch["id"]):
        if assignment.get("AssignmentStatus") != "Approved":
            continue
        for answer in assignment.get("answers", []):
            if is_attention_name(str(answer.get("name", "")), prefix):
                continue
            votes.append(Vote(row_index_of[assignment["HITId"]], answer["name"], answer["value"], assignment["WorkerId"]))
    return votes


# ---- HITs -----------------------------------------------------------------------------------


async def list_hits(request: Request, batchId: str) -> dict:
    """HitListItem 목록. 입력 셀은 200자로 잘라 inputPreview 로 보낸다 (전체는 getHit)."""
    query = list_query_of(request)
    with db_of(request).transaction() as store:
        batch = find_batch(store, batchId)
        counts = store.assignment_counts_of_batch(batchId)
        target = batch["settings"]["MaxAssignments"]
        at = now()
        items = []
        for hit in store.hit_docs_of_batch(batchId):
            item = {key: value for key, value in hit.items() if key != "input"}
            item["inputPreview"] = {
                column: f"{js_slice(cell, INPUT_PREVIEW_CHARS)}…" if isinstance(cell, str) and js_len(cell) > INPUT_PREVIEW_CHARS else cell
                for column, cell in (hit.get("input") or {}).items()}
            item["progress"] = _progress_json(hit["MaxAssignments"], counts.get(hit["HITId"], AssignmentCounts()), target)
            item["expired"] = is_expired(hit["Expiration"], at)
            items.append(item)
    return apply_list_query(items, query, {"incomplete": lambda hit, value: not js_truthy(value) or not hit["progress"]["completed"]})


async def get_hit(request: Request, hitId: str) -> dict:
    hit = db_of(request).get_hit(hitId)
    if hit is None:
        raise not_found("HIT", hitId)
    return hit


# ---- Assignments ----------------------------------------------------------------------------


def _cell_text(cell: object) -> str:
    """hit.input[column] ?? '' (셀이 문자열이 아니면 String())."""
    return "" if cell is None else js_string(cell)


def _attention_filter(assignment: dict, value: object) -> bool:
    attention = assignment.get("attention")
    if value == "pass":
        return isinstance(attention, dict) and attention.get("passed") is True
    if value == "fail":
        return isinstance(attention, dict) and attention.get("passed") is False
    return attention is None


def _max_work_time_filter(assignment: dict, value: object) -> bool:
    limit = js_number_of(value)
    return assignment.get("workTimeInSeconds", 0) < limit


def _worker_search_filter(assignment: dict, value: object) -> bool:
    return js_string(value).lower() in assignment.get("WorkerId", "").lower()


async def list_assignments(request: Request, batchId: str) -> dict:
    """AssignmentListItem 목록: rowIndex, reference(문항 → 대조 기준 값), agreement(일반 문항의 일치율)."""
    query = list_query_of(request)
    with db_of(request).transaction() as store:
        batch = find_batch(store, batchId)
        prefix = attention_prefix_of(batch)
        reference = batch.get("reference") or {}
        column = reference.get("column") if reference.get("source") == "column" else None
        hits = store.hit_docs_of_batch(batchId) if column is not None else None
        if hits is not None:
            row_index_of = {hit["HITId"]: hit["rowIndex"] for hit in hits}
            cell_of = {hit["HITId"]: parse_reference_cell(_cell_text((hit.get("input") or {}).get(column))) for hit in hits}
        else:
            row_index_of = {hit.id: hit.row_index for hit in store.hits_of_batch(batchId)}
            cell_of = {}
        in_batch = store.assignments_of_batch(batchId)
    by_hit: dict[str, list[dict]] = {}
    for assignment in in_batch:
        by_hit.setdefault(assignment["HITId"], []).append(assignment)
    rule = batch.get("attentionRule")

    def reference_of(assignment: dict) -> dict[str, str]:
        answers = assignment.get("answers", [])
        if column is not None:
            values = map_reference_to_answers(cell_of[assignment["HITId"]], answers, prefix)
        else:
            # 비교 기준에는 반려된 응답을 넣지 않는다 (worker 지표와 같은 기준)
            values = majority_reference([
                other.get("answers", []) for other in by_hit.get(assignment["HITId"], [])
                if other["AssignmentId"] != assignment["AssignmentId"] and other.get("AssignmentStatus") != "Rejected"])
        if rule:   # attention 문항의 기준은 batch 에 적은 정답이다
            for answer in answers:
                if is_attention_name(str(answer.get("name", "")), prefix):
                    values[answer["name"]] = rule.get("expectedValue")
        return values

    items = []
    for assignment in in_batch:
        reference_values = reference_of(assignment)
        items.append({**assignment, "rowIndex": row_index_of[assignment["HITId"]], "reference": reference_values,
                      "agreement": agreement_with_reference(assignment.get("answers", []), reference_values, prefix)})
    # 기본 순서. 같은 HIT 의 응답이 붙어 나오고, 정렬은 안정적이라 한 필드로 정렬해도 이 순서가 tiebreak 가 된다
    items.sort(key=lambda a: (a["rowIndex"], locale_key(js_string(a["WorkerId"])), locale_key(js_string(a["SubmitTime"]))))
    return apply_list_query(items, query, {
        "attention": _attention_filter, "maxWorkTime": _max_work_time_filter, "workerSearch": _worker_search_filter})


async def approve_assignments(request: Request) -> list[dict]:
    """승인. 반려된 응답은 override 가 있고 30일 이내일 때만 되돌리며, 반려 때 돌려받은 금액을 다시 낸다."""
    body = await read_body(request)
    ids, feedback, override = body_field(body, "ids"), body_field(body, "feedback"), body_field(body, "override")
    with db_of(request).transaction(write=True) as store:
        targets = _find_assignments(store, ids)
        at = now()
        reapproval_cents = 0
        batches: dict[str, dict] = {}
        for assignment in targets:
            status = assignment.get("AssignmentStatus")
            if status == "Approved":
                raise invalid(f"Assignment {assignment['AssignmentId']} is already approved.")
            if status == "Rejected":
                if not js_truthy(override):
                    raise invalid(f"Assignment {assignment['AssignmentId']} was rejected. Use \"Revert to approved\" to override.")
                rejected_at = parse_time(assignment.get("RejectionTime") or assignment.get("SubmitTime"))
                if rejected_at is not None and at - rejected_at > timedelta(days=REJECTION_OVERRIDE_DAYS):
                    raise invalid(f"Assignment {assignment['AssignmentId']} was rejected more than {REJECTION_OVERRIDE_DAYS} days ago. "
                                  "MTurk no longer allows overriding it.")
                hit = store.get_hit(assignment["HITId"])
                batch = batches.get(hit["batchId"]) or batches.setdefault(hit["batchId"], find_batch(store, hit["batchId"]))
                reapproval_cents += hit_unit_cost(batch, hit["MaxAssignments"])
        ensure_balance(store, reapproval_cents)   # 반려할 때 돌려받은 금액을 다시 낸다

        for assignment in targets:
            assignment["AssignmentStatus"] = "Approved"
            assignment["ApprovalTime"] = iso(at)
            assignment.pop("RejectionTime", None)
            if isinstance(feedback, str) and feedback.strip():
                assignment["RequesterFeedback"] = feedback.strip()
            else:
                assignment.pop("RequesterFeedback", None)
        for assignment in {a["AssignmentId"]: a for a in targets}.values():
            store.update_assignment(assignment)
        adjust_balance(store, -reapproval_cents)
        _resync_hits(store, [a["HITId"] for a in targets], at)
        return targets


async def reject_assignments(request: Request) -> list[dict]:
    """반려. 사유가 필수이고 Submitted 만 반려할 수 있다. 그 assignment 의 값을 잔액에 돌려준다."""
    body = await read_body(request)
    ids, feedback = body_field(body, "ids"), body_field(body, "feedback")
    reason = feedback.strip() if isinstance(feedback, str) else ""
    if not reason:
        raise invalid("Feedback is required when rejecting. Workers see it as the reason.")
    with db_of(request).transaction(write=True) as store:
        targets = _find_assignments(store, ids)
        for assignment in targets:
            if assignment.get("AssignmentStatus") != "Submitted":
                raise invalid(f"Assignment {assignment['AssignmentId']} is {assignment.get('AssignmentStatus')}. "
                              "Only submitted assignments can be rejected.")
        at = now()
        refund_cents = 0
        batches: dict[str, dict] = {}
        for assignment in targets:
            assignment["AssignmentStatus"] = "Rejected"
            assignment["RejectionTime"] = iso(at)
            assignment["RequesterFeedback"] = reason
            hit = store.get_hit(assignment["HITId"])
            batch = batches.get(hit["batchId"]) or batches.setdefault(hit["batchId"], find_batch(store, hit["batchId"]))
            refund_cents += hit_unit_cost(batch, hit["MaxAssignments"])
        for assignment in {a["AssignmentId"]: a for a in targets}.values():
            store.update_assignment(assignment)
        adjust_balance(store, refund_cents)
        _resync_hits(store, [a["HITId"] for a in targets], at)
        return targets


async def add_assignments(request: Request) -> dict:
    """재모집. mode 는 추가할 수(정수 ≥ 1) 또는 'fill-to-target'(부족분만큼). 처음 10 미만으로 만든 HIT 는 합계 9 까지다.
    만료된 HIT 는 자리를 늘려도 worker 에게 보이지 않으므로 게시 기간만큼 연장한다."""
    body = await read_body(request)
    hit_ids, mode = body_field(body, "hitIds"), body_field(body, "mode")
    string_array(hit_ids, "hitIds")
    if len(hit_ids) == 0:
        raise invalid("No HITs selected.")
    if mode != "fill-to-target" and (not is_js_integer(mode) or mode < 1):
        raise invalid("The number of assignments to add must be an integer ≥ 1.")
    if mode != "fill-to-target":
        mode = int(mode)

    with db_of(request).transaction(write=True) as store:
        at = now()
        hits: dict[str, dict] = {}
        batches: dict[str, dict] = {}
        by_hit = store.assignments_of_hits(hit_ids)
        plans = []
        for hit_id in hit_ids:
            hit = hits.get(hit_id) or store.get_hit(hit_id)
            if hit is None:
                raise not_found("HIT", hit_id)
            hits[hit_id] = hit
            batch = batches.get(hit["batchId"]) or batches.setdefault(hit["batchId"], find_batch(store, hit["batchId"]))
            progress = hit_progress(hit["MaxAssignments"], count_by_status(a.get("AssignmentStatus", "") for a in by_hit.get(hit_id, [])),
                                    batch["settings"]["MaxAssignments"])
            plan = plan_top_up(hit["MaxAssignments"], hit["initialMaxAssignments"], progress.shortfall, mode)
            # 부족분은 없지만 만료되어 막힌 HIT: 남은 자리가 worker 에게 보이지 않아 영영 완료되지 않는다. 게시 기간만 연장한다.
            reopen_only = (mode == "fill-to-target" and plan.add == 0 and is_expired(hit["Expiration"], at)
                           and not progress.completed and progress.open > 0)
            plans.append((hit, batch, plan, reopen_only))
        ensure_balance(store, sum(plan.add * hit_unit_cost(batch, hit["MaxAssignments"]) for hit, batch, plan, _ in plans))

        result: dict = {"added": [], "skipped": []}
        for hit, batch, plan, reopen_only in plans:
            if plan.add == 0 and not reopen_only:
                result["skipped"].append({"HITId": hit["HITId"], "reason": plan.reason or "Nothing to add."})
                continue
            adjust_balance(store, -plan.add * hit_unit_cost(batch, hit["MaxAssignments"]))
            hit["MaxAssignments"] += plan.add
            expiration_extended = is_expired(hit["Expiration"], at)
            if expiration_extended:
                hit["Expiration"] = iso(after_seconds(at, batch["settings"]["LifetimeInSeconds"]))
            sync_hit(hit, by_hit.get(hit["HITId"], []), at)
            store.update_hit(hit)
            result["added"].append({"HITId": hit["HITId"], "count": plan.add, "expirationExtended": expiration_extended})
        return result


# ---- Batch ----------------------------------------------------------------------------------


async def expire_batch(request: Request, id: str) -> Response:
    """"지금 만료": 살아 있는 HIT 의 만료 시각을 지금으로 당기고 MTurk 필드를 맞춘다."""
    with db_of(request).transaction(write=True) as store:
        find_batch(store, id)
        at = now()
        hits = store.hit_docs_of_batch(id)
        by_hit = store.assignments_of_hits([hit["HITId"] for hit in hits])
        for hit in hits:
            if not is_expired(hit["Expiration"], at):
                hit["Expiration"] = iso(at)
            sync_hit(hit, by_hit.get(hit["HITId"], []), at)
            store.update_hit(hit)
    return no_content()


# ---- Results and export -----------------------------------------------------------------------


async def get_results(request: Request, batchId: str) -> dict:
    """BatchResults: Approved 응답의 일반 문항만 세고, κ 와 만장일치 비율은 투표 수가 target 인 문항만으로 계산한다."""
    with db_of(request).transaction() as store:
        batch = find_batch(store, batchId)
        items = collect_items(_approved_votes(store, batch))
    target = batch["settings"]["MaxAssignments"]
    return {"target": target, "items": [item.to_json() for item in items], **summarize_results(items, target)}


async def export_batch(request: Request, batchId: str) -> dict:
    """ExportFile {filename, mimeType, content}. format 은 mturk-csv 또는 labels-json."""
    export_format = request.query_params.get("format")
    with db_of(request).transaction() as store:
        batch = find_batch(store, batchId)
        base = slug(batch["name"]) or batch["id"]
        if export_format == "mturk-csv":
            hits = store.hit_docs_of_batch(batchId)
            return {"filename": f"{base}-results.csv", "mimeType": "text/csv;charset=utf-8",
                    "content": build_mturk_csv(batch, hits, store.assignments_of_batch(batchId))}
        if export_format == "labels-json":
            return {"filename": f"{base}-labels.json", "mimeType": "application/json",
                    "content": build_labels_json(collect_items(_approved_votes(store, batch)))}
    raise invalid(f"Unknown export format: {'undefined' if export_format is None else export_format}")


IMPLEMENTED: dict[str, Callable] = {
    "expireBatch": expire_batch,
    "listHits": list_hits,
    "getHit": get_hit,
    "listAssignments": list_assignments,
    "approveAssignments": approve_assignments,
    "rejectAssignments": reject_assignments,
    "addAssignments": add_assignments,
    "getResults": get_results,
    "exportBatch": export_batch,
}
