"""Manage 와 Review 화면의 REST: listHits, getHit, listAssignments, approve, reject, addAssignments, expireBatch, getResults,
exportBatch (app/routers/manage.py).

기대값은 prototype/src/api/mock/handlers.test.ts 의 "검수", "Review 의 대조 기준", "재모집", "Results 와 export" 절과
server.test.ts 에서 온 것이다. F1 = batch-1000001: Submitted 6, Approved 108, Rejected 18, 만료됨, $0.05 (1건 6센트).
"""

from __future__ import annotations

import json
import re

from fastapi.testclient import TestClient

from app.domain.agreement import majority
from helpers import F1, F3, error_of, list_query, sample_batch_request


def submitted_ids(client: TestClient, batch_id: str = F1) -> list[str]:
    result = client.get(f"/api/batches/{batch_id}/assignments", params=list_query(page_size=50, filters={"AssignmentStatus": "Submitted"})).json()
    return [a["AssignmentId"] for a in result["items"]]


# ---- listHits, getHit ---------------------------------------------------------------------------


def test_list_hits_items_and_queries(client: TestClient) -> None:
    """HitListItem: input 대신 inputPreview(200자 + …), progress(shortfall 포함), expired. page, sort, filters 가 먹는다."""
    first = client.get(f"/api/batches/{F1}/hits", params=list_query()).json()
    assert first["total"] == 40 and len(first["items"]) == 25
    item = first["items"][0]
    assert "input" not in item and set(item["progress"]) == {"submitted", "approved", "rejected", "open", "completed", "shortfall"}
    assert len(item["inputPreview"]["retrieved_chunk"]) <= 201 and item["inputPreview"]["retrieved_chunk"].endswith("…")
    full = client.get(f"/api/hits/{item['HITId']}").json()
    assert len(full["input"]["retrieved_chunk"]) > 1000
    assert full["input"]["retrieved_chunk"].startswith(item["inputPreview"]["retrieved_chunk"][:-1])

    page2 = client.get(f"/api/batches/{F1}/hits", params=list_query(page=2)).json()
    assert page2["total"] == 40 and len(page2["items"]) == 15
    assert {h["HITId"] for h in page2["items"]}.isdisjoint({h["HITId"] for h in first["items"]})

    desc = client.get(f"/api/batches/{F1}/hits", params=list_query(page_size=100, sort="rowIndex:desc")).json()["items"]
    assert [h["rowIndex"] for h in desc] == list(range(39, -1, -1))

    # F1 의 0번 행: MaxAssignments 6, 반려 3, 검수 대기 2, 열린 자리 1. 검수 대기가 목표를 채울 수도 있어 아직 부족분은 없다
    row0 = client.get(f"/api/batches/{F1}/hits", params=list_query(page_size=1, sort="rowIndex:asc")).json()["items"][0]
    assert row0["MaxAssignments"] == 6 and row0["expired"] is True
    assert row0["progress"] == {"submitted": 2, "approved": 0, "rejected": 3, "open": 1, "completed": False, "shortfall": 0}

    stuck = client.get(f"/api/batches/{F1}/hits", params=list_query(page_size=100, filters={"incomplete": True})).json()
    assert [[h["rowIndex"], h["progress"]["shortfall"], h["progress"]["open"], h["expired"]] for h in stuck["items"]] == [
        [0, 0, 1, True], [1, 0, 3, True], [2, 0, 1, True], [3, 0, 1, True]]
    assert client.get(f"/api/batches/{F1}/hits", params=list_query(page_size=100, filters={"incomplete": False})).json()["total"] == 40
    one = client.get(f"/api/batches/{F1}/hits", params=list_query(filters={"HITId": row0["HITId"]})).json()
    assert one["total"] == 1 and one["items"][0]["HITId"] == row0["HITId"]
    reviewable = client.get(f"/api/batches/{F1}/hits", params=list_query(page_size=100, filters={"HITStatus": ["Reviewable"]})).json()
    assert reviewable["total"] == 40

    assert error_of(client.get("/api/batches/batch-0/hits", params=list_query())) == (404, "NOT_FOUND", "Batch not found: batch-0")
    assert error_of(client.get("/api/hits/nope")) == (404, "NOT_FOUND", "HIT not found: nope")
    assert error_of(client.get(f"/api/batches/{F1}/hits", params={"page": 0, "pageSize": 10})) == (400, "INVALID_REQUEST", "page must be an integer ≥ 1 (got 0)")
    assert error_of(client.get(f"/api/batches/{F1}/hits", params={"page": 1, "pageSize": 10, "filters": "{broken"})) == (
        400, "INVALID_REQUEST", "Malformed query string (filters must be JSON).")


# ---- listAssignments ------------------------------------------------------------------------------


def test_list_assignments_review_columns_and_filters(client: TestClient) -> None:
    """Review 표의 Row, Agree 열과 필터 (handlers.test.ts)."""
    everything = client.get(f"/api/batches/{F1}/assignments", params=list_query(page_size=200)).json()
    assert everything["total"] == 132 and len(everything["items"]) == 132
    for a in everything["items"]:
        assert a["rowIndex"] >= 0
        assert a["agreement"] is None or 0 <= a["agreement"] <= 1
        assert set(a) >= {"AssignmentId", "HITId", "WorkerId", "AssignmentStatus", "answers", "attention", "reference", "agreement", "rowIndex"}
    default = client.get(f"/api/batches/{F1}/assignments", params=list_query()).json()
    assert default["total"] == 132 and len(default["items"]) == 25
    assert client.get(f"/api/batches/{F1}/assignments", params=list_query(page_size=50, filters={"AssignmentStatus": "Submitted"})).json()["total"] == 6
    assert client.get(f"/api/batches/{F1}/assignments", params=list_query(page_size=50, filters={"AssignmentStatus": ["Submitted"]})).json()["total"] == 6
    assert client.get(f"/api/batches/{F1}/assignments", params=list_query(page_size=200, filters={"attention": "fail"})).json()["total"] == 25   # Approved 14 + Rejected 11
    fast = client.get(f"/api/batches/{F1}/assignments", params=list_query(page_size=200, filters={"maxWorkTime": 120})).json()
    assert 0 < fast["total"] < 132 and all(a["workTimeInSeconds"] < 120 for a in fast["items"])
    hit_id = everything["items"][0]["HITId"]
    one_hit = client.get(f"/api/batches/{F1}/assignments", params=list_query(page_size=50, filters={"HITId": hit_id})).json()
    assert one_hit["total"] > 0 and all(a["HITId"] == hit_id for a in one_hit["items"])
    worker = everything["items"][0]["WorkerId"]
    searched = client.get(f"/api/batches/{F1}/assignments", params=list_query(page_size=200, filters={"workerSearch": worker[:4].upper()})).json()
    assert searched["total"] > 0 and all(worker[:4].lower() in a["WorkerId"].lower() for a in searched["items"])
    assert error_of(client.get("/api/batches/batch-0/assignments", params=list_query()))[0] == 404


def test_list_assignments_default_order_and_stable_sort(client: TestClient) -> None:
    """기본 순서: rowIndex 오름차순, 같은 HIT 안에서는 WorkerId 오름차순. 한 필드로 정렬해도 같은 값끼리는 이 순서를 유지한다."""
    items = client.get(f"/api/batches/{F1}/assignments", params=list_query(page_size=200)).json()["items"]
    for previous, current in zip(items, items[1:]):
        assert current["rowIndex"] >= previous["rowIndex"]
        if current["rowIndex"] == previous["rowIndex"]:
            assert current["WorkerId"] >= previous["WorkerId"]
    by_status = client.get(f"/api/batches/{F1}/assignments", params=list_query(page_size=200, sort="AssignmentStatus:asc")).json()["items"]
    assert [a["AssignmentStatus"] for a in by_status] == sorted(a["AssignmentStatus"] for a in by_status)
    submitted_rows = [a["rowIndex"] for a in by_status if a["AssignmentStatus"] == "Submitted"]
    assert submitted_rows == sorted(submitted_rows)
    by_time = client.get(f"/api/batches/{F1}/assignments", params=list_query(page_size=200, sort="SubmitTime:desc")).json()["items"]
    assert [a["SubmitTime"] for a in by_time] == sorted((a["SubmitTime"] for a in by_time), reverse=True)


def test_reference_column_mode(client: TestClient) -> None:
    """F3 (column 모드): 입력 컬럼의 라벨을 문항에 대응시키고, attention 문항의 기준은 batch 의 정답이다.
    라벨 `Not covered` 와 답 `Not Covered` 는 같은 값으로 비교한다 (평균 일치율 ≈ 0.973)."""
    assert client.get(f"/api/batches/{F3}").json()["batch"]["reference"] == {"source": "column", "column": "query_fact_coverage_check"}
    result = client.get(f"/api/batches/{F3}/assignments", params=list_query(page_size=200)).json()
    assert result["total"] == 48
    for a in result["items"]:
        for answer in a["answers"]:
            if answer["name"].startswith("attention_"):
                assert a["reference"][answer["name"]] == "Not Covered"
            else:
                assert answer["name"] in a["reference"]
        assert a["agreement"] is not None and 0 <= a["agreement"] <= 1
    assert abs(sum(a["agreement"] for a in result["items"]) / 48 - 0.973) < 0.005


def test_reference_majority_mode(client: TestClient) -> None:
    """F1 (majority 모드): 같은 HIT 의 다른 worker 들(반려 제외) majority. 다른 worker 가 없거나 동률인 문항은 기준이 없다."""
    assert client.get(f"/api/batches/{F1}").json()["batch"]["reference"] == {"source": "majority"}
    items = client.get(f"/api/batches/{F1}/assignments", params=list_query(page_size=200)).json()["items"]
    alone = 0
    for a in items:
        others = [o for o in items if o["HITId"] == a["HITId"] and o["AssignmentId"] != a["AssignmentId"] and o["AssignmentStatus"] != "Rejected"]
        if not others:
            alone += 1
            assert [name for name in a["reference"] if not name.startswith("attention_")] == []
            assert a["agreement"] is None
        for answer in a["answers"]:
            if answer["name"].startswith("attention_"):
                assert a["reference"][answer["name"]] == "not_grounded"
                continue
            expected = majority([x["value"] for o in others for x in o["answers"] if x["name"] == answer["name"]])
            if expected is None:
                assert answer["name"] not in a["reference"]
            else:
                assert a["reference"][answer["name"]] == expected
    assert alone == 2   # 두 응답이 모두 반려된 HIT 하나


# ---- approve, reject ------------------------------------------------------------------------------


def test_approve_changes_status_progress_and_cost(client: TestClient) -> None:
    ids = submitted_ids(client)
    assert len(ids) == 6
    before = client.get(f"/api/batches/{F1}").json()
    response = client.post("/api/assignments/approve", json={"ids": ids, "feedback": "Thank you."})
    assert response.status_code == 200
    approved = response.json()
    assert [a["AssignmentId"] for a in approved] == ids
    assert all(a["AssignmentStatus"] == "Approved" and a["ApprovalTime"].endswith("Z") and "RejectionTime" not in a for a in approved)
    assert approved[0]["RequesterFeedback"] == "Thank you."

    after = client.get(f"/api/batches/{F1}").json()
    assert {k: after["progress"][k] for k in ("submitted", "approved", "rejected")} == {"submitted": 0, "approved": 114, "rejected": 18}
    assert after["needsReview"] is False
    assert after["progress"]["hitsCompleted"] >= before["progress"]["hitsCompleted"]
    assert after["cost"]["spentCents"] == 114 * 6
    assert client.get(f"/api/batches/{F1}/assignments", params=list_query(filters={"AssignmentStatus": "Submitted"})).json()["total"] == 0
    assert client.get("/api/account").json()["AvailableBalance"] == "500.00"   # 승인은 이미 낸 돈이다


def test_reject_needs_feedback_and_only_submitted(client: TestClient) -> None:
    id = submitted_ids(client)[0]
    assert error_of(client.post("/api/assignments/reject", json={"ids": [id], "feedback": "  "})) == (
        400, "INVALID_REQUEST", "Feedback is required when rejecting. Workers see it as the reason.")
    response = client.post("/api/assignments/reject", json={"ids": [id], "feedback": " Poor Quality. "})
    assert response.status_code == 200
    rejected = response.json()[0]
    assert rejected["AssignmentStatus"] == "Rejected" and rejected["RequesterFeedback"] == "Poor Quality." and rejected["RejectionTime"].endswith("Z")
    assert error_of(client.post("/api/assignments/reject", json={"ids": [id], "feedback": "Poor Quality."})) == (
        400, "INVALID_REQUEST", f"Assignment {id} is Rejected. Only submitted assignments can be rejected.")
    approved_id = client.get(f"/api/batches/{F1}/assignments", params=list_query(page_size=1, filters={"AssignmentStatus": "Approved"})).json()["items"][0]["AssignmentId"]
    assert error_of(client.post("/api/assignments/reject", json={"ids": [approved_id], "feedback": "x"}))[0] == 400
    assert error_of(client.post("/api/assignments/reject", json={"ids": [], "feedback": "x"})) == (400, "INVALID_REQUEST", "No assignments selected.")
    assert error_of(client.post("/api/assignments/reject", json={"ids": "x", "feedback": "x"})) == (400, "INVALID_REQUEST", '"ids" must be an array of strings.')


def test_review_is_all_or_nothing(client: TestClient) -> None:
    """여러 건 중 하나라도 처리할 수 없으면 아무것도 바꾸지 않는다 (트랜잭션)."""
    ids = submitted_ids(client)
    assert error_of(client.post("/api/assignments/reject", json={"ids": [*ids, "NO_SUCH_ASSIGNMENT"], "feedback": "Poor Quality."})) == (
        404, "NOT_FOUND", "Assignment not found: NO_SUCH_ASSIGNMENT")
    assert client.get(f"/api/batches/{F1}").json()["progress"]["submitted"] == 6
    assert client.get("/api/account").json()["AvailableBalance"] == "500.00"


def test_override_rejection_within_30_days_and_balance(client: TestClient) -> None:
    """반려하면 6센트를 돌려받고($500.06), 번복(override)하면 다시 낸다($500.00). 2025년에 반려된 건은 30일이 지나 번복할 수 없다."""
    id = submitted_ids(client)[0]
    client.post("/api/assignments/reject", json={"ids": [id], "feedback": "Poor Quality."})
    assert client.get("/api/account").json()["AvailableBalance"] == "500.06"   # $0.05 + 최소 수수료 $0.01
    assert error_of(client.post("/api/assignments/approve", json={"ids": [id]})) == (
        400, "INVALID_REQUEST", f'Assignment {id} was rejected. Use "Revert to approved" to override.')
    reverted = client.post("/api/assignments/approve", json={"ids": [id], "override": True}).json()[0]
    assert reverted["AssignmentStatus"] == "Approved" and "RejectionTime" not in reverted and "RequesterFeedback" not in reverted
    assert client.get("/api/account").json()["AvailableBalance"] == "500.00"
    assert error_of(client.post("/api/assignments/approve", json={"ids": [id]})) == (400, "INVALID_REQUEST", f"Assignment {id} is already approved.")

    old = client.get(f"/api/batches/{F1}/assignments", params=list_query(page_size=1, filters={"AssignmentStatus": "Rejected"})).json()["items"][0]
    status, code, message = error_of(client.post("/api/assignments/approve", json={"ids": [old["AssignmentId"]], "override": True}))
    assert (status, code) == (400, "INVALID_REQUEST") and "more than 30 days" in message
    assert client.get("/api/account").json()["AvailableBalance"] == "500.00"


# ---- addAssignments ---------------------------------------------------------------------------------


def test_top_up_fill_to_target_after_rejection(client: TestClient) -> None:
    """반려하면 부족분이 생기고, fill-to-target 이 그만큼 추가하며 만료된 HIT 의 게시 기간을 연장한다."""
    row0 = client.get(f"/api/batches/{F1}/hits", params=list_query(page_size=1, sort="rowIndex:asc")).json()["items"][0]
    pending = client.get(f"/api/batches/{F1}/assignments", params=list_query(page_size=10, filters={"HITId": row0["HITId"], "AssignmentStatus": "Submitted"})).json()
    client.post("/api/assignments/reject", json={"ids": [a["AssignmentId"] for a in pending["items"]], "feedback": "Failed to pass the attention check task."})
    rejected = client.get(f"/api/batches/{F1}/hits", params=list_query(page_size=1, filters={"HITId": row0["HITId"]})).json()["items"][0]
    assert rejected["progress"] == {"submitted": 0, "approved": 0, "rejected": 5, "open": 1, "completed": False, "shortfall": 2}   # 반려해도 자리는 다시 열리지 않는다

    result = client.post("/api/hits/add-assignments", json={"hitIds": [row0["HITId"]], "mode": "fill-to-target"})
    assert result.status_code == 200
    assert result.json() == {"added": [{"HITId": row0["HITId"], "count": 2, "expirationExtended": True}], "skipped": []}

    after = client.get(f"/api/batches/{F1}/hits", params=list_query(page_size=1, filters={"HITId": row0["HITId"]})).json()["items"][0]
    assert after["MaxAssignments"] == 8 and after["expired"] is False and after["HITStatus"] == "Assignable"
    assert after["progress"]["open"] == 3 and after["progress"]["shortfall"] == 0
    assert after["NumberOfAssignmentsAvailable"] == 3 and after["NumberOfAssignmentsCompleted"] == 5
    assert client.get(f"/api/batches/{F1}").json()["status"] == "in_progress"
    assert client.get("/api/account").json()["AvailableBalance"] == "500.00"   # 반려로 2건 환불, 추가로 2건 선결제


def test_top_up_reopens_expired_hits_without_adding(client: TestClient) -> None:
    """부족분은 없지만 만료되어 막힌 HIT 는 추가 없이 게시 기간만 연장한다. 완료된 HIT 와 숫자 지정에는 적용하지 않는다."""
    stuck = client.get(f"/api/batches/{F1}/hits", params=list_query(page_size=100, filters={"incomplete": True})).json()
    result = client.post("/api/hits/add-assignments", json={"hitIds": [h["HITId"] for h in stuck["items"]], "mode": "fill-to-target"}).json()
    assert [[a["count"], a["expirationExtended"]] for a in result["added"]] == [[0, True]] * 4 and result["skipped"] == []
    after = client.get(f"/api/batches/{F1}/hits", params=list_query(page_size=100, filters={"incomplete": True})).json()
    assert all(not h["expired"] and h["HITStatus"] == "Assignable" for h in after["items"])
    assert [h["MaxAssignments"] for h in after["items"]] == [h["MaxAssignments"] for h in stuck["items"]]
    assert client.get("/api/account").json()["AvailableBalance"] == "500.00"

    done = client.get(f"/api/batches/{F1}/hits", params=list_query(page_size=1, sort="rowIndex:desc")).json()["items"][0]
    skipped = client.post("/api/hits/add-assignments", json={"hitIds": [done["HITId"]], "mode": "fill-to-target"}).json()
    assert skipped["added"] == [] and skipped["skipped"] == [{"HITId": done["HITId"], "reason": "No shortfall: open and submitted assignments already cover the target."}]


def test_top_up_nine_cap_and_validation(client: TestClient) -> None:
    """9개 상한: 넘는 HIT 는 건너뛰고 사유를 알려준다. 추가한 만큼 잔액에서 빠진다."""
    hit = client.get(f"/api/batches/{F1}/hits", params=list_query(page_size=1, sort="MaxAssignments:desc")).json()["items"][0]
    assert hit["MaxAssignments"] == 6
    ok = client.post("/api/hits/add-assignments", json={"hitIds": [hit["HITId"]], "mode": 3}).json()
    assert ok["added"] == [{"HITId": hit["HITId"], "count": 3, "expirationExtended": True}]
    assert client.get("/api/account").json()["AvailableBalance"] == "499.82"   # 3 × 6센트
    over = client.post("/api/hits/add-assignments", json={"hitIds": [hit["HITId"]], "mode": 1}).json()
    assert over["added"] == [] and re.search(r"cannot exceed 9", over["skipped"][0]["reason"])
    assert over["skipped"][0]["reason"] == "MTurk limit: a HIT created with fewer than 10 assignments cannot exceed 9 (now 9, requested +1)."
    assert client.get(f"/api/hits/{hit['HITId']}").json()["MaxAssignments"] == 9

    assert error_of(client.post("/api/hits/add-assignments", json={"hitIds": [], "mode": 1})) == (400, "INVALID_REQUEST", "No HITs selected.")
    assert error_of(client.post("/api/hits/add-assignments", json={"hitIds": [hit["HITId"]], "mode": 0})) == (
        400, "INVALID_REQUEST", "The number of assignments to add must be an integer ≥ 1.")
    assert error_of(client.post("/api/hits/add-assignments", json={"hitIds": [hit["HITId"]], "mode": "lots"}))[0] == 400
    assert error_of(client.post("/api/hits/add-assignments", json={"hitIds": ["NO_SUCH"], "mode": "fill-to-target"})) == (404, "NOT_FOUND", "HIT not found: NO_SUCH")


def test_top_up_needs_balance(client: TestClient) -> None:
    """잔액이 모자라면 아무 HIT 도 바꾸지 않는다."""
    request = sample_batch_request(client)
    batch = client.post("/api/batches", json={**request, "settings": {**request["settings"], "Reward": "16.00", "MaxAssignments": 1}}).json()  # 10 × $19.20 = $192.00
    assert client.get("/api/account").json()["AvailableBalance"] == "308.00"
    hits = client.get(f"/api/batches/{batch['id']}/hits", params=list_query(page_size=100)).json()["items"]
    status, code, message = error_of(client.post("/api/hits/add-assignments", json={"hitIds": [h["HITId"] for h in hits], "mode": 2}))
    assert (status, code) == (400, "INVALID_REQUEST") and message == "Insufficient balance: this needs $384.00 but only $308.00 is available."
    assert all(h["MaxAssignments"] == 1 for h in client.get(f"/api/batches/{batch['id']}/hits", params=list_query(page_size=100)).json()["items"])


# ---- expireBatch ----------------------------------------------------------------------------------


def test_expire_batch_closes_remaining_hits(client: TestClient) -> None:
    batch = client.post("/api/batches", json=sample_batch_request(client)).json()
    response = client.post(f"/api/batches/{batch['id']}/expire")
    assert response.status_code == 204 and response.content == b""
    assert client.get(f"/api/batches/{batch['id']}").json()["status"] == "expired"
    hits = client.get(f"/api/batches/{batch['id']}/hits", params=list_query(page_size=100)).json()
    assert all(h["expired"] and h["HITStatus"] == "Reviewable" for h in hits["items"])
    assert error_of(client.post("/api/batches/batch-0/expire")) == (404, "NOT_FOUND", "Batch not found: batch-0")


# ---- results, export ------------------------------------------------------------------------------


def test_results_count_approved_real_items_only(client: TestClient) -> None:
    results = client.get(f"/api/batches/{F1}/results").json()
    assert set(results) == {"target", "items", "unanimousRatio", "fleissKappa", "kappaItemCount", "labelDistribution"}
    assert results["target"] == 3
    assert all(not item["answerName"].startswith("attention_") for item in results["items"])
    assert sum(len(item["votes"]) for item in results["items"]) == sum(results["labelDistribution"].values())
    assert results["kappaItemCount"] == sum(1 for item in results["items"] if len(item["votes"]) == 3)
    assert -1 < results["fleissKappa"] < 1
    assert sorted(results["labelDistribution"]) == ["grounded", "not_grounded"]
    first = results["items"][0]
    assert set(first) == {"key", "rowIndex", "answerName", "votes", "workers", "majority", "unanimous"}
    assert first["key"] == f"{first['rowIndex']}:{first['answerName']}" and len(first["votes"]) == len(first["workers"])
    keys = [(item["rowIndex"], item["answerName"]) for item in results["items"]]
    assert keys == sorted(keys, key=lambda k: (k[0], [int(p) if p.isdigit() else p for p in re.split(r"(\d+)", k[1])]))


def test_fleiss_kappa_matches_statsmodels(client: TestClient) -> None:
    """handlers.test.ts: 기존 *_iaa.py 가 쓰는 statsmodels 의 fleiss_kappa 와 같은 값 (소수 여섯째 자리)."""
    reference = {"batch-1000001": (420, 0.730594), "batch-1000003": (241, 0.938407), "batch-1000002": (326, 0.856749)}
    for batch_id, (items, kappa) in reference.items():
        results = client.get(f"/api/batches/{batch_id}/results").json()
        assert results["kappaItemCount"] == items, batch_id
        assert round(results["fleissKappa"], 6) == kappa, batch_id


def test_export_mturk_csv(client: TestClient) -> None:
    file = client.get(f"/api/batches/{F1}/export", params={"format": "mturk-csv"}).json()
    assert file["filename"] == "pilot-close-ended-chunk-fact-results.csv" and file["mimeType"] == "text/csv;charset=utf-8"
    header = file["content"][: file["content"].index("\r\n")].split(",")
    for column in ("HITId", "WorkerId", "AssignmentStatus", "Input.idx", "Input.qid", "Input.retrieved_chunk", "Input.attention_check", "Answer.taskAnswers"):
        assert column in header
    assert '[{""input_answers"":""[{\\""name\\"":' in file["content"]
    assert " UTC 2025" in file["content"] and file["content"].endswith("\r\n")


def test_export_labels_json(client: TestClient) -> None:
    file = client.get(f"/api/batches/{F1}/export", params={"format": "labels-json"}).json()
    assert file["filename"] == "pilot-close-ended-chunk-fact-labels.json" and file["mimeType"] == "application/json"
    labels = json.loads(file["content"])
    key, label = next(iter(labels.items()))
    assert re.match(r"^\d+:general_\d+_\d+$", key)
    assert set(label) == {"votes", "majority", "workers"} and len(label["votes"]) == len(label["workers"])
    assert len(labels) == len(client.get(f"/api/batches/{F1}/results").json()["items"])
    assert file["content"].startswith('{\n  "') and '"votes": [\n      "' in file["content"]   # JSON.stringify(…, null, 2)
    assert error_of(client.get(f"/api/batches/{F1}/export", params={"format": "xlsx"})) == (400, "INVALID_REQUEST", "Unknown export format: xlsx")
    assert error_of(client.get(f"/api/batches/{F1}/export")) == (400, "INVALID_REQUEST", "Unknown export format: undefined")
    assert error_of(client.get("/api/batches/batch-0/export", params={"format": "labels-json"}))[0] == 404
