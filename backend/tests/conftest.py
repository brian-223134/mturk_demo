"""backend 테스트의 공통 fixture.

앱은 create_app(Settings(...)) 으로 만든다. DB 는 TEST_DATABASE_URL 의 PostgreSQL 에 테스트마다 schema 를 새로 만들어 쓰고
(search_path 를 그 schema 로) 끝나면 지운다. agent job 출력은 pytest 의 tmp_path 에 두고, 시작 데이터는 저장소의 data/,
모델 설정은 environment/models/ 를 읽는다. 실제 environment/.env 는 읽지 않고 임시 env 파일을 쓰며, OpenRouter 는
어떤 테스트에서도 부르지 않는다 (api_allowed=False). client fixture 는 TestClient 를 context manager 로 열어 lifespan
(스키마 이전, DB seed, job worker 시작)까지 돈다.

    docker compose run --rm backend-test                       db-test 컨테이너가 함께 뜬다 (TEST_DATABASE_URL 은 compose 가 준다)
    TEST_DATABASE_URL=postgresql://mturk:mturk@127.0.0.1:5433/mturk_test pytest -q    호스트에서 (docker compose --profile test up -d db-test)
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Callable, Iterator

import psycopg
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from psycopg import sql
from psycopg.conninfo import make_conninfo

from app.db import Database
from app.main import create_app
from app.settings import Settings
from helpers import DATA_DIR, MODELS_DIR


@pytest.fixture(scope="session")
def admin_url() -> str:
    """테스트용 PostgreSQL. schema 를 만들고 지울 권한이 있어야 한다."""
    url = os.environ.get("TEST_DATABASE_URL", "").strip()
    if not url:
        pytest.fail("TEST_DATABASE_URL is not set. Run the tests with `docker compose run --rm backend-test`, or start the "
                    "test database (`docker compose --profile test up -d db-test`) and set "
                    "TEST_DATABASE_URL=postgresql://mturk:mturk@127.0.0.1:5433/mturk_test", pytrace=False)
    return url


@pytest.fixture
def database_url(admin_url: str) -> Iterator[str]:
    """이 테스트만 쓰는 schema 에 붙는 접속 정보. 끝나면 schema 를 통째로 지운다."""
    schema = f"test_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(admin_url, autocommit=True) as connection:
        connection.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
    try:
        yield make_conninfo(admin_url, options=f"-c search_path={schema}")
    finally:
        with psycopg.connect(admin_url, autocommit=True) as connection:
            connection.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


@pytest.fixture
def make_database(database_url: str) -> Iterator[Callable[..., Database]]:
    """Database 를 직접 만들 때. 테스트가 끝나면 연 pool 을 모두 닫는다."""
    opened: list[Database] = []

    def build(data_dir: Path = DATA_DIR, url: str | None = None) -> Database:
        db = Database(url or database_url, data_dir)
        opened.append(db)
        return db

    yield build
    for db in opened:
        db.close()


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """agent 가 읽는 환경변수를 지운다. 모델 이름은 임시 env 파일에서만, 키는 없이, API 호출은 불허 상태로 시험한다."""
    for name in ("AGENT_MODEL", "OPENROUTER_KEY", "AGENT_ALLOW_API"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def env_file(tmp_path: Path) -> Path:
    """environment/.env 대신 쓰는 파일. 키는 없고 모델 이름만 있다."""
    path = tmp_path / "test.env"
    path.write_text("AGENT_MODEL=default\n", encoding="utf-8")
    return path


@pytest.fixture
def make_settings(tmp_path: Path, env_file: Path, database_url: str) -> Callable[..., Settings]:
    """Settings 를 만든다. 인자로 일부 값을 바꿀 수 있다 (data_dir=깨진 폴더 처럼)."""

    def build(**overrides) -> Settings:
        values = dict(
            data_dir=DATA_DIR,
            database_url=database_url,
            output_dir=tmp_path / "output",
            models_dir=MODELS_DIR,
            env_file=env_file,
            api_allowed=False,
        )
        values.update(overrides)
        return Settings(**values)

    return build


@pytest.fixture
def settings(make_settings: Callable[..., Settings]) -> Settings:
    return make_settings()


@pytest.fixture
def app(settings: Settings) -> FastAPI:
    return create_app(settings)


@pytest.fixture
def client(app: FastAPI):
    """lifespan 을 돌린 TestClient. with 를 벗어나면 job worker 를 멈춘다."""
    with TestClient(app) as client:
        yield client


@pytest.fixture
def make_client(make_settings: Callable[..., Settings]) -> Callable[..., TestClient]:
    """설정을 바꿔 앱을 여러 번 만들 때 (같은 DB 나 output 폴더를 다시 여는 시험). `with make_client() as c:` 로 쓴다."""

    def build(**overrides) -> TestClient:
        return TestClient(create_app(make_settings(**overrides)))

    return build
