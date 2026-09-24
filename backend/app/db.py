"""SQLite 문서 저장소. 레코드 전체는 doc(JSON) 컬럼에 두고, 자주 찾는 값만 컬럼으로 꺼내 색인한다
(prototype/server/sqliteSnapshot.ts 와 같은 생각). 데이터 모델(prototype/src/api/types.ts)이 바뀌어도 스키마를 고칠 일이 적다.

DB 가 비어 있으면 처음 켤 때 data/ 폴더(seed.py)를 올린다. 그 뒤로는 DB 의 내용이 기준이고, 다시 켜면 그대로 이어진다.
health 의 source 는 이번 프로세스의 상태가 어디서 왔는지다: "seed"(방금 data/ 를 올렸다) 또는 "snapshot"(DB 에 있던 것).

연결은 호출마다 새로 연다 (요청은 여러 스레드에서 처리되고, agent job 의 worker 스레드도 있다). 파일은 volume 에 두고
WAL 모드를 켠다.

    sqlite3 var/backend.sqlite "SELECT status, COUNT(*) FROM assignments GROUP BY status"
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from app.domain.progress import AssignmentCounts
from app.seed import SeedState, assemble_state, read_seed_files

log = logging.getLogger("backend")

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta        (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS templates   (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name TEXT NOT NULL, updated_at TEXT NOT NULL, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS batches     (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hits        (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, batch_id TEXT NOT NULL, row_index INTEGER NOT NULL,
                                        max_assignments INTEGER NOT NULL, expiration TEXT NOT NULL, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assignments (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, hit_id TEXT NOT NULL, worker_id TEXT NOT NULL,
                                        status TEXT NOT NULL, submit_time TEXT NOT NULL, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pools       (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name TEXT NOT NULL, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workers     (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS account     (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS hits_batch         ON hits (batch_id);
CREATE INDEX IF NOT EXISTS assignments_hit    ON assignments (hit_id);
CREATE INDEX IF NOT EXISTS assignments_worker ON assignments (worker_id);
CREATE INDEX IF NOT EXISTS assignments_status ON assignments (status);
"""

COLLECTIONS = ("templates", "batches", "hits", "assignments", "pools", "workers")


def dumps(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass(frozen=True)
class HitRow:
    """batch 요약에 필요한 HIT 의 값만 (doc 을 파싱하지 않는다)."""

    id: str
    max_assignments: int
    expiration: str


class Database:
    def __init__(self, path: Path, data_dir: Path):
        self.path = Path(path)
        self.data_dir = Path(data_dir)
        self.source = "seed"
        self.seeded_at: str | None = None
        self._init_lock = threading.Lock()

    # ---- 연결 -------------------------------------------------------------------------------

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=30)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self) -> None:
        """스키마를 만들고, DB 가 비어 있으면 data/ 를 올린다. 프로세스마다 한 번 부른다."""
        with self._init_lock:
            if self.path.name != ":memory:":
                self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.connect() as connection:
                connection.execute("PRAGMA journal_mode = WAL")
                connection.executescript(SCHEMA)
                version = self._meta(connection, "version")
                if version == str(SCHEMA_VERSION):
                    self.source = "snapshot"
                    self.seeded_at = self._meta(connection, "seededAt")
                    return
                if version is not None:
                    log.warning("DB schema version %s differs from %s; reseeding from %s", version, SCHEMA_VERSION, self.data_dir)
            self.reseed()

    def reseed(self) -> None:
        """DB 를 비우고 data/ 를 다시 올린다."""
        state = assemble_state(read_seed_files(self.data_dir))
        with self.connect() as connection:
            self._write_state(connection, state)
        self.source = "seed"
        self.seeded_at = self._meta_value("seededAt")

    # ---- 쓰기 -------------------------------------------------------------------------------

    @staticmethod
    def _meta(connection: sqlite3.Connection, key: str) -> str | None:
        row = connection.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def _meta_value(self, key: str) -> str | None:
        with self.connect() as connection:
            return self._meta(connection, key)

    def _write_state(self, connection: sqlite3.Connection, state: SeedState) -> None:
        for table in (*COLLECTIONS, "account", "meta"):
            connection.execute(f"DELETE FROM {table}")
        connection.executemany(
            "INSERT INTO templates (id, seq, name, updated_at, doc) VALUES (?, ?, ?, ?, ?)",
            [(t["id"], i, t["name"], t["updatedAt"], dumps(t)) for i, t in enumerate(state.templates)])
        connection.executemany(
            "INSERT INTO batches (id, seq, name, created_at, doc) VALUES (?, ?, ?, ?, ?)",
            [(b["id"], i, b["name"], b["createdAt"], dumps(b)) for i, b in enumerate(state.batches)])
        connection.executemany(
            "INSERT INTO hits (id, seq, batch_id, row_index, max_assignments, expiration, doc) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [(h["HITId"], i, h["batchId"], h["rowIndex"], h["MaxAssignments"], h["Expiration"], dumps(h))
             for i, h in enumerate(state.hits)])
        connection.executemany(
            "INSERT INTO assignments (id, seq, hit_id, worker_id, status, submit_time, doc) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [(a["AssignmentId"], i, a["HITId"], a["WorkerId"], a["AssignmentStatus"], a["SubmitTime"], dumps(a))
             for i, a in enumerate(state.assignments)])
        connection.executemany(
            "INSERT INTO pools (id, seq, name, doc) VALUES (?, ?, ?, ?)",
            [(p["id"], i, p["name"], dumps(p)) for i, p in enumerate(state.pools)])
        connection.executemany(
            "INSERT INTO workers (id, seq, doc) VALUES (?, ?, ?)",
            [(worker_id, i, dumps(meta)) for i, (worker_id, meta) in enumerate(state.worker_meta.items())])
        connection.execute("INSERT INTO account (id, doc) VALUES ('account', ?)", (dumps(state.account),))
        connection.executemany("INSERT INTO meta (key, value) VALUES (?, ?)",
                               [("version", str(SCHEMA_VERSION)), ("seededAt", now_iso())])

    # ---- 읽기 -------------------------------------------------------------------------------

    def list_templates(self) -> list[dict]:
        """updatedAt 내림차순 (같으면 seed 순서)."""
        with self.connect() as connection:
            rows = connection.execute("SELECT doc FROM templates ORDER BY updated_at DESC, seq").fetchall()
        return [json.loads(row["doc"]) for row in rows]

    def get_template(self, id: str) -> dict | None:
        with self.connect() as connection:
            row = connection.execute("SELECT doc FROM templates WHERE id = ?", (id,)).fetchone()
        return json.loads(row["doc"]) if row else None

    def list_batches(self) -> list[dict]:
        """seed 순서. 정렬(createdAt 내림차순)은 핸들러가 한다."""
        with self.connect() as connection:
            rows = connection.execute("SELECT doc FROM batches ORDER BY seq").fetchall()
        return [json.loads(row["doc"]) for row in rows]

    def get_batch(self, id: str) -> dict | None:
        with self.connect() as connection:
            row = connection.execute("SELECT doc FROM batches WHERE id = ?", (id,)).fetchone()
        return json.loads(row["doc"]) if row else None

    def hits_of_batch(self, batch_id: str) -> list[HitRow]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT id, max_assignments, expiration FROM hits WHERE batch_id = ? ORDER BY seq", (batch_id,)).fetchall()
        return [HitRow(row["id"], row["max_assignments"], row["expiration"]) for row in rows]

    def assignment_counts_of_batch(self, batch_id: str) -> dict[str, AssignmentCounts]:
        """HIT id → 상태별 assignment 수. Submitted, Approved 가 아닌 상태는 모두 rejected 로 센다."""
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT a.hit_id AS hit_id, a.status AS status, COUNT(*) AS n FROM assignments a "
                "JOIN hits h ON h.id = a.hit_id WHERE h.batch_id = ? GROUP BY a.hit_id, a.status", (batch_id,)).fetchall()
        counts: dict[str, dict[str, int]] = {}
        for row in rows:
            bucket = counts.setdefault(row["hit_id"], {"submitted": 0, "approved": 0, "rejected": 0})
            key = {"Submitted": "submitted", "Approved": "approved"}.get(row["status"], "rejected")
            bucket[key] += row["n"]
        return {hit_id: AssignmentCounts(**bucket) for hit_id, bucket in counts.items()}

    def account(self) -> dict:
        with self.connect() as connection:
            row = connection.execute("SELECT doc FROM account WHERE id = 'account'").fetchone()
        return json.loads(row["doc"]) if row else {}

    def counts(self) -> dict[str, int]:
        """health 에 보이는 규모. workers 는 응답을 낸 worker, pool 에 든 worker, 메모가 붙은 worker 의 합집합이다."""
        with self.connect() as connection:
            result = {table: connection.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"]
                      for table in ("templates", "batches", "hits", "assignments", "pools")}
            worker_ids = {row["worker_id"] for row in connection.execute("SELECT DISTINCT worker_id FROM assignments")}
            worker_ids.update(row["id"] for row in connection.execute("SELECT id FROM workers"))
            for row in connection.execute("SELECT doc FROM pools"):
                worker_ids.update(json.loads(row["doc"]).get("workerIds", []))
        result["workers"] = len(worker_ids)
        return result
