"""FastAPI 앱. uvicorn app.main:app 으로 띄운다 (backend/Dockerfile).

    브라우저 ──▶ frontend (nginx, /api 프록시) ──▶ 이 앱 ──┬─▶ SQLite (DB_PATH), 비어 있으면 DATA_DIR 로 채움
                                                       └─▶ agent/ (import) → OUTPUT_DIR/jobs/<job id>/

create_app() 이 설정을 읽고 라우터와 오류 봉투, 요청 로그를 붙인다. DB 초기화와 job worker 는 lifespan 에서 시작한다.
"""

from __future__ import annotations

import logging
import sys
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app import __version__
from app.agent_jobs.runner import JobRunner
from app.db import Database
from app.errors import install_error_handlers
from app.routers.agent_jobs import router as agent_router
from app.routers.console import build_console_router
from app.routes import API_PREFIX
from app.settings import Settings

log = logging.getLogger("backend")


def configure_logging() -> None:
    """backend 로거를 stdout 에 한 줄씩 쓴다 (prototype 의 요청 로그와 같은 모양). uvicorn 의 로거는 건드리지 않는다."""
    if log.handlers:
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter("%(message)s"))
    log.addHandler(handler)
    log.setLevel(logging.INFO)
    log.propagate = False


class RequestLogMiddleware:
    """`GET /api/health → 200 (3 ms)` 처럼 요청마다 한 줄. 처리되지 않은 예외는 500 으로 적고 그대로 올린다."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = time.perf_counter()
        status = {"code": 0}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            status["code"] = status["code"] or 500
            raise
        finally:
            elapsed = (time.perf_counter() - started) * 1000
            log.info("%s %s → %s (%.0f ms)", scope.get("method"), scope.get("path"), status["code"], elapsed)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    configure_logging()
    db = Database(settings.db_path, settings.data_dir)
    runner = JobRunner(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        db.initialize()  # data/ 나 DB 에 문제가 있으면 여기서 바로 드러난다
        runner.start()
        counts = db.counts()
        log.info("backend %s  %s", __version__, f"{API_PREFIX}/health")
        log.info("  data    %s", settings.data_dir)
        log.info("  db      %s  (%s)", settings.db_path, "restored" if db.source == "snapshot" else "seeded from data/")
        log.info("  state   %s", ", ".join(f"{n} {k}" for k, n in counts.items()))
        log.info("  jobs    %s  (OpenRouter calls %s)", settings.jobs_dir,
                 "allowed: AGENT_ALLOW_API=1" if settings.api_allowed else "not allowed: AGENT_ALLOW_API is not 1")
        yield
        runner.stop()

    app = FastAPI(
        title="MTurk Console backend",
        version=__version__,
        lifespan=lifespan,
        docs_url=f"{API_PREFIX}/docs",
        openapi_url=f"{API_PREFIX}/openapi.json",
        redoc_url=None,
    )
    app.state.settings = settings
    app.state.db = db
    app.state.runner = runner
    install_error_handlers(app)
    app.add_middleware(RequestLogMiddleware)
    app.include_router(build_console_router(), prefix=API_PREFIX)
    app.include_router(agent_router, prefix=API_PREFIX)
    return app


app = create_app()
