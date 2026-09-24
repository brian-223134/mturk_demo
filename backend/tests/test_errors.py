"""오류 봉투 (app/errors.py). 작은 임시 앱에 경로를 몇 개 붙여 예외 → {"error": {"code", "message"}} 변환을 확인한다.

    ApiError(code)            STATUS 의 상태 코드, 모르는 code 는 UNKNOWN 500
    RequestValidationError    FastAPI 의 422 → 400 INVALID_REQUEST
    HTTPException 404/405     NOT_FOUND (없는 경로, 다른 메서드)
    그 밖의 예외               500 UNKNOWN
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.errors import STATUS, ApiError, install_error_handlers, invalid, not_found


def build_app() -> FastAPI:
    app = FastAPI()
    install_error_handlers(app)

    @app.get("/api-error/{code}")
    async def raise_api_error(code: str) -> None:
        raise ApiError(code, f"raised {code}")

    @app.get("/not-found")
    async def raise_not_found() -> None:
        raise not_found("Thing", "t-1")

    @app.get("/invalid")
    async def raise_invalid() -> None:
        raise invalid("bad input")

    @app.get("/typed")
    async def typed(n: int) -> dict:
        return {"n": n}

    @app.get("/http/{status}")
    async def raise_http(status: int) -> None:
        raise HTTPException(status, "detail text")

    @app.get("/boom")
    async def boom() -> None:
        raise RuntimeError("kaboom")

    @app.get("/ok")
    async def ok() -> dict:
        return {"ok": True}

    return app


@pytest.fixture
def client() -> TestClient:
    # raise_server_exceptions=False: 500 이 응답으로 오게 한다 (기본은 테스트로 예외를 다시 던진다)
    return TestClient(build_app(), raise_server_exceptions=False)


@pytest.mark.parametrize("code, status", sorted(STATUS.items()))
def test_api_error_maps_code_to_status(client: TestClient, code: str, status: int) -> None:
    response = client.get(f"/api-error/{code}")
    assert response.status_code == status
    assert response.json() == {"error": {"code": code, "message": f"raised {code}"}}
    assert response.headers["cache-control"] == "no-store"


def test_unknown_code_becomes_unknown(client: TestClient) -> None:
    response = client.get("/api-error/WHATEVER")
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "UNKNOWN"


def test_helpers(client: TestClient) -> None:
    assert client.get("/not-found").json() == {"error": {"code": "NOT_FOUND", "message": "Thing not found: t-1"}}
    assert client.get("/not-found").status_code == 404
    assert client.get("/invalid").json() == {"error": {"code": "INVALID_REQUEST", "message": "bad input"}}
    assert client.get("/invalid").status_code == 400


def test_validation_error_becomes_400(client: TestClient) -> None:
    """FastAPI 의 422 검증 오류는 400 INVALID_REQUEST 봉투로 바꾸고, 메시지에 어느 인자가 문제인지 적는다."""
    assert client.get("/typed?n=3").json() == {"n": 3}
    response = client.get("/typed?n=abc")
    assert response.status_code == 400
    body = response.json()
    assert body["error"]["code"] == "INVALID_REQUEST"
    assert body["error"]["message"].startswith("query.n: ")
    missing = client.get("/typed")
    assert missing.status_code == 400
    assert missing.json()["error"]["message"].startswith("query.n: ")


def test_unknown_route_and_wrong_method(client: TestClient) -> None:
    for method, path in (("GET", "/no-such-route"), ("POST", "/ok"), ("DELETE", "/ok")):
        response = client.request(method, path)
        assert response.status_code == 404, (method, path)
        assert response.json() == {"error": {"code": "NOT_FOUND", "message": f"No such route: {method} {path}"}}


def test_http_exception_mapping(client: TestClient) -> None:
    assert client.get("/http/404").json()["error"]["code"] == "NOT_FOUND"
    assert client.get("/http/405").status_code == 404
    assert client.get("/http/400").json() == {"error": {"code": "INVALID_REQUEST", "message": "detail text"}}
    assert client.get("/http/501").json() == {"error": {"code": "NOT_IMPLEMENTED", "message": "detail text"}}
    teapot = client.get("/http/418")  # 그 밖의 상태는 상태 코드는 지키고 code 는 UNKNOWN
    assert teapot.status_code == 418
    assert teapot.json() == {"error": {"code": "UNKNOWN", "message": "detail text"}}


def test_unhandled_exception_becomes_500(client: TestClient) -> None:
    response = client.get("/boom")
    assert response.status_code == 500
    assert response.json() == {"error": {"code": "UNKNOWN", "message": "RuntimeError: kaboom"}}
    assert response.headers["cache-control"] == "no-store"
