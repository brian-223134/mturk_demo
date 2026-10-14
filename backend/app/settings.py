"""환경변수 → Settings. 컨테이너에서는 docker-compose.yml 의 backend 서비스가 값을 준다 (DATA_DIR=/app/data 처럼).

호스트에서 그냥 띄울 때의 기본값은 이 파일의 위치(backend/app/settings.py)에서 저장소 루트를 찾아 정한다.
특정 PC 의 절대 경로는 어디에도 적지 않는다.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from agent.planner.openrouter import api_allowed

REPO_ROOT = Path(__file__).resolve().parents[2]
ALLOW_API_VARIABLE = "AGENT_ALLOW_API"
JOB_WORKERS_DEFAULT = 3   # 후보 3개(POST /api/agent/job-groups)가 한꺼번에 돌 수 있게
# 호스트에서 그냥 띄울 때의 접속 정보. docker compose 의 db 서비스가 127.0.0.1:5432 로 열려 있다고 본다 (개발용 계정)
DATABASE_URL_DEFAULT = "postgresql://mturk:mturk@127.0.0.1:5432/mturk"


def _path(name: str, default: Path) -> Path:
    value = os.environ.get(name, "").strip()
    return Path(value) if value else default


def _positive_int(name: str, default: int) -> int:
    value = os.environ.get(name, "").strip()
    try:
        return max(1, int(value)) if value else default
    except ValueError:
        return default


def _choice(name: str, choices: tuple[str, ...], default: str) -> str:
    value = os.environ.get(name, "").strip().lower()
    return value if value in choices else default


def _domains(name: str) -> tuple[str, ...]:
    """쉼표로 구분한 이메일 도메인 (앞의 @ 는 떼고 소문자로)."""
    parts = (part.strip().lower().lstrip("@") for part in os.environ.get(name, "").split(","))
    return tuple(part for part in parts if part)


WORKER_SIGNUP_CHOICES = ("open", "invite", "closed")


@dataclass(frozen=True)
class Settings:
    data_dir: Path      # 시작 데이터 (data/)
    database_url: str   # PostgreSQL 접속 정보 (DATABASE_URL). seed 기록이 없으면 data_dir 로 채운다
    output_dir: Path    # agent job 의 입력과 결과 (<output_dir>/jobs/<job id>/)
    models_dir: Path    # 모델 설정 yaml (environment/models/)
    env_file: Path      # OPENROUTER_KEY, AGENT_MODEL 이 든 env 파일 (environment/.env)
    api_allowed: bool   # OpenRouter 호출을 허용하는 서버 스위치. AGENT_ALLOW_API 환경변수, 없으면 env 파일의 같은 이름 (1/true/yes/on)
    job_workers: int = JOB_WORKERS_DEFAULT   # 동시에 도는 agent job 수 (AGENT_JOB_WORKERS)
    # 계정 (app/accounts.py). Requester 가입은 언제나 초대 코드가 있어야 한다
    worker_signup: str = "open"               # WORKER_SIGNUP: open(누구나) | invite(초대 코드) | closed(가입 막음)
    signup_email_domains: tuple[str, ...] = ()   # SIGNUP_EMAIL_DOMAINS: 비어 있으면 제한 없음
    session_idle_minutes: int = 480           # SESSION_IDLE_MINUTES: 이 시간 동안 요청이 없으면 로그아웃
    session_max_days: int = 2                 # SESSION_MAX_DAYS: 로그인 뒤 이 기간이 지나면 다시 로그인
    password_min_length: int = 8              # PASSWORD_MIN_LENGTH
    session_cookie_secure: bool = False       # SESSION_COOKIE_SECURE: https 로만 쿠키를 보낸다 (https 로 서비스할 때 1)

    @classmethod
    def from_env(cls) -> "Settings":
        env_file = _path("ENV_FILE", REPO_ROOT / "environment" / ".env")
        return cls(
            data_dir=_path("DATA_DIR", REPO_ROOT / "data"),
            database_url=os.environ.get("DATABASE_URL", "").strip() or DATABASE_URL_DEFAULT,
            output_dir=_path("OUTPUT_DIR", REPO_ROOT / "output"),
            models_dir=_path("MODELS_DIR", REPO_ROOT / "environment" / "models"),
            env_file=env_file,
            # 셸의 AGENT_ALLOW_API 가 있으면 그 값, 없으면 environment/.env 의 값. 서버를 띄울 때 한 번 읽는다
            api_allowed=api_allowed(env_file),
            job_workers=_positive_int("AGENT_JOB_WORKERS", JOB_WORKERS_DEFAULT),
            worker_signup=_choice("WORKER_SIGNUP", WORKER_SIGNUP_CHOICES, "open"),
            signup_email_domains=_domains("SIGNUP_EMAIL_DOMAINS"),
            session_idle_minutes=_positive_int("SESSION_IDLE_MINUTES", 480),
            session_max_days=_positive_int("SESSION_MAX_DAYS", 2),
            password_min_length=_positive_int("PASSWORD_MIN_LENGTH", 8),
            session_cookie_secure=os.environ.get("SESSION_COOKIE_SECURE", "").strip().lower() in ("1", "true", "yes", "on"),
        )

    @property
    def jobs_dir(self) -> Path:
        return self.output_dir / "jobs"
