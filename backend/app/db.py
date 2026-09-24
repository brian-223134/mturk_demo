"""SQLite 문서 저장소. 레코드 전체는 doc(JSON) 컬럼에 두고, 자주 찾는 값만 컬럼으로 꺼내 색인한다
(prototype/server/sqliteSnapshot.ts 와 같은 생각). 데이터 모델(prototype/src/api/types.ts)이 바뀌어도 스키마를 고칠 일이 적다.

DB 가 비어 있으면 처음 켤 때 data/ 폴더(seed.py)를 올린다. 그 뒤로는 DB 의 내용이 기준이고, 다시 켜면 그대로 이어진다.
health 의 source 는 이번 프로세스의 상태가 어디서 왔는지다: "seed"(방금 data/ 를 올렸다) 또는 "snapshot"(DB 에 있던 것).

읽기와 쓰기는 Store 에 있다. Store 는 연결 하나에 묶여 있어서, 핸들러가 검증(읽기)과 변경(쓰기)을 한 트랜잭션 안에서 하고
도중에 오류가 나면 전부 되돌린다 (프로토타입의 write() 가 "검증을 마친 뒤에 상태를 고쳐라" 라고 한 것을 DB 가 보장한다).

    with db.transaction(write=True) as store:      # BEGIN IMMEDIATE … COMMIT (예외면 ROLLBACK)
        batch = store.get_batch(id) or raise …
        store.update_hit(hit)
    db.get_batch(id)                                # 한 번짜리 읽기는 Database 가 Store 의 메서드를 그대로 감싸 준다

연결은 호출마다 새로 연다 (요청은 여러 스레드에서 처리되고, agent job 의 worker 스레드도 있다). 파일은 volume 에 두고
WAL 모드를 켠다. 문서는 저장하기 전에 JS 처럼 정수 값의 실수(1.0)를 정수(1)로 바꾼다.

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
from typing import Any, Callable, Iterable, Iterator

from app.domain.js import normalize_numbers
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
    """문서 → JSON 텍스트. JSON.stringify 처럼 1.0 은 1 로 적는다."""
    return json.dumps(normalize_numbers(value), ensure_ascii=False, separators=(",", ":"))


def loads(text: str) -> Any:
    return json.loads(text)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass(frozen=True)
class HitRow:
    """batch 요약과 목록에 필요한 HIT 의 색인 값만 (doc 을 파싱하지 않는다)."""

    id: str
    max_assignments: int
    expiration: str
    row_index: int = 0


class Store:
    """연결 하나 위의 읽기와 쓰기. Database.transaction() 이 만들어 준다."""

    def __init__(self, connection: sqlite3.Connection):
        self.connection = connection

    def _docs(self, sql: str, params: tuple = ()) -> list[dict]:
        return [loads(row["doc"]) for row in self.connection.execute(sql, params).fetchall()]

    def _doc(self, sql: str, params: tuple = ()) -> dict | None:
        row = self.connection.execute(sql, params).fetchone()
        return loads(row["doc"]) if row else None

    def _next_seq(self, table: str) -> int:
        return self.connection.execute(f"SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM {table}").fetchone()["n"]

    # ---- templates --------------------------------------------------------------------------

    def list_templates(self) -> list[dict]:
        """updatedAt 내림차순 (같으면 seed 순서)."""
        return self._docs("SELECT doc FROM templates ORDER BY updated_at DESC, seq")

    def get_template(self, id: str) -> dict | None:
        return self._doc("SELECT doc FROM templates WHERE id = ?", (id,))

    def template_ids(self) -> set[str]:
        return {row["id"] for row in self.connection.execute("SELECT id FROM templates")}

    def insert_template(self, template: dict) -> None:
        self.connection.execute("INSERT INTO templates (id, seq, name, updated_at, doc) VALUES (?, ?, ?, ?, ?)",
                                (template["id"], self._next_seq("templates"), template["name"], template["updatedAt"], dumps(template)))

    def update_template(self, template: dict) -> None:
        self.connection.execute("UPDATE templates SET name = ?, updated_at = ?, doc = ? WHERE id = ?",
                                (template["name"], template["updatedAt"], dumps(template), template["id"]))

    def delete_template(self, id: str) -> bool:
        return self.connection.execute("DELETE FROM templates WHERE id = ?", (id,)).rowcount > 0

    # ---- batches ----------------------------------------------------------------------------

    def list_batches(self) -> list[dict]:
        """seed 순서. 정렬(createdAt 내림차순)은 핸들러가 한다."""
        return self._docs("SELECT doc FROM batches ORDER BY seq")

    def get_batch(self, id: str) -> dict | None:
        return self._doc("SELECT doc FROM batches WHERE id = ?", (id,))

    def batch_ids(self) -> set[str]:
        return {row["id"] for row in self.connection.execute("SELECT id FROM batches")}

    def batch_names(self) -> dict[str, str]:
        return {row["id"]: row["name"] for row in self.connection.execute("SELECT id, name FROM batches")}

    def insert_batch(self, batch: dict) -> None:
        self.connection.execute("INSERT INTO batches (id, seq, name, created_at, doc) VALUES (?, ?, ?, ?, ?)",
                                (batch["id"], self._next_seq("batches"), batch["name"], batch["createdAt"], dumps(batch)))

    # ---- hits -------------------------------------------------------------------------------

    def hits_of_batch(self, batch_id: str) -> list[HitRow]:
        rows = self.connection.execute(
            "SELECT id, max_assignments, expiration, row_index FROM hits WHERE batch_id = ? ORDER BY seq", (batch_id,)).fetchall()
        return [HitRow(row["id"], row["max_assignments"], row["expiration"], row["row_index"]) for row in rows]

    def hit_docs_of_batch(self, batch_id: str) -> list[dict]:
        return self._docs("SELECT doc FROM hits WHERE batch_id = ? ORDER BY seq", (batch_id,))

    def get_hit(self, id: str) -> dict | None:
        return self._doc("SELECT doc FROM hits WHERE id = ?", (id,))

    def insert_hits(self, hits: Iterable[dict]) -> None:
        seq = self._next_seq("hits")
        self.connection.executemany(
            "INSERT INTO hits (id, seq, batch_id, row_index, max_assignments, expiration, doc) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [(h["HITId"], seq + i, h["batchId"], h["rowIndex"], h["MaxAssignments"], h["Expiration"], dumps(h))
             for i, h in enumerate(hits)])

    def update_hit(self, hit: dict) -> None:
        self.connection.execute("UPDATE hits SET max_assignments = ?, expiration = ?, doc = ? WHERE id = ?",
                                (hit["MaxAssignments"], hit["Expiration"], dumps(hit), hit["HITId"]))

    # ---- assignments ------------------------------------------------------------------------

    def assignment_counts_of_batch(self, batch_id: str) -> dict[str, AssignmentCounts]:
        """HIT id → 상태별 assignment 수. Submitted, Approved 가 아닌 상태는 모두 rejected 로 센다."""
        rows = self.connection.execute(
            "SELECT a.hit_id AS hit_id, a.status AS status, COUNT(*) AS n FROM assignments a "
            "JOIN hits h ON h.id = a.hit_id WHERE h.batch_id = ? GROUP BY a.hit_id, a.status", (batch_id,)).fetchall()
        counts: dict[str, dict[str, int]] = {}
        for row in rows:
            bucket = counts.setdefault(row["hit_id"], {"submitted": 0, "approved": 0, "rejected": 0})
            key = {"Submitted": "submitted", "Approved": "approved"}.get(row["status"], "rejected")
            bucket[key] += row["n"]
        return {hit_id: AssignmentCounts(**bucket) for hit_id, bucket in counts.items()}

    def assignments_of_batch(self, batch_id: str) -> list[dict]:
        """batch 의 assignment 전부 (저장 순서)."""
        return self._docs("SELECT a.doc AS doc FROM assignments a JOIN hits h ON h.id = a.hit_id WHERE h.batch_id = ? ORDER BY a.seq",
                          (batch_id,))

    def assignments_of_hits(self, hit_ids: Iterable[str]) -> dict[str, list[dict]]:
        """HIT id → 그 HIT 의 assignment 목록 (저장 순서). assignment 가 없는 HIT 는 키가 없다."""
        grouped: dict[str, list[dict]] = {}
        for hit_id in set(hit_ids):
            docs = self._docs("SELECT doc FROM assignments WHERE hit_id = ? ORDER BY seq", (hit_id,))
            if docs:
                grouped[hit_id] = docs
        return grouped

    def get_assignments(self, ids: Iterable[str]) -> dict[str, dict]:
        """id → 문서. 없는 id 는 빠진다."""
        found: dict[str, dict] = {}
        for id in ids:
            if id not in found:
                doc = self._doc("SELECT doc FROM assignments WHERE id = ?", (id,))
                if doc is not None:
                    found[id] = doc
        return found

    def assignments_of_worker(self, worker_id: str) -> list[tuple[dict, str, int]]:
        """(assignment, batchId, rowIndex) 목록 (저장 순서)."""
        rows = self.connection.execute(
            "SELECT a.doc AS doc, h.batch_id AS batch_id, h.row_index AS row_index FROM assignments a "
            "JOIN hits h ON h.id = a.hit_id WHERE a.worker_id = ? ORDER BY a.seq", (worker_id,)).fetchall()
        return [(loads(row["doc"]), row["batch_id"], row["row_index"]) for row in rows]

    def assignment_records(self) -> list[tuple[dict, str, int]]:
        """모든 assignment 를 (assignment, batchId, rowIndex) 로 (저장 순서). worker 지표 계산용."""
        rows = self.connection.execute(
            "SELECT a.doc AS doc, h.batch_id AS batch_id, h.row_index AS row_index FROM assignments a "
            "JOIN hits h ON h.id = a.hit_id ORDER BY a.seq").fetchall()
        return [(loads(row["doc"]), row["batch_id"], row["row_index"]) for row in rows]

    def worker_ids_with_assignments(self) -> list[str]:
        """응답을 낸 worker (처음 나온 순서)."""
        seen: dict[str, None] = {}
        for row in self.connection.execute("SELECT worker_id FROM assignments ORDER BY seq"):
            seen.setdefault(row["worker_id"], None)
        return list(seen)

    def update_assignment(self, assignment: dict) -> None:
        self.connection.execute("UPDATE assignments SET status = ?, submit_time = ?, doc = ? WHERE id = ?",
                                (assignment["AssignmentStatus"], assignment["SubmitTime"], dumps(assignment), assignment["AssignmentId"]))

    # ---- pools ------------------------------------------------------------------------------

    def list_pools(self) -> list[dict]:
        return self._docs("SELECT doc FROM pools ORDER BY seq")

    def get_pool(self, id: str) -> dict | None:
        return self._doc("SELECT doc FROM pools WHERE id = ?", (id,))

    def insert_pool(self, pool: dict) -> None:
        self.connection.execute("INSERT INTO pools (id, seq, name, doc) VALUES (?, ?, ?, ?)",
                                (pool["id"], self._next_seq("pools"), pool["name"], dumps(pool)))

    def update_pool(self, pool: dict) -> None:
        self.connection.execute("UPDATE pools SET name = ?, doc = ? WHERE id = ?", (pool["name"], dumps(pool), pool["id"]))

    # ---- workers (콘솔이 worker 에 붙인 정보: blocked, note, blockReason) -----------------------

    def worker_meta(self, worker_id: str) -> dict | None:
        return self._doc("SELECT doc FROM workers WHERE id = ?", (worker_id,))

    def all_worker_meta(self) -> dict[str, dict]:
        """WorkerId → meta (저장 순서)."""
        rows = self.connection.execute("SELECT id, doc FROM workers ORDER BY seq").fetchall()
        return {row["id"]: loads(row["doc"]) for row in rows}

    def set_worker_meta(self, worker_id: str, meta: dict) -> None:
        if self.connection.execute("UPDATE workers SET doc = ? WHERE id = ?", (dumps(meta), worker_id)).rowcount == 0:
            self.connection.execute("INSERT INTO workers (id, seq, doc) VALUES (?, ?, ?)", (worker_id, self._next_seq("workers"), dumps(meta)))

    # ---- account ----------------------------------------------------------------------------

    def account(self) -> dict:
        return self._doc("SELECT doc FROM account WHERE id = 'account'") or {}

    def set_account(self, account: dict) -> None:
        self.connection.execute("UPDATE account SET doc = ? WHERE id = 'account'", (dumps(account),))

    def counts(self) -> dict[str, int]:
        """health 에 보이는 규모. workers 는 응답을 낸 worker, pool 에 든 worker, 메모가 붙은 worker 의 합집합이다."""
        result = {table: self.connection.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"]
                  for table in ("templates", "batches", "hits", "assignments", "pools")}
        worker_ids = {row["worker_id"] for row in self.connection.execute("SELECT DISTINCT worker_id FROM assignments")}
        worker_ids.update(row["id"] for row in self.connection.execute("SELECT id FROM workers"))
        for row in self.connection.execute("SELECT doc FROM pools"):
            worker_ids.update(loads(row["doc"]).get("workerIds", []))
        result["workers"] = len(worker_ids)
        return result


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

    @contextmanager
    def transaction(self, write: bool = False) -> Iterator[Store]:
        """Store 를 연결 하나에 묶어 준다. write=True 면 BEGIN IMMEDIATE 로 시작해 다른 쓰기와 직렬화한다."""
        with self.connect() as connection:
            if write:
                connection.execute("BEGIN IMMEDIATE")
            yield Store(connection)

    def __getattr__(self, name: str) -> Callable:
        """Store 의 메서드를 한 번짜리 트랜잭션으로 감싸 그대로 쓸 수 있게 한다 (db.get_batch(id) 처럼)."""
        method = getattr(Store, name, None)
        if name.startswith("_") or method is None:
            raise AttributeError(name)

        def call(*args, **kwargs):
            with self.transaction() as store:
                return method(store, *args, **kwargs)

        return call

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

    # ---- seed 쓰기 ---------------------------------------------------------------------------

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
