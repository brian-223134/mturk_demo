"""Create 화면의 REST: saveTemplate, deleteTemplate, createBatch, listPools (app/routers/create.py).

기대값은 prototype/src/api/mock/handlers.test.ts 의 "게시 (5.2, 7.2)" 와 "Review 의 대조 기준" 절, server.test.ts,
docs/creating-a-batch.md 의 "게시하면 서버가 값을 다시 검사합니다" 목록에서 온 것이다.
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from helpers import DATA_DIR, SETTINGS, error_of, list_query, sample_batch_request

# example/1-task-data 와 같은 모양의 작은 예시 (컨테이너의 테스트에는 example/ 이 mount 되지 않아 여기에 둔다):
# window.TASK_DATA 방식이라 placeholder 가 없는 템플릿과, 컬럼이 같은 CSV 행 10개. 긴 passage 는 목록에서 200자로 잘린다.
EXAMPLE_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sentence-passage relevance</title></head>
<body><crowd-form><script>var row = window.TASK_DATA; document.write(row.passage);</script></crowd-form></body></html>
"""
EXAMPLE_COLUMNS = ["item_id", "passage", "sentence_1", "sentence_2", "attention_sentence"]
EXAMPLE_ROWS = [
    {"item_id": f"s{i:02d}", "passage": f"Passage {i}. " + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. " * 6,
     "sentence_1": f"Sentence one of item {i}.", "sentence_2": f"Sentence two of item {i}.",
     "attention_sentence": 'This is an attention check. Please select "Not grounded" for this sentence.'}
    for i in range(1, 11)
]


# ---- templates --------------------------------------------------------------------------------


def test_save_template_new_and_update(client: TestClient) -> None:
    """새 템플릿은 tpl-<slug> id 를 받고 placeholders 와 updatedAt 이 계산된다. 같은 이름이면 -2 가 붙는다. id 를 주면 덮어쓴다."""
    html = EXAMPLE_HTML
    created = client.post("/api/templates", json={"name": "  Sentence-passage relevance (sample) ", "html": html})
    assert created.status_code == 200
    template = created.json()
    assert template["id"] == "tpl-sentence-passage-relevance-sample"
    assert template["name"] == "Sentence-passage relevance (sample)"
    assert template["placeholders"] == []          # window.TASK_DATA 방식이라 placeholder 가 없다
    assert template["updatedAt"].endswith("Z") and "T" in template["updatedAt"]
    assert client.get(f"/api/templates/{template['id']}").json() == template

    second = client.post("/api/templates", json={"name": "Sentence-passage relevance (sample)", "html": html}).json()
    assert second["id"] == "tpl-sentence-passage-relevance-sample-2"

    updated = client.post("/api/templates", json={"id": template["id"], "name": "Renamed", "html": "<p>${passage} ${sentence_1} ${passage}</p>"})
    assert updated.status_code == 200
    assert updated.json()["id"] == template["id"]
    assert updated.json()["name"] == "Renamed"
    assert updated.json()["placeholders"] == ["passage", "sentence_1"]
    assert updated.json()["updatedAt"] >= template["updatedAt"]
    assert [t["id"] for t in client.get("/api/templates").json()][:2] == [template["id"], second["id"]]   # updatedAt 내림차순


def test_save_template_validation(client: TestClient) -> None:
    assert error_of(client.post("/api/templates", json=[1])) == (400, "INVALID_REQUEST", '"template" must be a JSON object.')
    assert error_of(client.post("/api/templates", json={"name": 1, "html": "<p>x</p>"})) == (400, "INVALID_REQUEST", '"name" and "html" must be strings.')
    assert error_of(client.post("/api/templates", json={"name": "  ", "html": "<p>x</p>"})) == (400, "INVALID_REQUEST", "Template name is required.")
    assert error_of(client.post("/api/templates", json={"name": "x", "html": " "})) == (400, "INVALID_REQUEST", "Template HTML is empty.")
    assert error_of(client.post("/api/templates", json={"id": "tpl-nope", "name": "x", "html": "<p>x</p>"})) == (404, "NOT_FOUND", "Template not found: tpl-nope")
    broken = client.post("/api/templates", content=b"{broken", headers={"Content-Type": "application/json"})
    assert error_of(broken) == (400, "INVALID_REQUEST", "Request body is not valid JSON.")
    assert client.get("/api/health").json()["counts"]["templates"] == 2


def test_delete_template(client: TestClient) -> None:
    """지우면 204, 없으면 404. 게시된 batch 의 templateHtml 사본은 그대로다."""
    request = sample_batch_request(client)
    batch = client.post("/api/batches", json=request).json()
    client.post("/api/templates", json={"id": request["templateId"], "name": "Sample relevance", "html": "<p>changed ${passage}</p>"})
    assert client.get(f"/api/templates/{request['templateId']}").json()["placeholders"] == ["passage"]

    response = client.delete(f"/api/templates/{request['templateId']}")
    assert response.status_code == 204 and response.content == b""
    assert error_of(client.get(f"/api/templates/{request['templateId']}")) == (404, "NOT_FOUND", f"Template not found: {request['templateId']}")
    assert error_of(client.delete(f"/api/templates/{request['templateId']}"))[0] == 404
    assert "TASK_DATA" in client.get(f"/api/batches/{batch['id']}").json()["batch"]["templateHtml"]


# ---- createBatch ------------------------------------------------------------------------------


def test_create_batch_makes_hits_and_holds_the_cost(client: TestClient) -> None:
    """행 수만큼 HIT 를 만들고 모든 자리가 열린 상태로 둔다. 비용은 잔액에서 미리 빠진다 (10 × 3 × $0.12 = $3.60)."""
    request = sample_batch_request(client)
    response = client.post("/api/batches", json=request)
    assert response.status_code == 200, response.text
    batch = response.json()
    assert batch["id"].startswith("batch-") and len(batch["id"]) == len("batch-1000000")
    assert batch["name"] == "demo batch" and batch["env"] == "mock"
    assert batch["templateId"] == request["templateId"] and "TASK_DATA" in batch["templateHtml"]
    assert batch["inputColumns"] == ["item_id", "passage"]
    assert batch["settings"] == SETTINGS
    assert batch["attentionRule"] == request["attentionRule"]
    assert batch["reference"] == {"source": "majority"}
    assert batch["answerSchema"] == request["answerSchema"]
    assert batch["createdAt"].endswith("Z")

    listed = client.get("/api/batches").json()
    assert listed[0]["batch"]["id"] == batch["id"]                  # 최근 batch 가 맨 위
    assert listed[0]["status"] == "in_progress" and listed[0]["needsReview"] is False
    assert listed[0]["progress"] == {"hitsTotal": 10, "hitsCompleted": 0, "submitted": 0, "approved": 0, "rejected": 0, "open": 30, "rejectRate": None}
    assert listed[0]["cost"] == {"spentCents": 0, "estimatedCents": 30 * 12}

    hits = client.get(f"/api/batches/{batch['id']}/hits", params=list_query(page_size=100, sort="rowIndex:asc")).json()
    assert hits["total"] == 10
    assert [h["inputPreview"]["item_id"] for h in hits["items"]] == [r["item_id"] for r in request["rows"]]
    assert all(h["HITStatus"] == "Assignable" and h["initialMaxAssignments"] == 3 and h["MaxAssignments"] == 3 for h in hits["items"])
    assert all(h["NumberOfAssignmentsAvailable"] == 3 and h["expired"] is False and h["batchId"] == batch["id"] for h in hits["items"])
    assert all(len(h["HITId"]) == 30 and h["HITId"].startswith("3") for h in hits["items"])
    assert len({h["HITId"] for h in hits["items"]}) == 10
    full = client.get(f"/api/hits/{hits['items'][3]['HITId']}").json()
    assert full["input"] == {"item_id": "s3", "passage": "passage 3"} and full["rowIndex"] == 3
    assert client.get("/api/account").json()["AvailableBalance"] == "496.40"
    assert client.get("/api/health").json()["counts"] == {"templates": 3, "batches": 4, "hits": 82, "assignments": 231, "pools": 2, "workers": 60}


def test_create_batch_with_example_shaped_data_and_reference_column(client: TestClient) -> None:
    """example/1-task-data 모양의 템플릿과 CSV 행 10개, 기본 설정으로 게시한다. reference column 은 저장되고, Reward 는 두 자리로,
    MaxAssignments 3.0 은 3 으로 정리된다. 긴 셀은 목록에서 200자 + … 로 잘리고 getHit 은 전체를 준다."""
    template = client.post("/api/templates", json={"name": "Sentence-passage relevance (sample)", "html": EXAMPLE_HTML}).json()
    request = {
        "name": "Sentence-passage relevance (sample) 2026-09-25", "templateId": template["id"], "rows": EXAMPLE_ROWS,
        "inputColumns": EXAMPLE_COLUMNS, "settings": {**SETTINGS, "Reward": "0.1", "MaxAssignments": 3.0},
        "attentionRule": None, "reference": {"source": "column", "column": "sentence_1"},
        "requiredPoolIds": ["pool-trusted"], "excludedPoolIds": ["pool-excluded"],
    }
    batch = client.post("/api/batches", json=request).json()
    assert batch["settings"]["Reward"] == "0.10" and batch["settings"]["MaxAssignments"] == 3
    assert batch["reference"] == {"source": "column", "column": "sentence_1"}
    assert batch["attentionRule"] is None and "answerSchema" not in batch
    assert batch["requiredPoolIds"] == ["pool-trusted"] and batch["excludedPoolIds"] == ["pool-excluded"]
    detail = client.get(f"/api/batches/{batch['id']}").json()
    assert detail["batch"]["templateHtml"] == EXAMPLE_HTML
    assert detail["progress"]["hitsTotal"] == len(EXAMPLE_ROWS) == 10
    hit = client.get(f"/api/batches/{batch['id']}/hits", params=list_query(page_size=1)).json()["items"][0]
    assert hit["inputPreview"]["passage"].endswith("…") and len(hit["inputPreview"]["passage"]) == 201
    assert hit["inputPreview"]["item_id"] == "s01"
    assert client.get(f"/api/hits/{hit['HITId']}").json()["input"] == EXAMPLE_ROWS[0]
    assert client.get("/api/account").json()["AvailableBalance"] == "496.40"


def test_create_batch_validation_messages(client: TestClient) -> None:
    """서버가 다시 검사하는 항목마다 프로토타입과 같은 문구로 400 (또는 없는 자원이면 404). 실패하면 아무것도 만들지 않는다."""
    request = sample_batch_request(client)
    settings = request["settings"]

    def attempt(**changes) -> tuple[int, str, str]:
        return error_of(client.post("/api/batches", json={**request, **changes}))

    assert error_of(client.post("/api/batches", json=[1])) == (400, "INVALID_REQUEST", '"batch" must be a JSON object.')
    assert error_of(client.post("/api/batches")) == (400, "INVALID_REQUEST", '"batch" must be a JSON object.')
    assert attempt(settings=None) == (400, "INVALID_REQUEST", '"settings" must be a JSON object.')
    assert attempt(inputColumns="x") == (400, "INVALID_REQUEST", '"inputColumns" must be an array of strings.')
    assert attempt(requiredPoolIds=[1]) == (400, "INVALID_REQUEST", '"requiredPoolIds" must be an array of strings.')
    assert attempt(reference={"source": "nope"}) == (400, "INVALID_REQUEST", '"reference.source" must be "majority" or "column".')
    assert attempt(reference={"source": "column"}) == (400, "INVALID_REQUEST", '"reference.column" must be a column name.')
    assert attempt(reference={"source": "column", "column": "no_such_column"}) == (400, "INVALID_REQUEST", 'Reference column "no_such_column" is not one of the CSV columns.')
    assert attempt(settings={**settings, "QualificationRequirements": [{"x": 1}]}) == (400, "INVALID_REQUEST", '"QualificationRequirements[].QualificationTypeId" must be an array of strings.')
    assert attempt(name="  ") == (400, "INVALID_REQUEST", "Batch name is required.")
    assert attempt(templateId="tpl-nope") == (404, "NOT_FOUND", "Template not found: tpl-nope")
    assert attempt(rows=[]) == (400, "INVALID_REQUEST", "The CSV has no rows.")
    assert attempt(rows=[1]) == (400, "INVALID_REQUEST", '"rows" must be an array of objects.')
    status, code, message = attempt(templateId="tpl-chunk-fact-relevance")
    assert (status, code) == (400, "INVALID_REQUEST") and message.startswith("The CSV is missing columns used by the template: ${idx}, ${qid}")
    assert attempt(settings={**settings, "Title": " "}) == (400, "INVALID_REQUEST", "Title is required.")
    assert attempt(settings={**settings, "MaxAssignments": 0}) == (400, "INVALID_REQUEST", "MaxAssignments must be an integer ≥ 1.")
    assert attempt(settings={**settings, "MaxAssignments": 2.5}) == (400, "INVALID_REQUEST", "MaxAssignments must be an integer ≥ 1.")
    for field in ("AssignmentDurationInSeconds", "LifetimeInSeconds", "AutoApprovalDelayInSeconds"):
        assert attempt(settings={**settings, field: 0}) == (400, "INVALID_REQUEST", f"{field} must be greater than 0.")
        assert attempt(settings={**settings, field: "1800"}) == (400, "INVALID_REQUEST", f"{field} must be greater than 0.")
    assert attempt(settings={**settings, "AutoApprovalDelayInSeconds": 31 * 86400}) == (400, "INVALID_REQUEST", "AutoApprovalDelayInSeconds cannot exceed 30 days.")
    assert attempt(settings={**settings, "Reward": "abc"}) == (400, "INVALID_REQUEST", 'Reward is not a valid amount: "abc"')
    assert attempt(settings={**settings, "Reward": "0.001"}) == (400, "INVALID_REQUEST", "Reward must be at least $0.01.")
    assert attempt(requiredPoolIds=["pool-nope"]) == (404, "NOT_FOUND", "Pool not found: pool-nope")
    assert attempt(excludedPoolIds=["pool-nope"]) == (404, "NOT_FOUND", "Pool not found: pool-nope")
    assert attempt(settings={**settings, "Reward": "20.00"}) == (400, "INVALID_REQUEST", "Insufficient balance: this needs $720.00 but only $500.00 is available.")

    assert len(client.get("/api/batches").json()) == 3          # 아무것도 만들지 않았다
    assert client.get("/api/account").json()["AvailableBalance"] == "500.00"


def test_create_batch_big_rows(client: TestClient) -> None:
    """server.test.ts: 셀 하나가 100KB 인 행 20개도 게시되고 getHit 은 전체를 돌려준다."""
    template = client.post("/api/templates", json={"name": "Big", "html": "<html><head></head><body>x</body></html>"}).json()
    batch = client.post("/api/batches", json={
        "name": "big rows", "templateId": template["id"], "inputColumns": ["text"],
        "rows": [{"text": "x" * 100_000} for _ in range(20)],
        "settings": {**SETTINGS, "Reward": "0.05", "LifetimeInSeconds": 86400, "AutoApprovalDelayInSeconds": 86400},
        "attentionRule": None, "requiredPoolIds": [], "excludedPoolIds": [],
    }).json()
    hits = client.get(f"/api/batches/{batch['id']}/hits", params=list_query(page_size=5)).json()
    assert hits["total"] == 20 and len(hits["items"]) == 5
    assert len(client.get(f"/api/hits/{hits['items'][0]['HITId']}").json()["input"]["text"]) == 100_000


# ---- listPools --------------------------------------------------------------------------------


def test_list_pools(client: TestClient) -> None:
    assert client.get("/api/pools").json() == json.loads((DATA_DIR / "pools.json").read_text(encoding="utf-8"))
    assert [p["id"] for p in client.get("/api/pools").json()] == ["pool-trusted", "pool-excluded"]
