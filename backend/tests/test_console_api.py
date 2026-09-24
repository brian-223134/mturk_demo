"""콘솔 REST (/api/…). data/ 로 seed 한 앱의 응답이 프로토타입 mock API 와 같은지 확인한다.

batch 의 기대값은 backend/README.md 의 확인 결과와 프로토타입의 data.test.ts, handlers.test.ts 에서 온 것이다:
    batch-1000001  40 HIT, assignment 132 (Approved 108, Rejected 18, Submitted 6), $0.05, 만료됨 → expired, needsReview
    batch-1000002  16 HIT, assignment 51 (Approved 48, Rejected 3), $0.05 → completed
    batch-1000003  16 HIT, assignment 48 (전부 Approved), $0.10 → completed
비용은 assignment 당 reward + 수수료(20%, 최소 1센트)로, $0.05 는 6센트, $0.10 은 12센트다.
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app.routers.console import IMPLEMENTED
from app.routes import API_PREFIX, API_ROUTES, fastapi_path
from helpers import DATA_DIR

EXPECTED_BATCHES = {
    "batch-1000003": {
        "status": "completed",
        "needsReview": False,
        "progress": {"hitsTotal": 16, "hitsCompleted": 16, "submitted": 0, "approved": 48, "rejected": 0, "open": 0,
                     "rejectRate": 0},
        "cost": {"spentCents": 576, "estimatedCents": 576},       # 48 × 12
    },
    "batch-1000002": {
        "status": "completed",
        "needsReview": False,
        "progress": {"hitsTotal": 16, "hitsCompleted": 16, "submitted": 0, "approved": 48, "rejected": 3, "open": 0,
                     "rejectRate": 3 / 51},
        "cost": {"spentCents": 288, "estimatedCents": 288},       # 48 × 6
    },
    "batch-1000001": {
        "status": "expired",
        "needsReview": True,
        "progress": {"hitsTotal": 40, "hitsCompleted": 36, "submitted": 6, "approved": 108, "rejected": 18, "open": 6,
                     "rejectRate": 18 / 126},
        "cost": {"spentCents": 648, "estimatedCents": 720},       # 108 × 6, (108 + 6 + 6) × 6
    },
}
# 목록은 createdAt 내림차순이다 (handlers.test.ts: 최근 batch 가 맨 위)
EXPECTED_ORDER = ["batch-1000003", "batch-1000002", "batch-1000001"]
BATCH_FIELDS = {"id", "name", "env", "templateId", "inputColumns", "settings", "attentionRule", "reference",
                "requiredPoolIds", "excludedPoolIds", "createdAt"}


def test_health(client: TestClient) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok", "source": "seed",
        "counts": {"templates": 2, "batches": 3, "hits": 72, "assignments": 231, "pools": 2, "workers": 60},
    }


def test_list_templates(client: TestClient) -> None:
    """프로토타입의 listTemplates 처럼 updatedAt 내림차순이고, html 과 placeholders 를 포함한다."""
    templates = client.get("/api/templates").json()
    assert [t["id"] for t in templates] == ["tpl-query-fact-coverage", "tpl-chunk-fact-relevance"]
    index = {entry["id"]: entry for entry in json.loads((DATA_DIR / "templates" / "index.json").read_text(encoding="utf-8"))}
    for template in templates:
        assert set(template) == {"id", "name", "html", "placeholders", "updatedAt"}
        entry = index[template["id"]]
        assert template["name"] == entry["name"] and template["updatedAt"] == entry["updatedAt"]
        assert template["html"] == (DATA_DIR / "templates" / entry["file"]).read_text(encoding="utf-8")
        assert len(template["placeholders"]) == 12


def test_get_template(client: TestClient) -> None:
    listed = client.get("/api/templates").json()[0]
    response = client.get(f"/api/templates/{listed['id']}")
    assert response.status_code == 200
    assert response.json() == listed

    missing = client.get("/api/templates/tpl-nope")
    assert missing.status_code == 404
    assert missing.json() == {"error": {"code": "NOT_FOUND", "message": "Template not found: tpl-nope"}}


def test_get_account(client: TestClient) -> None:
    response = client.get("/api/account")
    assert response.status_code == 200
    assert response.json() == json.loads((DATA_DIR / "account.json").read_text(encoding="utf-8"))
    assert response.json() == {"env": "mock", "AvailableBalance": "500.00"}


def test_list_batches(client: TestClient) -> None:
    """batch 마다 상태, needsReview, 진행률, 비용이 프로토타입과 같고, 목록에는 templateHtml 이 없다."""
    response = client.get("/api/batches")
    assert response.status_code == 200
    summaries = response.json()
    assert [s["batch"]["id"] for s in summaries] == EXPECTED_ORDER
    for summary in summaries:
        batch_id = summary["batch"]["id"]
        assert set(summary) == {"batch", "status", "needsReview", "progress", "cost"}
        assert {key: summary[key] for key in ("status", "needsReview", "progress", "cost")} == EXPECTED_BATCHES[batch_id], batch_id
        assert "templateHtml" not in summary["batch"]
        assert set(summary["batch"]) == BATCH_FIELDS
        assert summary["batch"] == {
            key: value for key, value in
            json.loads((DATA_DIR / "batches" / batch_id / "batch.json").read_text(encoding="utf-8")).items()
        }


def test_get_batch(client: TestClient) -> None:
    """상세는 목록과 같은 요약에 templateHtml(게시 시점의 템플릿 사본)이 더 있다."""
    listed = {s["batch"]["id"]: s for s in client.get("/api/batches").json()}
    for batch_id, expected in EXPECTED_BATCHES.items():
        response = client.get(f"/api/batches/{batch_id}")
        assert response.status_code == 200, batch_id
        detail = response.json()
        assert {key: detail[key] for key in ("status", "needsReview", "progress", "cost")} == expected
        html = detail["batch"].pop("templateHtml")
        assert html == (DATA_DIR / "batches" / batch_id / "template.html").read_text(encoding="utf-8")
        assert "<crowd-form>" in html
        assert detail == listed[batch_id]

    missing = client.get("/api/batches/batch-0")
    assert missing.status_code == 404
    assert missing.json() == {"error": {"code": "NOT_FOUND", "message": "Batch not found: batch-0"}}


def test_stubs_answer_501(client: TestClient) -> None:
    """경로 표에 있지만 아직 구현하지 않은 경로는 모두 501 NOT_IMPLEMENTED 봉투를 돌려준다."""
    stubs = [name for name in API_ROUTES if name not in IMPLEMENTED]
    assert len(stubs) == len(API_ROUTES) - 5
    for name in stubs:
        route = API_ROUTES[name]
        url = API_PREFIX + fastapi_path(route.path).format(**{param: "x" for param in _params(route.path)})
        if route.method in ("POST", "PUT"):
            response = client.request(route.method, url, json={})
        else:
            response = client.request(route.method, url)
        assert response.status_code == 501, (name, url, response.text)
        body = response.json()
        assert body["error"]["code"] == "NOT_IMPLEMENTED", name
        assert name in body["error"]["message"], name
        assert route.path.split("/:")[0] in body["error"]["message"], name


def _params(path: str) -> list[str]:
    return [part[1:] for part in path.split("/") if part.startswith(":")]


def test_unknown_route_and_method(client: TestClient) -> None:
    response = client.get("/api/no-such-thing")
    assert response.status_code == 404
    assert response.json() == {"error": {"code": "NOT_FOUND", "message": "No such route: GET /api/no-such-thing"}}
    wrong_method = client.delete("/api/health")
    assert wrong_method.status_code == 404
    assert wrong_method.json()["error"]["code"] == "NOT_FOUND"
    outside = client.get("/health")
    assert outside.status_code == 404
    assert outside.json()["error"]["code"] == "NOT_FOUND"


def test_bad_input_is_400_envelope(client: TestClient) -> None:
    """잘못된 요청은 상태 400 에 INVALID_REQUEST 봉투다 (multipart 가 아닌 본문을 업로드 경로에 보낸 경우)."""
    response = client.post("/api/agent/jobs", json={"raw": "not a file"})
    assert response.status_code == 400
    body = response.json()
    assert body["error"]["code"] == "INVALID_REQUEST"
    assert '"raw"' in body["error"]["message"]
    assert response.headers["cache-control"] == "no-store"


def test_openapi_is_served_under_api(client: TestClient) -> None:
    schema = client.get("/api/openapi.json").json()
    assert set(API_ROUTES) <= {op["operationId"] for methods in schema["paths"].values() for op in methods.values()}
    assert client.get("/api/docs").status_code == 200
