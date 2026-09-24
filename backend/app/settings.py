"""환경변수 → Settings. 컨테이너에서는 docker-compose.yml 의 backend 서비스가 값을 준다 (DATA_DIR=/app/data 처럼).

호스트에서 그냥 띄울 때의 기본값은 이 파일의 위치(backend/app/settings.py)에서 저장소 루트를 찾아 정한다.
특정 PC 의 절대 경로는 어디에도 적지 않는다.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ALLOW_API_VARIABLE = "AGENT_ALLOW_API"


def _path(name: str, default: Path) -> Path:
    value = os.environ.get(name, "").strip()
    return Path(value) if value else default


@dataclass(frozen=True)
class Settings:
    data_dir: Path      # 시작 데이터 (data/)
    db_path: Path       # SQLite 파일. 비어 있으면 data_dir 로 채운다
    output_dir: Path    # agent job 의 입력과 결과 (<output_dir>/jobs/<job id>/)
    models_dir: Path    # 모델 설정 yaml (environment/models/)
    env_file: Path      # OPENROUTER_KEY, AGENT_MODEL 이 든 env 파일 (environment/.env)
    api_allowed: bool   # AGENT_ALLOW_API == "1" 일 때만 OpenRouter 호출을 허용한다

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            data_dir=_path("DATA_DIR", REPO_ROOT / "data"),
            db_path=_path("DB_PATH", REPO_ROOT / "var" / "backend.sqlite"),
            output_dir=_path("OUTPUT_DIR", REPO_ROOT / "output"),
            models_dir=_path("MODELS_DIR", REPO_ROOT / "environment" / "models"),
            env_file=_path("ENV_FILE", REPO_ROOT / "environment" / ".env"),
            api_allowed=os.environ.get(ALLOW_API_VARIABLE, "").strip() == "1",
        )

    @property
    def jobs_dir(self) -> Path:
        return self.output_dir / "jobs"
