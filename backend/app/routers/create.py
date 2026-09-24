"""Create 화면의 REST: 템플릿 저장과 삭제, batch 게시, pool 목록. prototype/src/api/mock/handlers.ts 의 saveTemplate,
deleteTemplate, createBatch, listPools 와 같은 검증(같은 문구, 같은 순서)과 같은 결과다.

게시할 때 서버가 다시 검사하는 것 (docs/creating-a-batch.md): 템플릿이 요구하는 컬럼, Title, MaxAssignments, 기간, 자동 승인 30일
상한, 최소 보상, pool 이 실제로 있는지, 대조 기준 컬럼이 CSV 에 있는지, 잔액. 검증이 끝나면 행마다 HIT 를 만들고(게시 시점의
templateHtml 사본, answerSchema, inputColumns, initialMaxAssignments), 견적 총액을 잔액에서 미리 뺀다.
"""

from __future__ import annotations

import json
from typing import Any, Callable

from fastapi import Request, Response

from app.domain.cost import estimate_cost, reward_to_cents, uses_masters
from app.domain.js import is_finite_number, is_js_integer, slug
from app.domain.template import extract_placeholders
from app.errors import invalid, not_found
from app.routers.common import (adjust_balance, after_seconds, batch_id, db_of, ensure_balance, find_pool, iso,
                                js_repr, mturk_like_id, no_content, now, object_body, read_body, string_array, trimmed_string,
                                unique_slug_id)

MAX_AUTO_APPROVAL_SECONDS = 30 * 24 * 3600
DURATION_FIELDS = ("AssignmentDurationInSeconds", "LifetimeInSeconds", "AutoApprovalDelayInSeconds")


# ---- Templates ------------------------------------------------------------------------------


async def save_template(request: Request) -> dict:
    """새 템플릿(id 없음)이나 기존 템플릿(id)을 저장한다. placeholders 와 updatedAt 은 여기서 계산한다."""
    body = await read_body(request)
    object_body(body, "template")
    name, html = body.get("name"), body.get("html")
    if not isinstance(name, str) or not isinstance(html, str):
        raise invalid('"name" and "html" must be strings.')
    name = name.strip()
    if not name:
        raise invalid("Template name is required.")
    if not html.strip():
        raise invalid("Template HTML is empty.")
    fields = {"name": name, "html": html, "placeholders": extract_placeholders(html), "updatedAt": iso(now())}

    with db_of(request).transaction(write=True) as store:
        id = body.get("id")
        if id:
            existing = store.get_template(id)
            if existing is None:
                raise not_found("Template", js_repr(id))
            existing.update(fields)
            store.update_template(existing)
            return existing
        created = {"id": unique_slug_id("tpl", slug(name) or "template", store.template_ids()), **fields}
        store.insert_template(created)
        return created


async def delete_template(request: Request, id: str) -> Response:
    """게시된 batch 는 templateHtml 사본을 갖고 있으므로 영향받지 않는다."""
    with db_of(request).transaction(write=True) as store:
        if not store.delete_template(id):
            raise not_found("Template", id)
    return no_content()


# ---- Batches --------------------------------------------------------------------------------


def review_reference(value: Any, input_columns: list[str]) -> dict:
    """Review 의 대조 기준. 없으면 majority. column 은 입력 컬럼에 있어야 한다."""
    if value is None:
        return {"source": "majority"}
    object_body(value, "reference")
    source, column = value.get("source"), value.get("column")
    if source == "majority":
        return {"source": "majority"}
    if source != "column":
        raise invalid('"reference.source" must be "majority" or "column".')
    if not isinstance(column, str) or not column:
        raise invalid('"reference.column" must be a column name.')
    if column not in input_columns:
        raise invalid(f'Reference column "{column}" is not one of the CSV columns.')
    return {"source": "column", "column": column}


def _qualification_type_ids(requirements: Any) -> list[str]:
    """settings.QualificationRequirements?.map((r) => r?.QualificationTypeId) 가 문자열 배열인지."""
    if requirements is None:
        mapped: Any = None
    elif isinstance(requirements, list):
        mapped = [r.get("QualificationTypeId") if isinstance(r, dict) else None for r in requirements]
    else:
        mapped = None
    return string_array(mapped, "QualificationRequirements[].QualificationTypeId")


async def create_batch(request: Request) -> dict:
    body = await read_body(request)
    object_body(body, "batch")
    settings = object_body(body.get("settings"), "settings")
    input_columns = string_array(body.get("inputColumns"), "inputColumns")
    required_pool_ids = string_array(body.get("requiredPoolIds"), "requiredPoolIds")
    excluded_pool_ids = string_array(body.get("excludedPoolIds"), "excludedPoolIds")
    reference = review_reference(body.get("reference"), input_columns)
    _qualification_type_ids(settings.get("QualificationRequirements"))
    name = trimmed_string(body.get("name"))
    if not name:
        raise invalid("Batch name is required.")

    with db_of(request).transaction(write=True) as store:
        template_id = body.get("templateId")
        template = store.get_template(template_id) if isinstance(template_id, str) else None
        if template is None:
            raise not_found("Template", js_repr(template_id) if "templateId" in body else "undefined")
        rows = body.get("rows")
        if not isinstance(rows, list) or len(rows) == 0:
            raise invalid("The CSV has no rows.")
        if any(not isinstance(row, (dict, list)) for row in rows):
            raise invalid('"rows" must be an array of objects.')

        missing = [p for p in template["placeholders"] if p not in input_columns]
        if missing:
            raise invalid("The CSV is missing columns used by the template: " + ", ".join(f"${{{m}}}" for m in missing))
        if not trimmed_string(settings.get("Title")):
            raise invalid("Title is required.")
        max_assignments = settings.get("MaxAssignments")
        if not is_js_integer(max_assignments) or max_assignments < 1:
            raise invalid("MaxAssignments must be an integer ≥ 1.")
        for field in DURATION_FIELDS:
            value = settings.get(field)
            if not is_finite_number(value) or value <= 0:
                raise invalid(f"{field} must be greater than 0.")
        if settings["AutoApprovalDelayInSeconds"] > MAX_AUTO_APPROVAL_SECONDS:
            raise invalid("AutoApprovalDelayInSeconds cannot exceed 30 days.")
        try:
            reward_cents = reward_to_cents(settings.get("Reward"))
        except ValueError:
            shown = json.dumps(settings["Reward"], ensure_ascii=False) if "Reward" in settings else "undefined"
            raise invalid(f"Reward is not a valid amount: {shown}") from None
        if reward_cents < 1:
            raise invalid("Reward must be at least $0.01.")
        for pool_id in [*required_pool_ids, *excluded_pool_ids]:
            find_pool(store, pool_id)

        masters = uses_masters(settings.get("QualificationRequirements", []))
        estimate = estimate_cost(len(rows), int(max_assignments), settings["Reward"], masters)
        ensure_balance(store, estimate["totalCents"])

        # 검증 끝. 여기부터 상태를 바꾼다.
        created_at = now()
        taken = store.batch_ids()
        id = batch_id()
        while id in taken:
            id = batch_id()
        max_assignments = int(max_assignments)
        batch = {
            "id": id,
            "name": name,
            "env": store.account().get("env"),
            "templateId": template["id"],
            "templateHtml": template["html"],
            "inputColumns": list(input_columns),
            "settings": {**settings, "Reward": f"{reward_cents / 100:.2f}"},
            "attentionRule": body.get("attentionRule"),
            "reference": reference,
            "requiredPoolIds": list(required_pool_ids),
            "excludedPoolIds": list(excluded_pool_ids),
            "createdAt": iso(created_at),
        }
        answer_schema = body.get("answerSchema")
        if isinstance(answer_schema, list) and answer_schema:
            batch["answerSchema"] = answer_schema
        expiration = iso(after_seconds(created_at, settings["LifetimeInSeconds"]))
        hits = []
        for row_index, row in enumerate(rows):
            cells = row if isinstance(row, dict) else {}
            hits.append({
                "HITId": mturk_like_id(),
                "HITStatus": "Assignable",
                "MaxAssignments": max_assignments,
                "NumberOfAssignmentsPending": 0,
                "NumberOfAssignmentsAvailable": max_assignments,
                "NumberOfAssignmentsCompleted": 0,
                "CreationTime": iso(created_at),
                "Expiration": expiration,
                "batchId": id,
                "rowIndex": row_index,
                "input": {c: (cells.get(c) if cells.get(c) is not None else "") for c in input_columns},
                "initialMaxAssignments": max_assignments,
            })
        store.insert_batch(batch)
        store.insert_hits(hits)
        adjust_balance(store, -estimate["totalCents"])
        return batch


# ---- Pools ----------------------------------------------------------------------------------


async def list_pools(request: Request) -> list[dict]:
    return db_of(request).list_pools()


IMPLEMENTED: dict[str, Callable] = {
    "saveTemplate": save_template,
    "deleteTemplate": delete_template,
    "createBatch": create_batch,
    "listPools": list_pools,
}
