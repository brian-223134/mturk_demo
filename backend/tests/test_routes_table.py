"""app/routes.py 의 경로 표가 prototype/src/api/http/routes.ts 의 API_ROUTES 와 키 하나하나 같은지 대조한다.

routes.ts 는 실제 백엔드의 계약서다. 두 표가 어긋나면 화면(frontend)이 부르는 경로와 서버가 받는 경로가 달라지므로,
이름, 메서드, 경로, 인자 순서를 모두 비교하고, 표의 경로가 전부 FastAPI 앱에 등록되어 있는지(OpenAPI 문서와 실제 요청으로),
mock 환경 전용 MOCK_ROUTES 는 등록되어 있지 않은지도 본다.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routes import API_PREFIX, API_ROUTES, fastapi_path, path_param_names
from helpers import ROUTES_TS, parse_ts_routes

NO_SUCH_ROUTE = "No such route: "


@pytest.fixture(scope="module")
def routes_ts() -> str:
    assert ROUTES_TS.is_file(), f"routes.ts not found: {ROUTES_TS}"
    return ROUTES_TS.read_text(encoding="utf-8")


def probe(client: TestClient, method: str, path: str):
    """경로 인자에 임시 값을 넣어 실제로 요청한다. POST 와 PUT 에는 빈 JSON body 를 보낸다."""
    url = path.format(**{name: "x" for name in path_param_names(path.replace("{", ":").replace("}", ""))})
    if method in ("POST", "PUT"):
        return client.request(method, url, json={})
    return client.request(method, url)


def is_unrouted(response) -> bool:
    """라우터가 받지 못한 요청: 404 NOT_FOUND 봉투에 "No such route" 메시지 (자원이 없는 404 와 구분한다)."""
    if response.status_code != 404:
        return False
    body = response.json()
    return body["error"]["code"] == "NOT_FOUND" and body["error"]["message"].startswith(NO_SUCH_ROUTE)


def test_api_routes_match_routes_ts(routes_ts: str) -> None:
    """이름, 메서드, 경로, 인자 순서가 routes.ts 의 API_ROUTES 와 같다 (표의 순서까지)."""
    expected = parse_ts_routes(routes_ts, "API_ROUTES")
    assert expected, "routes.ts parsing found no API_ROUTES"
    actual = {name: (route.method, route.path, route.args) for name, route in API_ROUTES.items()}
    for name, definition in expected.items():
        assert name in actual, f"{name} is in routes.ts but not in app/routes.py"
        assert actual[name] == definition, f"{name} differs from routes.ts"
    assert set(actual) == set(expected), "app/routes.py has routes that are not in routes.ts"
    assert list(actual) == list(expected), "the order of the routes differs from routes.ts"


def test_fastapi_path_conversion() -> None:
    assert fastapi_path("/batches/:batchId/hits") == "/batches/{batchId}/hits"
    assert path_param_names("/pools/:poolId/workers/remove") == ["poolId"]
    assert path_param_names("/account") == []


def test_every_table_route_is_registered(app: FastAPI, client: TestClient) -> None:
    """표의 모든 경로가 /api 아래에 같은 메서드와 이름(operationId)으로 등록되어 있고, 실제 요청도 라우터가 받는다. health 도 있다."""
    paths = app.openapi()["paths"]
    for name, route in API_ROUTES.items():
        path = API_PREFIX + fastapi_path(route.path)
        assert path in paths, f"{name}: {path} is not in the OpenAPI document"
        operation = paths[path].get(route.method.lower())
        assert operation is not None, f"{name}: {route.method} {path} is not registered"
        assert operation["operationId"] == name
        assert not is_unrouted(probe(client, route.method, path)), f"{name}: {route.method} {path} is not routed"
    assert "get" in paths[f"{API_PREFIX}/health"]
    assert client.get(f"{API_PREFIX}/health").status_code == 200


def test_mock_routes_are_not_registered(app: FastAPI, client: TestClient, routes_ts: str) -> None:
    """MOCK_ROUTES(/mock/*)는 mock 환경 전용이라 만들지 않는다: OpenAPI 문서에도 없고, 부르면 404 NOT_FOUND 봉투다."""
    mock_routes = parse_ts_routes(routes_ts, "MOCK_ROUTES")
    assert mock_routes, "routes.ts has no MOCK_ROUTES"
    paths = app.openapi()["paths"]
    for name, (method, path, _args) in mock_routes.items():
        assert path.startswith("/mock/")
        full = API_PREFIX + fastapi_path(path)
        assert method.lower() not in paths.get(full, {}), f"{name} must not be registered"
        assert is_unrouted(probe(client, method, full)), f"{name}: {method} {full} must not be routed"
