"""backend 테스트의 공통 fixture.

앱은 create_app(Settings(...)) 으로 만든다. SQLite 와 agent job 출력은 pytest 의 tmp_path 에 두고, 시작 데이터는 저장소의
data/, 모델 설정은 environment/models/ 를 읽는다. 실제 environment/.env 는 읽지 않고 임시 env 파일을 쓰며, OpenRouter 는
어떤 테스트에서도 부르지 않는다 (api_allowed=False). client fixture 는 TestClient 를 context manager 로 열어 lifespan
(DB seed, job worker 시작)까지 돈다.
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings
from helpers import DATA_DIR, MODELS_DIR


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
def make_settings(tmp_path: Path, env_file: Path) -> Callable[..., Settings]:
    """Settings 를 만든다. 인자로 일부 값을 바꿀 수 있다 (data_dir=깨진 폴더 처럼)."""

    def build(**overrides) -> Settings:
        values = dict(
            data_dir=DATA_DIR,
            db_path=tmp_path / "var" / "backend.sqlite",
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
