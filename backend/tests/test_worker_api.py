"""worker 의 작업 API (/api/worker/…, routers/worker.py, app/domain/tasks.py).

Requester 가 batch 를 게시하고, worker 가 HIT 를 받아(Accepted) 작업 화면을 받고, 제출하면(Submitted) Requester 의 Review 와
진행률, IAA 의 검수 대기 범위에 들어가는 흐름을 본다. 자리 수(MaxAssignments), 같은 HIT 를 두 번 받지 않는 것, 반납과 제한 시간,
Requester 별 차단과 pool 조건, worker 에게 정답 컬럼을 보내지 않는 것, 내 HIT 목록의 금액 요약도 확인한다.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.domain.tasks import check_answers, visible_row, worker_columns
from conftest import sign_in
from helpers import SETTINGS, error_of, list_query

GROUPS = "/api/worker/hit-groups"
MINE = "/api/worker/assignments"
TASK_DATA_HTML = "<html><head></head><body><script>var d = window.TASK_DATA;</script></body></html>"


def publish(client: TestClient, *, rows: int = 2, html: str = TASK_DATA_HTML, columns=("item_id", "passage", "gold", "attention_expected"),
            **extra) -> dict:
    """requester 로 템플릿을 저장하고 batch 를 게시한다. 기대 답 컬럼 방식의 attention 과 대조 기준 컬럼이 있다."""
    sign_in(client, "requester")
    template = client.post("/api/templates", json={"name": "Worker flow", "html": html}).json()
    body = {
        "name": "worker flow batch",
        "templateId": template["id"],
        "inputColumns": list(columns),
        "rows": [{"item_id": f"s{i}", "passage": f"passage {i}", "gold": "yes",
                  "attention_expected": '{"attention_1": "no"}'} for i in range(rows)],
        "settings": SETTINGS,
        "attentionRule": {"column": "attention_expected", "minCorrectRatio": 1},
        "reference": {"source": "column", "column": "gold"},
        "requiredPoolIds": [],
        "excludedPoolIds": [],
        **extra,
    }
    response = client.post("/api/batches", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def accept(client: TestClient, batch_id: str):
    return client.post(f"{GROUPS}/{batch_id}/accept")


ANSWERS = [{"name": "label_1", "value": "yes"}, {"name": "attention_1", "value": "no"}]


# ---- 규칙 ---------------------------------------------------------------------------------------


def test_worker_columns_hide_answer_keys() -> None:
    batch = {"inputColumns": ["item_id", "passage", "gold", "attention_expected"], "templateHtml": TASK_DATA_HTML,
             "attentionRule": {"column": "attention_expected"}, "reference": {"source": "column", "column": "gold"}}
    assert worker_columns(batch) == ["item_id", "passage"]
    # placeholder 가 있는 템플릿은 그 컬럼만 보낸다 (정답 컬럼이 아니어도 템플릿이 쓰지 않으면 보내지 않는다)
    assert worker_columns({**batch, "templateHtml": "<p>${passage}</p>"}) == ["passage"]
    assert worker_columns({**batch, "attentionRule": None, "reference": {"source": "majority"}}) == batch["inputColumns"]
    assert visible_row(batch, {"item_id": "s1", "passage": "p", "gold": "yes"}) == {"item_id": "s1", "passage": "p"}
    with pytest.raises(ValueError, match="No answers"):
        check_answers([])
    with pytest.raises(ValueError, match='"name"'):
        check_answers([{"value": "x"}])
    assert check_answers([{"name": "a", "value": 3}]) == [{"name": "a", "value": "3"}]


# ---- 받고 풀고 제출하기 ----------------------------------------------------------------------------


def test_accept_work_and_submit(client: TestClient) -> None:
    batch = publish(client)
    worker = sign_in(client, "worker")

    groups = client.get(GROUPS).json()["groups"]
    assert [g["batchId"] for g in groups] == [batch["id"]]   # 시작 데이터의 batch 는 모두 만료됐다
    group = groups[0]
    assert (group["availableHits"], group["reward"], group["requester"], group["activeAssignmentId"]) == (2, "0.10", "Test requester", None)

    first = accept(client, batch["id"]).json()["assignment"]
    assert first["status"] == "Accepted" and first["rowIndex"] == 0 and first["deadline"]
    assert accept(client, batch["id"]).json()["assignment"]["assignmentId"] == first["assignmentId"]   # 푸는 중이면 그것을 이어서
    assert client.get(GROUPS).json()["groups"][0]["activeAssignmentId"] == first["assignmentId"]

    task = client.get(f"{MINE}/{first['assignmentId']}").json()["assignment"]["task"]
    assert task["html"] == TASK_DATA_HTML
    assert task["row"] == {"item_id": "s0", "passage": "passage 0"}   # 정답 컬럼(gold, attention_expected)은 오지 않는다

    # Requester 화면: 푸는 중인 assignment 는 진행률의 inProgress 이고, Review 에는 없다
    worker_token = client.cookies.get("mturk_session")
    sign_in(client, "requester")
    detail = client.get(f"/api/batches/{batch['id']}").json()
    assert (detail["progress"]["inProgress"], detail["progress"]["open"]) == (1, 5)
    assert client.get(f"/api/batches/{batch['id']}/assignments", params=list_query()).json()["total"] == 0
    hit = client.get(f"/api/hits/{first['hitId']}").json()
    assert (hit["NumberOfAssignmentsPending"], hit["NumberOfAssignmentsAvailable"]) == (1, 2)

    client.cookies.clear()
    client.cookies.set("mturk_session", worker_token)
    submitted = client.post(f"{MINE}/{first['assignmentId']}/submit", json={"answers": ANSWERS}).json()["assignment"]
    assert submitted["status"] == "Submitted" and submitted["submitTime"] and submitted["deadline"] is None
    assert error_of(client.post(f"{MINE}/{first['assignmentId']}/submit", json={"answers": ANSWERS}))[2] == "This assignment is already submitted."
    assert "task" not in client.get(f"{MINE}/{first['assignmentId']}").json()["assignment"]

    # 다음 HIT 는 다른 행이다 (같은 HIT 를 두 번 받지 않는다)
    second = accept(client, batch["id"]).json()["assignment"]
    assert second["rowIndex"] == 1 and second["assignmentId"] != first["assignmentId"]

    sign_in(client, "requester")
    listed = client.get(f"/api/batches/{batch['id']}/assignments", params=list_query()).json()["items"]
    assert [(a["WorkerId"], a["AssignmentStatus"], a["rowIndex"]) for a in listed] == [(worker["worker_id"], "Submitted", 0)]
    assert listed[0]["answers"] == ANSWERS and listed[0]["attention"]["passed"] is True
    assert listed[0]["workTimeInSeconds"] >= 0 and listed[0]["AutoApprovalTime"]
    progress = client.get(f"/api/batches/{batch['id']}").json()["progress"]
    assert (progress["submitted"], progress["inProgress"]) == (1, 1)
    assert client.get(f"/api/batches/{batch['id']}/results").json()["iaa"]["pending"]["assignments"] == 1
    assert client.get(f"/api/workers/{worker['worker_id']}").json()["stats"]["total"] == 1


def test_slots_follow_max_assignments(client: TestClient) -> None:
    """MaxAssignments 3 인 HIT 하나를 세 worker 가 채우면 네 번째 worker 에게는 남은 HIT 가 없다."""
    batch = publish(client, rows=1)
    for n in range(3):
        sign_in(client, "worker", email=f"w{n}@example.com")
        assignment = accept(client, batch["id"]).json()["assignment"]
        client.post(f"{MINE}/{assignment['assignmentId']}/submit", json={"answers": ANSWERS})
        assert error_of(accept(client, batch["id"]))[2] == "There are no more HITs in this batch for you."
    sign_in(client, "worker", email="w3@example.com")
    assert client.get(GROUPS).json()["groups"] == []
    assert error_of(accept(client, batch["id"])) == (400, "INVALID_REQUEST", "There are no more HITs in this batch for you.")


def test_return_and_time_limit_reopen_the_slot(client: TestClient) -> None:
    batch = publish(client, rows=1)
    sign_in(client, "worker")
    first = accept(client, batch["id"]).json()["assignment"]
    returned = client.post(f"{MINE}/{first['assignmentId']}/return").json()["assignment"]
    assert returned["status"] == "Returned"
    assert client.get(GROUPS).json()["groups"][0]["availableHits"] == 1
    assert client.get(MINE).json()["assignments"] == []   # 반납한 HIT 는 내 목록에 없다

    again = accept(client, batch["id"]).json()["assignment"]
    assert again["assignmentId"] == first["assignmentId"] and again["status"] == "Accepted"   # 같은 HIT 를 다시 받으면 그 행을 다시 쓴다

    with client.app.state.db.transaction(write=True) as store:   # 제한 시간이 지난 것으로 (문서와 컬럼을 함께 바꾼다)
        doc = store.any_assignment(again["assignmentId"])
        store.update_assignment({**doc, "Deadline": "2020-01-01T00:00:00.000Z"})
    status, _, message = error_of(client.post(f"{MINE}/{again['assignmentId']}/submit", json={"answers": ANSWERS}))
    assert status == 400 and message.startswith("The time for this HIT ran out")
    assert client.get(f"{MINE}/{again['assignmentId']}").json()["assignment"]["status"] == "Abandoned"
    assert client.get(GROUPS).json()["groups"][0]["availableHits"] == 1   # 시간이 지난 Accepted 는 자리를 차지하지 않는다

    third = accept(client, batch["id"]).json()["assignment"]   # 받으면서 시간이 지난 것을 Abandoned 로 저장하고 다시 쓴다
    assert third["status"] == "Accepted" and third["assignmentId"] == first["assignmentId"]


# ---- 받을 수 있는 사람 ------------------------------------------------------------------------------


def test_blocked_workers_and_pools(client: TestClient) -> None:
    worker = sign_in(client, "worker")
    sign_in(client, "requester")
    pool = client.post("/api/pools", json={"name": "Pilot"}).json()
    open_batch = publish(client)
    pool_batch = publish(client, requiredPoolIds=[pool["id"]])

    sign_in(client, "worker")
    assert {g["batchId"] for g in client.get(GROUPS).json()["groups"]} == {open_batch["id"]}
    assert error_of(accept(client, pool_batch["id"])) == (403, "FORBIDDEN", "This batch is only for workers in a qualified group.")

    sign_in(client, "requester")
    client.post(f"/api/pools/{pool['id']}/workers", json={"workerIds": [worker["worker_id"]]})
    client.post("/api/workers/block", json={"ids": [worker["worker_id"]], "reason": "Spam."})
    sign_in(client, "worker")
    assert client.get(GROUPS).json()["groups"] == []   # 차단한 Requester 의 batch 는 pool 에 있어도 받을 수 없다
    assert error_of(accept(client, open_batch["id"]))[:2] == (403, "FORBIDDEN")


def test_other_requesters_batches_stay_open(client: TestClient) -> None:
    sign_in(client, "requester", email="a@example.com")
    worker = sign_in(client, "worker")
    sign_in(client, "requester", email="a@example.com")
    client.post("/api/workers/block", json={"ids": [worker["worker_id"]], "reason": "Spam."})
    template = client.post("/api/templates", json={"name": "A", "html": TASK_DATA_HTML}).json()
    request = {"name": "by A", "templateId": template["id"], "inputColumns": ["item_id"], "rows": [{"item_id": "a"}],
               "settings": SETTINGS, "requiredPoolIds": [], "excludedPoolIds": []}
    by_a = client.post("/api/batches", json=request).json()
    sign_in(client, "requester", email="b@example.com")
    by_b = client.post("/api/batches", json={**request, "name": "by B"}).json()

    sign_in(client, "worker")
    assert [g["batchId"] for g in client.get(GROUPS).json()["groups"]] == [by_b["id"]]
    assert accept(client, by_b["id"]).status_code == 200
    assert accept(client, by_a["id"]).status_code == 403


# ---- 내 HIT 목록과 접근 ------------------------------------------------------------------------------


def test_my_assignments_and_earnings(client: TestClient) -> None:
    batch = publish(client)
    sign_in(client, "worker")
    ids = []
    for _ in range(2):
        assignment = accept(client, batch["id"]).json()["assignment"]
        client.post(f"{MINE}/{assignment['assignmentId']}/submit", json={"answers": ANSWERS})
        ids.append(assignment["assignmentId"])
    worker_token = client.cookies.get("mturk_session")

    sign_in(client, "requester")
    client.post("/api/assignments/approve", json={"ids": [ids[0]], "feedback": "Thanks!"})
    client.post("/api/assignments/reject", json={"ids": [ids[1]], "feedback": "Wrong attention answer."})
    client.cookies.clear()
    client.cookies.set("mturk_session", worker_token)

    mine = client.get(MINE).json()
    assert [(a["assignmentId"], a["status"], a["feedback"]) for a in mine["assignments"]] == [
        (ids[1], "Rejected", "Wrong attention answer."), (ids[0], "Approved", "Thanks!")]
    assert mine["summary"] == {"inProgress": 0, "submitted": 0, "approved": 1, "rejected": 1,
                               "approvedReward": "$0.10", "pendingReward": "$0.00"}


def test_access_rules(client: TestClient) -> None:
    batch = publish(client)
    assert client.get(GROUPS).status_code == 403   # requester 는 worker API 를 부를 수 없다
    sign_in(client, "worker", email="first@example.com")
    assignment = accept(client, batch["id"]).json()["assignment"]
    assert error_of(client.post(f"{MINE}/{assignment['assignmentId']}/submit", json={"answers": []}))[2] == "No answers were submitted."
    assert error_of(client.post(f"{MINE}/{assignment['assignmentId']}/submit", json={}))[2] == "No answers were submitted."
    sign_in(client, "worker", email="second@example.com")
    assert client.get(f"{MINE}/{assignment['assignmentId']}").status_code == 404   # 다른 worker 의 assignment 는 없는 것으로
    assert client.post(f"{MINE}/{assignment['assignmentId']}/return").status_code == 404
    assert accept(client, "batch-0").status_code == 404
    client.cookies.clear()
    assert client.get(GROUPS).status_code == 401
