"""유료 LLM 호출(OpenRouter)의 사용 기록과 admin 의 API usage 보고서.

    record_call(db, user_id, kind, result, model)   호출 하나를 api_usage 에 남긴다. 실패해도 호출 결과에는 영향을 주지 않는다
    usage_report(store, users, now)                 화면이 쓰는 보고서: 모든 기록의 합계(종류별, 사람별)와 최근 RECENT_DAYS 일의 줄들
    openrouter_balance(api_key)                     OpenRouter 의 크레딧 잔액과 키 한도 (조회는 비용이 들지 않는다)

콘솔이 직접 부르는 호출(binding, 자유 계약, 페이지, 배치 판정)은 api_usage 에, Generate from raw data 의 agent job 은
job 문서의 usage 에 있다. 보고서는 둘을 합친다. 비용은 OpenRouter 가 응답에 준 실제 청구액(USD)이며, 없으면 None 이다.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

log = logging.getLogger("backend")

KINDS = {"binding": "Binding", "contract": "Task (Describe your task)", "page": "Page layout", "layout-check": "Layout check", "job": "Generate from raw data"}
RECENT_DAYS = 31
OPENROUTER = "https://openrouter.ai/api/v1"
BALANCE_TIMEOUT = 10


def _int(value: object) -> int:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def _cost(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def record_call(db, user_id: str | None, kind: str, result: dict, model: dict | None) -> None:
    """Agent 의 답(usage, model)을 한 줄로 남긴다. 사용량이 없으면 남기지 않는다. DB 오류는 로그만 남긴다."""
    usage = result.get("usage") if isinstance(result, dict) else None
    if not isinstance(usage, dict):
        return
    row = {
        "user_id": user_id,
        "kind": kind,
        "model": (model or {}).get("model"),
        "provider": (model or {}).get("served_by"),
        "calls": _int(usage.get("calls")),
        "prompt_tokens": _int(usage.get("prompt_tokens")),
        "completion_tokens": _int(usage.get("completion_tokens")),
        "cost": _cost(usage.get("cost")),
    }
    try:
        with db.transaction(write=True) as store:
            store.insert_usage(row)
    except Exception as error:   # 기록을 못 해도 사용자의 호출은 이미 끝났다
        log.warning("could not record API usage (%s): %s", kind, error)


def _iso(value: object) -> str:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return str(value)


def _parse(value: str) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _entries(store) -> list[dict]:
    """두 출처를 같은 모양으로: {at(datetime), userId, kind, model, provider, calls, tokens, cost}."""
    entries = []
    for row in store.usage_rows():
        entries.append({"at": row["at"], "userId": row["user_id"], "kind": row["kind"], "model": row["model"], "provider": row["provider"],
                        "calls": row["calls"], "tokens": row["prompt_tokens"] + row["completion_tokens"], "cost": row["cost"]})
    for row in store.job_usage_rows():
        at = _parse(row["created_at"])
        usage = row["doc"].get("usage") or {}
        if at is None:
            continue
        entries.append({"at": at, "userId": row["owner_id"], "kind": "job", "model": (row["doc"].get("planner") or {}).get("model_config"), "provider": None,
                        "calls": _int(usage.get("calls")), "tokens": _int(usage.get("total_tokens")) or _int(usage.get("prompt_tokens")) + _int(usage.get("completion_tokens")),
                        "cost": _cost(usage.get("cost"))})
    entries.sort(key=lambda entry: entry["at"])
    return entries


def _total(entries: list[dict]) -> dict:
    costs = [entry["cost"] for entry in entries if entry["cost"] is not None]
    return {"calls": sum(entry["calls"] for entry in entries), "tokens": sum(entry["tokens"] for entry in entries),
            "cost": round(sum(costs), 6), "unpriced": sum(1 for entry in entries if entry["cost"] is None)}


def usage_report(store, users: dict[str, dict], now: datetime) -> dict:
    """users 는 {id: {displayName, email}}. 종류별·사람별 합계는 모든 기록, rows 는 최근 RECENT_DAYS 일 (화면이 날짜별로 묶는다)."""
    entries = _entries(store)
    since = now - timedelta(days=RECENT_DAYS)

    def group(key) -> list[dict]:
        groups: dict = {}
        for entry in entries:
            groups.setdefault(key(entry), []).append(entry)
        return [{"key": name, **_total(items)} for name, items in groups.items()]

    by_kind = [{**item, "label": KINDS.get(item["key"], item["key"])} for item in group(lambda e: e["kind"])]
    by_user = []
    for item in group(lambda e: e["userId"]):
        user = users.get(item["key"] or "") or {}
        by_user.append({**item, "name": user.get("displayName") or ("(deleted or unknown)" if item["key"] else "(no account)"), "email": user.get("email")})
    recent = [entry for entry in entries if entry["at"] >= since]
    return {
        "generatedAt": _iso(now),
        "recordedSince": _iso(entries[0]["at"]) if entries else None,
        "total": _total(entries),
        "byKind": sorted(by_kind, key=lambda item: -item["cost"]),
        "byUser": sorted(by_user, key=lambda item: -item["cost"]),
        "rows": [{**entry, "at": _iso(entry["at"]), "kindLabel": KINDS.get(entry["kind"], entry["kind"]),
                  "user": (users.get(entry["userId"] or "") or {}).get("displayName")} for entry in reversed(recent)],
    }


def _get(path: str, api_key: str) -> dict:
    request = urllib.request.Request(f"{OPENROUTER}{path}", headers={"Authorization": f"Bearer {api_key}"})
    with urllib.request.urlopen(request, timeout=BALANCE_TIMEOUT) as response:
        payload = json.load(response)
    return payload.get("data") if isinstance(payload, dict) and isinstance(payload.get("data"), dict) else {}


def openrouter_balance(api_key: str | None) -> dict:
    """{available, totalCredits, totalUsage, balance, keyLimit, keyRemaining, keyUsage, error}. 키가 없거나 닿지 않으면 available=False."""
    if not api_key:
        return {"available": False, "error": "No OpenRouter key in environment/.env."}
    try:
        credits = _get("/credits", api_key)
        key = _get("/key", api_key)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        return {"available": False, "error": f"Could not reach OpenRouter: {error}"}
    total_credits = _cost(credits.get("total_credits"))
    total_usage = _cost(credits.get("total_usage"))
    return {
        "available": True,
        "totalCredits": total_credits,
        "totalUsage": total_usage,
        "balance": round(total_credits - total_usage, 6) if total_credits is not None and total_usage is not None else None,
        "keyLimit": _cost(key.get("limit")),
        "keyRemaining": _cost(key.get("limit_remaining")),
        "keyUsage": _cost(key.get("usage")),
        "error": None,
    }
