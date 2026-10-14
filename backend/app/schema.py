"""스키마 이전(migration). backend/app/migrations/NNNN_이름.sql 을 이름순으로, 아직 적용하지 않은 것만 적용한다.

적용한 파일은 schema_migrations 에 남는다. 파일 하나는 트랜잭션 하나로 적용하므로, 도중에 실패하면 그 파일의 변경은 모두
되돌아가고 다음에 켤 때 다시 시도한다 (PostgreSQL 은 DDL 도 트랜잭션 안에서 되돌린다). 이미 적용한 파일은 고치지 않는다.
스키마를 바꿀 때는 새 번호의 파일을 더한다.

    migrations/0001_console.sql      콘솔의 문서 저장소 (예전 SQLite 스키마를 옮긴 것)
"""

from __future__ import annotations

import re
from pathlib import Path

import psycopg

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"
FILE_NAME_RE = re.compile(r"^\d{4}_[a-z0-9_]+\.sql$")

BOOKKEEPING = """
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
"""


def migration_files(directory: Path = MIGRATIONS_DIR) -> list[Path]:
    """번호순 이전 파일. 이름 규칙(NNNN_소문자.sql)에 맞지 않는 .sql 이 있으면 실수이므로 알린다."""
    files = sorted(directory.glob("*.sql"))
    wrong = [path.name for path in files if not FILE_NAME_RE.match(path.name)]
    if wrong:
        raise ValueError(f"migration file names must look like 0001_name.sql: {', '.join(wrong)}")
    return files


def applied_versions(connection: psycopg.Connection) -> set[str]:
    connection.execute(BOOKKEEPING)
    return {row["version"] for row in connection.execute("SELECT version FROM schema_migrations").fetchall()}


def apply_migrations(connection: psycopg.Connection, directory: Path = MIGRATIONS_DIR) -> list[str]:
    """아직 적용하지 않은 파일을 적용하고, 이번에 적용한 버전(파일 이름에서 .sql 을 뺀 것) 목록을 돌려준다.
    connection 은 autocommit 이어야 한다 (파일마다 트랜잭션을 따로 연다)."""
    done = applied_versions(connection)
    applied: list[str] = []
    for path in migration_files(directory):
        version = path.stem
        if version in done:
            continue
        with connection.transaction():
            connection.execute(path.read_text(encoding="utf-8"))
            connection.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (version,))
        applied.append(version)
    return applied
