"""콘솔 REST 핸들러가 함께 쓰는 것: 요청 읽기(JSON body, ListQuery), 프로토타입과 같은 검증 오류, 시각과 ID 만들기,
잔액 계산, HIT 의 MTurk 필드 동기화. prototype/src/api/mock/handlers.ts 의 위쪽 도우미들에 해당한다.

응답 규칙 (prototype/server/app.ts 와 같다): 핸들러가 값을 돌려주면 200 JSON, 없으면(None) 204 로 본문 없이 보낸다.
"""

from __future__ import annotations

import json
import random
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import Request, Response

from app.db import Database, Store
from app.domain.attention import DEFAULT_ATTENTION_PREFIX
from app.domain.cost import format_cents, js_round, parse_float, unit_cost_cents, uses_masters
from app.domain.js import js_string, to_fixed
from app.domain.list_query import parse_list_query
from app.domain.progress import count_by_status, is_expired
from app.errors import invalid, not_found

ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
_random = random.Random()


def db_of(request: Request) -> Database:
    return request.app.state.db


def now() -> datetime:
    """UTC, 밀리초 단위 (JS 의 Date 와 같은 정밀도)."""
    at = datetime.now(timezone.utc)
    return at.replace(microsecond=(at.microsecond // 1000) * 1000)


def iso(at: datetime) -> str:
    """Date.prototype.toISOString: YYYY-MM-DDTHH:mm:ss.sssZ."""
    return at.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def after_seconds(at: datetime, seconds: float) -> datetime:
    """at + seconds (밀리초 단위로 내림. JS 의 Date 는 정수 ms 다)."""
    return at + timedelta(milliseconds=int(seconds * 1000))


def no_content() -> Response:
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


async def read_body(request: Request) -> Any:
    """JSON body. 비어 있으면 None (undefined), JSON 이 아니면 400."""
    raw = await request.body()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        raise invalid("Request body is not valid JSON.") from None


def body_field(body: Any, name: str) -> Any:
    """body?.[name] (body 가 객체가 아니면 undefined)."""
    return body.get(name) if isinstance(body, dict) else None


def list_query_of(request: Request) -> dict:
    return parse_list_query(request.query_params)


# ---- 프로토타입과 같은 형태 검증 ---------------------------------------------------------------


def string_array(value: Any, name: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(v, str) for v in value):
        raise invalid(f'"{name}" must be an array of strings.')
    return value


def object_body(value: Any, name: str) -> dict:
    if not isinstance(value, dict):
        raise invalid(f'"{name}" must be a JSON object.')
    return value


def trimmed_string(value: Any) -> str:
    """typeof value === 'string' ? value.trim() : ''."""
    return value.strip() if isinstance(value, str) else ""


def js_repr(value: Any) -> str:
    """오류 문구에 값을 적을 때 (`${value}`): String(value)."""
    return js_string(value)


# ---- ID -----------------------------------------------------------------------------------------


def mturk_like_id() -> str:
    """MTurk 의 HITId, AssignmentId 처럼 보이는 30자 ID ('3' + 29 자)."""
    return "3" + "".join(_random.choice(ID_CHARS) for _ in range(29))


def batch_id() -> str:
    return f"batch-{_random.randrange(1_000_000, 10_000_000)}"


def unique_slug_id(prefix: str, base: str, taken: set[str]) -> str:
    """`prefix-<base>`, 겹치면 `-2`, `-3`, … 을 붙인다."""
    id = f"{prefix}-{base}"
    n = 2
    while id in taken:
        id = f"{prefix}-{base}-{n}"
        n += 1
    return id


# ---- batch 와 HIT 의 공통 계산 ---------------------------------------------------------------


def attention_prefix_of(batch: dict | None) -> str:
    rule = (batch or {}).get("attentionRule") or {}
    prefix = rule.get("namePrefix")
    return prefix if isinstance(prefix, str) else DEFAULT_ATTENTION_PREFIX


def hit_unit_cost(batch: dict, hit_max_assignments: int) -> float | int:
    """assignment 1건의 값 (reward + 수수료)."""
    settings = batch["settings"]
    return unit_cost_cents(settings["Reward"], hit_max_assignments, uses_masters(settings.get("QualificationRequirements", [])))


def sync_hit(hit: dict, assignments: list[dict], at: datetime) -> None:
    """assignment 수에 맞춰 HIT 의 MTurk 필드를 다시 맞춘다 (handlers.ts 의 syncHit)."""
    counts = count_by_status(a.get("AssignmentStatus", "") for a in assignments)
    hit["NumberOfAssignmentsPending"] = 0
    hit["NumberOfAssignmentsCompleted"] = counts.approved + counts.rejected
    hit["NumberOfAssignmentsAvailable"] = max(0, hit["MaxAssignments"] - len(assignments))
    hit["HITStatus"] = "Reviewable" if is_expired(hit["Expiration"], at) or hit["NumberOfAssignmentsAvailable"] == 0 else "Assignable"


def find_batch(store: Store, id: str) -> dict:
    batch = store.get_batch(id)
    if batch is None:
        raise not_found("Batch", id)
    return batch


def find_pool(store: Store, id: str) -> dict:
    pool = store.get_pool(id)
    if pool is None:
        raise not_found("Pool", id)
    return pool


# ---- 잔액 ---------------------------------------------------------------------------------------
# MTurk 는 HIT 를 만들 때 비용을 미리 잡아 두고, 반려하면 돌려준다. 잔액이 모자라면 상태를 바꾸기 전에 막는다.


def balance_cents(account: dict) -> int:
    return js_round(parse_float(account.get("AvailableBalance", "0")) * 100)


def ensure_balance(store: Store, needed_cents: float) -> None:
    account = store.account()
    if needed_cents > balance_cents(account):
        raise invalid(f"Insufficient balance: this needs {format_cents(needed_cents)} but only "
                      f"${account.get('AvailableBalance')} is available.")


def adjust_balance(store: Store, delta_cents: float) -> None:
    account = store.account()
    account["AvailableBalance"] = to_fixed((balance_cents(account) + delta_cents) / 100, 2)
    store.set_account(account)
