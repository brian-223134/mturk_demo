"""유료 LLM 호출의 사용 기록과 admin 의 API usage 보고서 (app/usage.py, GET /api/admin/usage). 네트워크는 쓰지 않는다."""

from __future__ import annotations

import urllib.error
from datetime import datetime, timedelta, timezone

from agent.planner.openrouter import KEY_VARIABLE

from app import usage

BINDING_BODY = {
    "design": {"id": "item-list", "rows": [{"slots": ["data", "item-choice"]}]},
    "task_type": "text",
    "prompt": "Check which facts each chunk supports.",
    "data": {"hit_count": 1, "columns": [{"name": "chunks", "shape": "list[3] of str", "samples": []}]},
    "allow_api": True,
}
CONTRACT_BODY = {"request": "Ask Yes or No.", "data": {"hit_count": 1, "columns": [{"name": "p", "shape": "str", "samples": ["x"]}]}, "allow_api": True}


def fake_balance(monkeypatch, credits=None, key=None, error=None) -> None:
    def get(path, api_key):
        if error:
            raise error
        return credits if path == "/credits" else key

    monkeypatch.setattr(usage, "_get", get)


def test_calls_are_recorded_and_reported(make_client, monkeypatch) -> None:
    """binding 과 계약 호출이 한 줄씩 남고, job 문서의 사용량과 함께 종류별·사람별로 합쳐진다. 비용이 없는 호출은 따로 센다."""
    monkeypatch.setattr("app.routers.agent_jobs.write_binding", lambda *a: {"binding": {}, "usage": {"calls": 2, "prompt_tokens": 100, "completion_tokens": 50, "cost": 0.002}, "provider": "Crusoe"})
    monkeypatch.setattr("app.routers.agent_jobs.write_contract", lambda *a: {"contract": {}, "cannot": None, "message": None, "usage": {"calls": 1, "prompt_tokens": 10, "completion_tokens": 5}, "provider": "Parasail"})
    fake_balance(monkeypatch, credits={"total_credits": 500, "total_usage": 277.5}, key={"limit": 400, "limit_remaining": 399.5, "usage": 0.5})
    monkeypatch.setenv(KEY_VARIABLE, "test-key")
    with make_client(api_allowed=True, sign_in_as="admin") as client:
        assert client.post("/api/agent/bindings", json=BINDING_BODY).status_code == 200
        assert client.post("/api/agent/contracts", json=CONTRACT_BODY).status_code == 200
        db = client.app.state.db
        admin_id = client.get("/api/auth/me").json()["user"]["id"]
        with db.transaction(write=True) as store:
            store.save_job({"id": "job-1", "created_at": "2026-11-10T01:00:00Z", "status": "succeeded", "planner": {"model_config": "default"},
                            "usage": {"calls": 3, "prompt_tokens": 300, "completion_tokens": 100, "total_tokens": 400, "cost": 0.01}}, admin_id)
            store.save_job({"id": "job-2", "created_at": "2026-11-10T02:00:00Z", "status": "succeeded", "usage": None}, admin_id)
        report = client.get("/api/admin/usage").json()

    assert report["total"] == {"calls": 6, "tokens": 565, "cost": 0.012, "unpriced": 1}
    kinds = {item["key"]: item for item in report["byKind"]}
    assert set(kinds) == {"binding", "contract", "job"}
    assert kinds["binding"]["cost"] == 0.002 and kinds["binding"]["label"] == "Binding"
    assert kinds["contract"]["unpriced"] == 1
    assert report["byKind"][0]["key"] == "job", "비싼 것부터"
    assert len(report["byUser"]) == 1 and report["byUser"][0]["name"] == "Test admin" and report["byUser"][0]["cost"] == 0.012
    recent = [row for row in report["rows"] if row["kind"] != "job"]
    assert [row["kind"] for row in recent] == ["contract", "binding"], "최근 것부터"
    assert recent[1]["provider"] == "Crusoe" and recent[1]["tokens"] == 150 and recent[1]["user"] == "Test admin"
    assert report["recordedSince"].startswith("2026-11-10T01:00:00")
    assert report["openrouter"] == {"available": True, "totalCredits": 500.0, "totalUsage": 277.5, "balance": 222.5,
                                    "keyLimit": 400.0, "keyRemaining": 399.5, "keyUsage": 0.5, "error": None}


def test_only_admins_see_usage(make_client, monkeypatch) -> None:
    fake_balance(monkeypatch, credits={}, key={})
    with make_client(sign_in_as="requester") as client:
        assert client.get("/api/admin/usage").status_code == 403


def test_report_without_openrouter(make_client, monkeypatch, env_file) -> None:
    """OpenRouter 에 닿지 않거나 키가 없어도 보고서는 나오고, 이유를 알린다. 기록이 없으면 합계는 0 이다."""
    fake_balance(monkeypatch, error=urllib.error.URLError("offline"))
    monkeypatch.setenv(KEY_VARIABLE, "test-key")
    with make_client(sign_in_as="admin") as client:
        report = client.get("/api/admin/usage").json()
    assert report["total"] == {"calls": 0, "tokens": 0, "cost": 0, "unpriced": 0} and report["rows"] == [] and report["recordedSince"] is None
    assert report["openrouter"]["available"] is False
    assert usage.openrouter_balance(None) == {"available": False, "error": "No OpenRouter key in environment/.env."}
    assert "offline" in usage.openrouter_balance("key")["error"]


def test_record_call_skips_missing_usage_and_survives_db_errors(caplog) -> None:
    class BrokenDb:
        def transaction(self, write=False):
            raise RuntimeError("db down")

    usage.record_call(BrokenDb(), "u-1", "page", {"html": ""}, None)   # 사용량이 없으면 DB 에 가지도 않는다
    usage.record_call(BrokenDb(), "u-1", "page", {"usage": {"calls": 1}}, {"model": "m"})
    assert "could not record API usage (page): db down" in caplog.text


def test_recent_rows_cover_the_last_days_only(make_database) -> None:
    db = make_database()
    db.initialize()
    now = datetime(2026, 11, 11, tzinfo=timezone.utc)
    with db.transaction(write=True) as store:
        store.insert_usage({"user_id": None, "kind": "page", "model": "m", "provider": None, "calls": 1, "prompt_tokens": 1, "completion_tokens": 1, "cost": 0.001})
        store.connection.execute("UPDATE api_usage SET at = %s", (now - timedelta(days=usage.RECENT_DAYS + 5),))
        store.insert_usage({"user_id": None, "kind": "page", "model": "m", "provider": None, "calls": 1, "prompt_tokens": 1, "completion_tokens": 1, "cost": 0.002})
        store.connection.execute("UPDATE api_usage SET at = %s WHERE cost = 0.002", (now - timedelta(days=1),))
        report = usage.usage_report(store, {}, now)
    assert report["total"]["cost"] == 0.003
    assert [row["cost"] for row in report["rows"]] == [0.002]
    assert report["byUser"][0]["name"] == "(no account)"
    db.close()
