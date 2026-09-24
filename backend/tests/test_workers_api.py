"""Worker Pool 화면의 REST: listWorkers, getWorker, updateWorkerNote, createPool, addWorkersToPool, removeWorkersFromPool,
blockWorkers, unblockWorkers (app/routers/workers.py).

기대값은 prototype/src/api/mock/handlers.test.ts 의 "Worker pool (5.4)" 절과 server.test.ts 에서 온 것이다.
data/ 에는 응답을 낸 worker 가 60명, pool 은 비어 있고, workers.json 은 비어 있다.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.domain.worker_stats import EMPTY_STATS
from helpers import F1, error_of, list_query

STATS_KEYS = {"total", "approved", "rejected", "pending", "rejectRate", "attentionFailRate", "medianWorkTimeInSeconds",
              "majorityAgreement", "batchCount", "lastActiveAt"}


def test_list_workers_default(client: TestClient) -> None:
    """60명. 항목은 Worker {WorkerId, stats, poolIds, blocked, note}. 기본 순서는 응답에 처음 나온 순서다."""
    result = client.get("/api/workers", params=list_query(page_size=100)).json()
    assert result["total"] == 60 and len(result["items"]) == 60
    for worker in result["items"]:
        assert set(worker) == {"WorkerId", "stats", "poolIds", "blocked", "note"}
        assert set(worker["stats"]) == STATS_KEYS
        assert worker["poolIds"] == [] and worker["blocked"] is False and worker["note"] == ""
        assert worker["stats"]["total"] == worker["stats"]["approved"] + worker["stats"]["rejected"] + worker["stats"]["pending"]
    first_assignment = client.get(f"/api/batches/{F1}/assignments", params=list_query(page_size=1, sort="SubmitTime:asc")).json()["items"][0]
    assert result["items"][0]["WorkerId"] == "W603a26f75836"
    assert first_assignment["WorkerId"] in {w["WorkerId"] for w in result["items"]}
    assert sum(w["stats"]["total"] for w in result["items"]) == 231
    assert sum(w["stats"]["rejected"] for w in result["items"]) == 21
    assert sum(w["stats"]["pending"] for w in result["items"]) == 6


def test_list_workers_sort_and_pages(client: TestClient) -> None:
    """server.test.ts: page 2, pageSize 10, stats.rejectRate 내림차순, minApproved 1. 값이 없는(null) 항목은 방향과 무관하게 맨 뒤다."""
    page2 = client.get("/api/workers", params=list_query(page=2, page_size=10, sort="stats.rejectRate:desc", filters={"minApproved": 1})).json()
    assert len(page2["items"]) == 10 and page2["total"] < 60
    by_total = client.get("/api/workers", params=list_query(page_size=100, sort="stats.total:desc")).json()["items"]
    totals = [w["stats"]["total"] for w in by_total]
    assert totals == sorted(totals, reverse=True) and totals[0] == 21
    by_rate = client.get("/api/workers", params=list_query(page_size=100, sort="stats.rejectRate:desc")).json()["items"]
    rates = [w["stats"]["rejectRate"] for w in by_rate]
    present = [r for r in rates if r is not None]
    assert present == sorted(present, reverse=True) and rates[len(present):] == [None] * (len(rates) - len(present))
    by_rate_asc = client.get("/api/workers", params=list_query(page_size=100, sort="stats.rejectRate:asc")).json()["items"]
    assert [w["stats"]["rejectRate"] for w in by_rate_asc][len(present):] == [None] * (len(rates) - len(present))
    by_id = client.get("/api/workers", params=list_query(page_size=100, sort="WorkerId:asc")).json()["items"]
    assert [w["WorkerId"] for w in by_id] == sorted(w["WorkerId"] for w in by_id)
    assert error_of(client.get("/api/workers", params={"page": 0, "pageSize": 10}))[0] == 400
    assert error_of(client.get("/api/workers", params={"page": 1, "pageSize": 2000})) == (400, "INVALID_REQUEST", "pageSize must be between 1 and 1000 (got 2000)")


def test_list_workers_filters_for_fill_by_condition(client: TestClient) -> None:
    """"조건으로 채우기" 에 쓰는 필터: 값이 없는 worker 는 조건을 만족하지 않는 것으로 본다."""
    strict = client.get("/api/workers", params=list_query(page_size=100, filters={"minApproved": 5, "maxAttentionFailRate": 0, "minAgreement": 0.9})).json()
    assert 0 < strict["total"] < 60
    for worker in strict["items"]:
        assert worker["stats"]["approved"] >= 5 and worker["stats"]["attentionFailRate"] == 0 and worker["stats"]["majorityAgreement"] >= 0.9
    client.post("/api/pools/pool-trusted/workers", json={"workerIds": [w["WorkerId"] for w in strict["items"]]})
    rest = client.get("/api/workers", params=list_query(page_size=100, filters={"minApproved": 5, "maxAttentionFailRate": 0, "minAgreement": 0.9, "notInPool": "pool-trusted"})).json()
    assert rest["total"] == 0
    in_pool = client.get("/api/workers", params=list_query(page_size=100, filters={"poolId": "pool-trusted"})).json()
    assert in_pool["total"] == strict["total"] and all(w["poolIds"] == ["pool-trusted"] for w in in_pool["items"])
    search = client.get("/api/workers", params=list_query(page_size=100, filters={"search": "W6"})).json()
    assert search["total"] > 0 and all("w6" in w["WorkerId"].lower() for w in search["items"])
    assert client.get("/api/workers", params=list_query(page_size=100, filters={"search": ""})).json()["total"] == 60   # 빈 값은 필터가 아니다
    assert client.get("/api/workers", params=list_query(page_size=100, filters={"blocked": True})).json()["total"] == 0
    assert client.get("/api/workers", params=list_query(page_size=100, filters={"maxRejectRate": 0})).json()["total"] == len(
        [w for w in client.get("/api/workers", params=list_query(page_size=100)).json()["items"] if w["stats"]["rejectRate"] == 0])


def test_get_worker_detail(client: TestClient) -> None:
    """WorkerDetail: Worker + batch 별 이력 + 최근 제출부터의 assignment 요약. blockReason 은 차단됐을 때만 있다."""
    workers = client.get("/api/workers", params=list_query(page_size=3, sort="stats.batchCount:desc")).json()["items"]
    worker = workers[0]
    detail = client.get(f"/api/workers/{worker['WorkerId']}").json()
    assert {k: detail[k] for k in ("WorkerId", "stats", "poolIds", "blocked", "note")} == worker
    assert "blockReason" not in detail
    assert len(detail["assignments"]) == detail["stats"]["total"]
    assert sum(b["total"] for b in detail["batches"]) == detail["stats"]["total"]
    assert len(detail["batches"]) == detail["stats"]["batchCount"] == 3
    for entry in detail["batches"]:
        assert set(entry) == {"batchId", "batchName", "total", "approved", "rejected", "pending"}
        assert entry["batchName"] != entry["batchId"]
    times = [a["SubmitTime"] for a in detail["assignments"]]
    assert times == sorted(times, reverse=True)
    assert detail["stats"]["lastActiveAt"] == times[0]
    summary = detail["assignments"][0]
    assert set(summary) <= {"AssignmentId", "HITId", "batchId", "rowIndex", "AssignmentStatus", "SubmitTime", "workTimeInSeconds", "attention", "RequesterFeedback"}
    assert set(summary) >= {"AssignmentId", "HITId", "batchId", "rowIndex", "AssignmentStatus", "SubmitTime", "workTimeInSeconds", "attention"}
    rejected = [a for a in detail["assignments"] if a["AssignmentStatus"] == "Rejected"]
    assert all("RequesterFeedback" in a for a in rejected)
    assert error_of(client.get("/api/workers/Wnope")) == (404, "NOT_FOUND", "Worker not found: Wnope")


def test_pools_create_add_remove(client: TestClient) -> None:
    """pool 만들기, 추가, 제거. 이름이 같은 pool 은 (대소문자 무시) 만들 수 없다. 추가할 때 중복은 한 번만 들어간다."""
    pool = client.post("/api/pools", json={"name": " Pilot regulars ", "description": " Did well in the pilot "}).json()
    assert pool == {"id": "pool-pilot-regulars", "name": "Pilot regulars", "description": "Did well in the pilot", "workerIds": []}
    assert error_of(client.post("/api/pools", json={"name": "pilot REGULARS", "description": ""})) == (400, "INVALID_REQUEST", 'A pool named "pilot REGULARS" already exists.')
    assert error_of(client.post("/api/pools", json={"name": " "})) == (400, "INVALID_REQUEST", "Pool name is required.")
    assert error_of(client.post("/api/pools", json=[])) == (400, "INVALID_REQUEST", '"pool" must be a JSON object.')
    assert client.post("/api/pools", json={"name": "Pilot regulars!"}).json()["id"] == "pool-pilot-regulars-2"
    assert [p["id"] for p in client.get("/api/pools").json()] == ["pool-trusted", "pool-excluded", "pool-pilot-regulars", "pool-pilot-regulars-2"]

    workers = [w["WorkerId"] for w in client.get("/api/workers", params=list_query(page_size=3)).json()["items"]]
    added = client.post(f"/api/pools/{pool['id']}/workers", json={"workerIds": [*workers, workers[0]]}).json()
    assert added["workerIds"] == workers and added["id"] == pool["id"]
    removed = client.post(f"/api/pools/{pool['id']}/workers/remove", json={"workerIds": [workers[0], "nope"]}).json()
    assert removed["workerIds"] == workers[1:]
    assert client.get(f"/api/workers/{workers[1]}").json()["poolIds"] == [pool["id"]]
    assert client.get(f"/api/workers/{workers[0]}").json()["poolIds"] == []
    assert error_of(client.post("/api/pools/pool-nope/workers", json={"workerIds": workers})) == (404, "NOT_FOUND", "Pool not found: pool-nope")
    assert error_of(client.post(f"/api/pools/{pool['id']}/workers", json={"workerIds": []})) == (400, "INVALID_REQUEST", "No workers selected.")
    assert error_of(client.post(f"/api/pools/{pool['id']}/workers", json={"workerIds": [1]})) == (400, "INVALID_REQUEST", '"workerIds" must be an array of strings.')
    assert client.post(f"/api/pools/{pool['id']}/workers/remove", json={"workerIds": []}).json()["workerIds"] == workers[1:]

    # 응답이 없어도 pool 에 든 worker 는 빈 지표로 목록에 나온다
    client.post(f"/api/pools/{pool['id']}/workers", json={"workerIds": ["Wghost"]})
    ghost = client.get("/api/workers/Wghost").json()
    assert ghost["stats"] == EMPTY_STATS and ghost["poolIds"] == [pool["id"]] and ghost["batches"] == [] and ghost["assignments"] == []
    listed = client.get("/api/workers", params=list_query(page_size=100)).json()
    assert listed["total"] == 61 and listed["items"][-1]["WorkerId"] == "Wghost"
    assert client.get("/api/health").json()["counts"]["workers"] == 61


def test_block_note_and_unblock(client: TestClient) -> None:
    """차단에는 사유가 필요하고, 메모와 함께 worker 상세에 나온다. 차단과 해제는 204."""
    id = client.get("/api/workers", params=list_query(page_size=1, sort="stats.rejectRate:desc")).json()["items"][0]["WorkerId"]
    assert error_of(client.post("/api/workers/block", json={"ids": [id], "reason": ""})) == (
        400, "INVALID_REQUEST", "A reason is required to block a worker. MTurk records it.")
    assert error_of(client.post("/api/workers/block", json={"ids": [], "reason": "x"})) == (400, "INVALID_REQUEST", "No workers selected.")
    response = client.post("/api/workers/block", json={"ids": [id], "reason": " Repeated random answers "})
    assert response.status_code == 204 and response.content == b""
    noted = client.put(f"/api/workers/{id}/note", json={"note": "Rejected 7 of 7 in the pilot"})
    assert noted.status_code == 200
    assert noted.json()["note"] == "Rejected 7 of 7 in the pilot" and noted.json()["blocked"] is True and set(noted.json()) == {"WorkerId", "stats", "poolIds", "blocked", "note"}

    detail = client.get(f"/api/workers/{id}").json()
    assert detail["blocked"] is True and detail["blockReason"] == "Repeated random answers" and detail["note"] == "Rejected 7 of 7 in the pilot"
    assert len(detail["assignments"]) == detail["stats"]["total"]
    assert client.get("/api/workers", params=list_query(page_size=10, filters={"blocked": True})).json()["total"] == 1

    assert client.post("/api/workers/unblock", json={"ids": [id]}).status_code == 204
    after = client.get(f"/api/workers/{id}").json()
    assert after["blocked"] is False and "blockReason" not in after and after["note"] == "Rejected 7 of 7 in the pilot"
    assert error_of(client.put(f"/api/workers/{id}/note", json={"note": 5})) == (400, "INVALID_REQUEST", '"note" must be a string.')
    assert error_of(client.put("/api/workers/Wnope/note", json={"note": "x"})) == (404, "NOT_FOUND", "Worker not found: Wnope")
    assert error_of(client.post("/api/workers/unblock", json={"ids": "x"})) == (400, "INVALID_REQUEST", '"ids" must be an array of strings.')

    # 응답이 없는 worker 도 차단할 수 있고, 그러면 목록에 나온다
    client.post("/api/workers/block", json={"ids": ["Wnew"], "reason": "spam"})
    new = client.get("/api/workers/Wnew").json()
    assert new["blocked"] is True and new["blockReason"] == "spam" and new["stats"] == EMPTY_STATS
    assert client.get("/api/workers", params=list_query(page_size=100)).json()["total"] == 61
