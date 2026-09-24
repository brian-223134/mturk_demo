"""콘솔 REST. 경로 표(app/routes.py)의 모든 경로를 등록한다.

이번 단계에서 실제로 동작하는 것: health, listTemplates, getTemplate, listBatches, getBatch, getAccount.
나머지는 501 NOT_IMPLEMENTED 봉투를 돌려주는 stub 이라, 화면이 "아직 없는 기능"을 알아볼 수 있다.

batch 요약(BatchSummary, BatchDetail)은 prototype/src/api/mock/handlers.ts 의 summarizeBatch 와 같은 계산이다:
HIT 별 진행률(app/domain/progress.py) → batch 상태, needsReview, 진행률 합계, 비용(app/domain/cost.py).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Callable

from fastapi import APIRouter, Request

from app.db import Database
from app.domain.cost import batch_cost, uses_masters
from app.domain.progress import AssignmentCounts, HitProgress, batch_status, hit_progress, is_expired, summarize_progress
from app.errors import ApiError, not_found
from app.routes import API_PREFIX, API_ROUTES, RouteDef, fastapi_path


def summarize_batch(db: Database, batch: dict, now: datetime) -> dict:
    """BatchDetail: {batch, status, needsReview, progress, cost}. 목록에서는 호출한 쪽이 templateHtml 을 뺀다."""
    settings = batch["settings"]
    target = settings["MaxAssignments"]
    counts = db.assignment_counts_of_batch(batch["id"])
    per_hit: list[tuple[int, bool, HitProgress]] = []
    for hit in db.hits_of_batch(batch["id"]):
        progress = hit_progress(hit.max_assignments, counts.get(hit.id, AssignmentCounts()), target)
        per_hit.append((hit.max_assignments, is_expired(hit.expiration, now), progress))
    progress_total = summarize_progress([p for _, _, p in per_hit])
    return {
        "batch": batch,
        "status": batch_status((p.completed, expired) for _, expired, p in per_hit),
        "needsReview": progress_total["submitted"] > 0,
        "progress": progress_total,
        "cost": batch_cost(
            [{"MaxAssignments": max_assignments, "approved": p.approved, "rejected": p.rejected} for max_assignments, _, p in per_hit],
            settings["Reward"],
            uses_masters(settings.get("QualificationRequirements", [])),
        ),
    }


def _db(request: Request) -> Database:
    return request.app.state.db


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ---- 구현된 핸들러 -------------------------------------------------------------------------


async def health(request: Request) -> dict:
    db = _db(request)
    return {"status": "ok", "source": db.source, "counts": db.counts()}


async def list_templates(request: Request) -> list[dict]:
    return _db(request).list_templates()


async def get_template(request: Request, id: str) -> dict:
    template = _db(request).get_template(id)
    if template is None:
        raise not_found("Template", id)
    return template


async def list_batches(request: Request) -> list[dict]:
    db = _db(request)
    now = _now()
    summaries = []
    for batch in db.list_batches():
        summary = summarize_batch(db, batch, now)
        summary["batch"] = {key: value for key, value in batch.items() if key != "templateHtml"}
        summaries.append(summary)
    summaries.sort(key=lambda s: s["batch"]["createdAt"], reverse=True)
    return summaries


async def get_batch(request: Request, id: str) -> dict:
    db = _db(request)
    batch = db.get_batch(id)
    if batch is None:
        raise not_found("Batch", id)
    return summarize_batch(db, batch, _now())


async def get_account(request: Request) -> dict:
    return _db(request).account()


IMPLEMENTED: dict[str, Callable] = {
    "listTemplates": list_templates,
    "getTemplate": get_template,
    "listBatches": list_batches,
    "getBatch": get_batch,
    "getAccount": get_account,
}


def make_stub(name: str, route: RouteDef) -> Callable:
    async def not_implemented(request: Request) -> None:
        raise ApiError("NOT_IMPLEMENTED", f"{name} ({route.method} {API_PREFIX}{route.path}) is not implemented yet.")

    not_implemented.__name__ = f"stub_{name}"
    return not_implemented


def build_console_router() -> APIRouter:
    router = APIRouter()
    router.add_api_route("/health", health, methods=["GET"], name="health", operation_id="health")
    for name, route in API_ROUTES.items():
        endpoint = IMPLEMENTED.get(name) or make_stub(name, route)
        router.add_api_route(fastapi_path(route.path), endpoint, methods=[route.method], name=name, operation_id=name)
    return router
