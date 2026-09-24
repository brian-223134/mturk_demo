"""오류 봉투. prototype/server/app.ts 와 같은 모양이다: 상태 코드는 code 로 정하고 본문은 {"error": {"code", "message"}}.

    400 INVALID_REQUEST   잘못된 요청 (FastAPI 의 422 검증 오류도 여기로 바꾼다)
    404 NOT_FOUND         없는 자원, 없는 경로
    501 NOT_IMPLEMENTED   경로 표에는 있지만 아직 구현하지 않은 경로 (routers/console.py 의 stub)
    500 UNKNOWN           그 밖의 예외
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("backend")

STATUS = {
    "NOT_FOUND": 404,
    "INVALID_REQUEST": 400,
    "NOT_IMPLEMENTED": 501,
    "NETWORK": 502,
    "UNKNOWN": 500,
}


class ApiError(Exception):
    """핸들러가 던지는 오류. code 는 STATUS 의 키다."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code if code in STATUS else "UNKNOWN"
        self.message = message


def invalid(message: str) -> ApiError:
    return ApiError("INVALID_REQUEST", message)


def not_found(what: str, id: str) -> ApiError:
    return ApiError("NOT_FOUND", f"{what} not found: {id}")


def error_response(code: str, message: str, status: int | None = None) -> JSONResponse:
    return JSONResponse(
        status_code=status or STATUS.get(code, 500),
        content={"error": {"code": code, "message": message}},
        headers={"Cache-Control": "no-store"},
    )


def _describe_validation(errors: Any) -> str:
    parts = []
    for item in errors or []:
        location = ".".join(str(p) for p in item.get("loc", []) if p != "body")
        parts.append(f"{location}: {item.get('msg')}" if location else str(item.get("msg")))
    return "; ".join(parts) or "Invalid request."


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def on_api_error(request: Request, error: ApiError) -> JSONResponse:
        return error_response(error.code, error.message)

    @app.exception_handler(RequestValidationError)
    async def on_validation_error(request: Request, error: RequestValidationError) -> JSONResponse:
        return error_response("INVALID_REQUEST", _describe_validation(error.errors()))

    @app.exception_handler(StarletteHTTPException)
    async def on_http_error(request: Request, error: StarletteHTTPException) -> JSONResponse:
        # 경로 표에 없는 경로(404)와 메서드가 다른 경로(405)는 prototype 처럼 NOT_FOUND 로 알린다
        if error.status_code in (404, 405):
            return error_response("NOT_FOUND", f"No such route: {request.method} {request.url.path}")
        code = {400: "INVALID_REQUEST", 501: "NOT_IMPLEMENTED"}.get(error.status_code, "UNKNOWN")
        return error_response(code, str(error.detail), error.status_code)

    @app.exception_handler(Exception)
    async def on_unknown_error(request: Request, error: Exception) -> JSONResponse:
        log.exception("unhandled error in %s %s", request.method, request.url.path)
        return error_response("UNKNOWN", f"{type(error).__name__}: {error}")
