"""예전 SQLite 저장소(var/backend.sqlite, 스키마 version 1)를 PostgreSQL 로 옮긴다.

    docker compose run --rm backend python -m app.legacy_import /app/var/backend.sqlite --replace

SQLite 의 각 테이블을 저장 순서(seq)대로 읽어 PostgreSQL 의 같은 테이블에 넣는다 (db.write_state, 트랜잭션 하나).
seededAt 도 그대로 옮기므로 다음에 켜면 health 의 source 는 snapshot 이다.
대상 DB 에 이미 seed 기록이 있으면 --replace 없이는 멈춘다. backend 를 한 번 켜면 data/ 로 seed 되므로 보통 --replace 가 필요하다
(--replace 는 대상의 콘솔 데이터를 지우고 SQLite 의 것으로 바꾼다. agent job 은 건드리지 않는다).

agent job 은 여기서 옮기지 않는다. backend 가 켤 때 job 폴더(OUTPUT_DIR/jobs/<id>/job.json)에서 DB 에 없는 것을 가져온다.

SQLite 파일은 읽기 전용 mount 에 있어도 되게 임시 폴더로 복사해서 연다 (WAL 파일에 남은 변경까지 읽으려면 쓰기 권한이 필요하다).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

from app.db import Database, now_iso, write_state
from app.seed import DEFAULT_ACCOUNT, SeedState
from app.settings import DATABASE_URL_DEFAULT, REPO_ROOT

LEGACY_VERSION = "1"
DOC_TABLES = ("templates", "batches", "hits", "assignments", "pools")


class LegacyImportError(Exception):
    pass


def read_sqlite(path: Path) -> tuple[SeedState, str | None]:
    """SQLite 파일 → (상태, seededAt). 파일이 없거나 스키마 버전이 다르면 LegacyImportError."""
    path = Path(path)
    if not path.is_file():
        raise LegacyImportError(f"SQLite file not found: {path}")
    with tempfile.TemporaryDirectory(prefix="legacy-sqlite-") as folder:
        copy = Path(folder) / path.name
        for suffix in ("", "-wal", "-shm"):
            source = path.with_name(path.name + suffix)
            if source.is_file():
                shutil.copyfile(source, copy.with_name(copy.name + suffix))
        connection = sqlite3.connect(copy)
        connection.row_factory = sqlite3.Row
        try:
            return _read(connection)
        except sqlite3.DatabaseError as error:
            raise LegacyImportError(f"cannot read {path}: {error}") from None
        finally:
            connection.close()


def _read(connection: sqlite3.Connection) -> tuple[SeedState, str | None]:
    meta = {row["key"]: row["value"] for row in connection.execute("SELECT key, value FROM meta")}
    if meta.get("version") != LEGACY_VERSION:
        raise LegacyImportError(f"unexpected SQLite schema version {meta.get('version')!r} (expected {LEGACY_VERSION})")

    def docs(table: str) -> list[dict]:
        return [json.loads(row["doc"]) for row in connection.execute(f"SELECT doc FROM {table} ORDER BY seq")]

    state = SeedState(**{table: docs(table) for table in DOC_TABLES})
    state.worker_meta = {row["id"]: json.loads(row["doc"]) for row in connection.execute("SELECT id, doc FROM workers ORDER BY seq")}
    account = connection.execute("SELECT doc FROM account WHERE id = 'account'").fetchone()
    state.account = json.loads(account["doc"]) if account else dict(DEFAULT_ACCOUNT)
    return state, meta.get("seededAt")


def import_sqlite(db: Database, path: Path, replace: bool = False) -> dict[str, int]:
    """path 의 내용을 db 로 옮긴다. db 는 열려 있지 않아도 된다 (스키마 이전까지 한다). 옮긴 규모를 돌려준다."""
    state, seeded_at = read_sqlite(path)
    db.prepare()
    with db.connect() as connection:
        row = connection.execute("SELECT value FROM meta WHERE key = 'seededAt'").fetchone()
        if row is not None and not replace:
            raise LegacyImportError("the target database already has data (seeded at "
                                    f"{row['value']}); pass --replace to overwrite it with the SQLite contents")
        write_state(connection, state, seeded_at or now_iso())
    return db.counts()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.legacy_import", description=__doc__.split("\n\n")[0])
    parser.add_argument("sqlite", type=Path, help="the old SQLite file (var/backend.sqlite)")
    parser.add_argument("--replace", action="store_true", help="overwrite console data that is already in the target database")
    parser.add_argument("--database-url", default=os.environ.get("DATABASE_URL", "").strip() or DATABASE_URL_DEFAULT,
                        help="target PostgreSQL (default: DATABASE_URL)")
    args = parser.parse_args(argv)

    db = Database(args.database_url, Path(os.environ.get("DATA_DIR", "").strip() or REPO_ROOT / "data"))
    try:
        counts = import_sqlite(db, args.sqlite, replace=args.replace)
    except LegacyImportError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    finally:
        db.close()
    print(f"imported {args.sqlite} into {db.target}: " + ", ".join(f"{n} {name}" for name, n in counts.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
