"""PostgreSQL 문서 저장소. 레코드 전체는 doc(JSON) 컬럼에 두고, 자주 찾는 값만 컬럼으로 꺼내 색인한다
(prototype/server/sqliteSnapshot.ts 와 같은 생각). 데이터 모델(prototype/src/api/types.ts)이 바뀌어도 스키마를 고칠 일이 적다.
스키마는 backend/app/migrations/ 의 SQL 파일이 정한다 (app/schema.py 가 켤 때 적용).

DB 에 seed 기록(meta.seededAt)이 없으면 처음 켤 때 data/ 폴더(seed.py)를 올린다. 그 뒤로는 DB 의 내용이 기준이고, 다시 켜면
그대로 이어진다. health 의 source 는 이번 프로세스의 상태가 어디서 왔는지다: "seed"(방금 data/ 를 올렸다) 또는 "snapshot"(DB 에 있던 것).

읽기와 쓰기는 Store 에 있다. Store 는 연결 하나에 묶여 있어서, 핸들러가 검증(읽기)과 변경(쓰기)을 한 트랜잭션 안에서 하고
도중에 오류가 나면 전부 되돌린다 (프로토타입의 write() 가 "검증을 마친 뒤에 상태를 고쳐라" 라고 한 것을 DB 가 보장한다).

    with db.transaction(write=True) as store:      # BEGIN … 쓰기 잠금 … COMMIT (예외면 ROLLBACK)
        batch = store.get_batch(id) or raise …
        store.update_hit(hit)
    db.get_batch(id)                                # 한 번짜리 호출은 Database 가 Store 의 메서드를 그대로 감싸 준다

쓰기 트랜잭션은 advisory lock(WRITE_LOCK)으로 하나씩 줄을 세운다. 핸들러는 "읽고 확인한 뒤 고친다" 는 모양이라, 예전 SQLite 의
BEGIN IMMEDIATE 처럼 쓰기끼리 겹치지 않아야 확인한 값이 그대로 유효하다. 읽기 트랜잭션은 REPEATABLE READ, READ ONLY 라서
한 핸들러 안의 여러 조회가 같은 시점을 본다.

연결은 pool(psycopg_pool)에서 빌린다. 요청은 여러 스레드에서 처리되고 agent job 의 worker 스레드도 있다. pool 은 initialize()
가 열고 close() 가 닫는다. 문서는 저장하기 전에 JS 처럼 정수 값의 실수(1.0)를 정수(1)로 바꾼다.

    docker compose exec db psql -U mturk -c "SELECT status, COUNT(*) FROM assignments GROUP BY status"
"""

from __future__ import annotations

import json
import logging
import threading
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, Iterator

import psycopg
from psycopg.conninfo import conninfo_to_dict
from psycopg.rows import dict_row
from psycopg.types.json import Json
from psycopg_pool import ConnectionPool, PoolTimeout

from app.domain.js import normalize_numbers
from app.domain.progress import AssignmentCounts
from app.schema import apply_migrations
from app.seed import SeedState, assemble_state, read_seed_files

log = logging.getLogger("backend")

WRITE_LOCK = 7270301   # pg_advisory_xact_lock 키: 쓰기 트랜잭션을 하나씩
INIT_LOCK = 7270302    # pg_advisory_lock 키: 여러 프로세스가 함께 켜져도 스키마 이전과 seed 는 한 번만
CONNECT_TIMEOUT = 30   # 초. 처음 켤 때 DB 를 기다리는 시간

# seed 가 채우는 테이블. reseed 는 이것만 비운다
SEED_TABLES = ("templates", "batches", "hits", "assignments", "pools", "workers", "account", "meta")
COUNTED_TABLES = ("templates", "batches", "hits", "assignments", "pools")
WRITE_PREFIXES = ("insert_", "update_", "delete_", "set_")


def dumps(value: object) -> str:
    """문서 → JSON 텍스트. JSON.stringify 처럼 1.0 은 1 로 적는다."""
    return json.dumps(normalize_numbers(value), ensure_ascii=False, separators=(",", ":"))


def as_json(value: object) -> Json:
    """JSON 컬럼에 넣을 값."""
    return Json(value, dumps=dumps)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def describe_url(url: str) -> str:
    """로그에 쓰는 접속 대상 (비밀번호는 빼고 host:port/dbname)."""
    try:
        parts = conninfo_to_dict(url)
    except psycopg.ProgrammingError:
        return "(invalid DATABASE_URL)"
    return f"{parts.get('host') or 'localhost'}:{parts.get('port') or 5432}/{parts.get('dbname') or ''}"


@dataclass(frozen=True)
class HitRow:
    """batch 요약과 목록에 필요한 HIT 의 색인 값만 (doc 을 파싱하지 않는다)."""

    id: str
    max_assignments: int
    expiration: str
    row_index: int = 0


class Store:
    """연결 하나 위의 읽기와 쓰기. Database.transaction() 이 만들어 준다."""

    def __init__(self, connection: psycopg.Connection):
        self.connection = connection

    def _rows(self, sql: str, params: tuple = ()) -> list[dict]:
        return self.connection.execute(sql, params).fetchall()

    def _docs(self, sql: str, params: tuple = ()) -> list[dict]:
        return [row["doc"] for row in self._rows(sql, params)]

    def _doc(self, sql: str, params: tuple = ()) -> dict | None:
        row = self.connection.execute(sql, params).fetchone()
        return row["doc"] if row else None

    # ---- templates --------------------------------------------------------------------------

    def list_templates(self) -> list[dict]:
        """updatedAt 내림차순 (같으면 seed 순서)."""
        return self._docs("SELECT doc FROM templates ORDER BY updated_at DESC, seq")

    def get_template(self, id: str) -> dict | None:
        return self._doc("SELECT doc FROM templates WHERE id = %s", (id,))

    def template_ids(self) -> set[str]:
        return {row["id"] for row in self._rows("SELECT id FROM templates")}

    def insert_template(self, template: dict) -> None:
        self.connection.execute("INSERT INTO templates (id, name, updated_at, doc) VALUES (%s, %s, %s, %s)",
                                (template["id"], template["name"], template["updatedAt"], as_json(template)))

    def update_template(self, template: dict) -> None:
        self.connection.execute("UPDATE templates SET name = %s, updated_at = %s, doc = %s WHERE id = %s",
                                (template["name"], template["updatedAt"], as_json(template), template["id"]))

    def delete_template(self, id: str) -> bool:
        return self.connection.execute("DELETE FROM templates WHERE id = %s", (id,)).rowcount > 0

    # ---- batches ----------------------------------------------------------------------------

    def list_batches(self) -> list[dict]:
        """seed 순서. 정렬(createdAt 내림차순)은 핸들러가 한다."""
        return self._docs("SELECT doc FROM batches ORDER BY seq")

    def get_batch(self, id: str) -> dict | None:
        return self._doc("SELECT doc FROM batches WHERE id = %s", (id,))

    def batch_ids(self) -> set[str]:
        return {row["id"] for row in self._rows("SELECT id FROM batches")}

    def batch_names(self) -> dict[str, str]:
        return {row["id"]: row["name"] for row in self._rows("SELECT id, name FROM batches ORDER BY seq")}

    def insert_batch(self, batch: dict) -> None:
        self.connection.execute("INSERT INTO batches (id, name, created_at, doc) VALUES (%s, %s, %s, %s)",
                                (batch["id"], batch["name"], batch["createdAt"], as_json(batch)))

    # ---- hits -------------------------------------------------------------------------------

    def hits_of_batch(self, batch_id: str) -> list[HitRow]:
        rows = self._rows("SELECT id, max_assignments, expiration, row_index FROM hits WHERE batch_id = %s ORDER BY seq",
                          (batch_id,))
        return [HitRow(row["id"], row["max_assignments"], row["expiration"], row["row_index"]) for row in rows]

    def hit_docs_of_batch(self, batch_id: str) -> list[dict]:
        return self._docs("SELECT doc FROM hits WHERE batch_id = %s ORDER BY seq", (batch_id,))

    def get_hit(self, id: str) -> dict | None:
        return self._doc("SELECT doc FROM hits WHERE id = %s", (id,))

    def insert_hits(self, hits: Iterable[dict]) -> None:
        with self.connection.cursor() as cursor:
            cursor.executemany(
                "INSERT INTO hits (id, batch_id, row_index, max_assignments, expiration, doc) VALUES (%s, %s, %s, %s, %s, %s)",
                [(h["HITId"], h["batchId"], h["rowIndex"], h["MaxAssignments"], h["Expiration"], as_json(h)) for h in hits])

    def update_hit(self, hit: dict) -> None:
        self.connection.execute("UPDATE hits SET max_assignments = %s, expiration = %s, doc = %s WHERE id = %s",
                                (hit["MaxAssignments"], hit["Expiration"], as_json(hit), hit["HITId"]))

    # ---- assignments ------------------------------------------------------------------------

    def assignment_counts_of_batch(self, batch_id: str) -> dict[str, AssignmentCounts]:
        """HIT id → 상태별 assignment 수. Submitted, Approved 가 아닌 상태는 모두 rejected 로 센다."""
        rows = self._rows(
            "SELECT a.hit_id AS hit_id, a.status AS status, COUNT(*) AS n FROM assignments a "
            "JOIN hits h ON h.id = a.hit_id WHERE h.batch_id = %s GROUP BY a.hit_id, a.status", (batch_id,))
        counts: dict[str, dict[str, int]] = {}
        for row in rows:
            bucket = counts.setdefault(row["hit_id"], {"submitted": 0, "approved": 0, "rejected": 0})
            key = {"Submitted": "submitted", "Approved": "approved"}.get(row["status"], "rejected")
            bucket[key] += row["n"]
        return {hit_id: AssignmentCounts(**bucket) for hit_id, bucket in counts.items()}

    def assignments_of_batch(self, batch_id: str) -> list[dict]:
        """batch 의 assignment 전부 (저장 순서)."""
        return self._docs("SELECT a.doc AS doc FROM assignments a JOIN hits h ON h.id = a.hit_id WHERE h.batch_id = %s "
                          "ORDER BY a.seq", (batch_id,))

    def assignments_of_hits(self, hit_ids: Iterable[str]) -> dict[str, list[dict]]:
        """HIT id → 그 HIT 의 assignment 목록 (저장 순서). assignment 가 없는 HIT 는 키가 없다."""
        grouped: dict[str, list[dict]] = {}
        for row in self._rows("SELECT hit_id, doc FROM assignments WHERE hit_id = ANY(%s) ORDER BY seq", (list(set(hit_ids)),)):
            grouped.setdefault(row["hit_id"], []).append(row["doc"])
        return grouped

    def get_assignments(self, ids: Iterable[str]) -> dict[str, dict]:
        """id → 문서 (요청한 순서). 없는 id 는 빠진다."""
        wanted = list(dict.fromkeys(ids))
        found = {row["id"]: row["doc"] for row in self._rows("SELECT id, doc FROM assignments WHERE id = ANY(%s)", (wanted,))}
        return {id: found[id] for id in wanted if id in found}

    def assignments_of_worker(self, worker_id: str) -> list[tuple[dict, str, int]]:
        """(assignment, batchId, rowIndex) 목록 (저장 순서)."""
        rows = self._rows(
            "SELECT a.doc AS doc, h.batch_id AS batch_id, h.row_index AS row_index FROM assignments a "
            "JOIN hits h ON h.id = a.hit_id WHERE a.worker_id = %s ORDER BY a.seq", (worker_id,))
        return [(row["doc"], row["batch_id"], row["row_index"]) for row in rows]

    def assignment_records(self) -> list[tuple[dict, str, int]]:
        """모든 assignment 를 (assignment, batchId, rowIndex) 로 (저장 순서). worker 지표 계산용."""
        rows = self._rows(
            "SELECT a.doc AS doc, h.batch_id AS batch_id, h.row_index AS row_index FROM assignments a "
            "JOIN hits h ON h.id = a.hit_id ORDER BY a.seq")
        return [(row["doc"], row["batch_id"], row["row_index"]) for row in rows]

    def worker_ids_with_assignments(self) -> list[str]:
        """응답을 낸 worker (처음 나온 순서)."""
        seen: dict[str, None] = {}
        for row in self._rows("SELECT worker_id FROM assignments ORDER BY seq"):
            seen.setdefault(row["worker_id"], None)
        return list(seen)

    def update_assignment(self, assignment: dict) -> None:
        self.connection.execute("UPDATE assignments SET status = %s, submit_time = %s, doc = %s WHERE id = %s",
                                (assignment["AssignmentStatus"], assignment["SubmitTime"], as_json(assignment),
                                 assignment["AssignmentId"]))

    # ---- pools ------------------------------------------------------------------------------

    def list_pools(self) -> list[dict]:
        return self._docs("SELECT doc FROM pools ORDER BY seq")

    def get_pool(self, id: str) -> dict | None:
        return self._doc("SELECT doc FROM pools WHERE id = %s", (id,))

    def insert_pool(self, pool: dict) -> None:
        self.connection.execute("INSERT INTO pools (id, name, doc) VALUES (%s, %s, %s)", (pool["id"], pool["name"], as_json(pool)))

    def update_pool(self, pool: dict) -> None:
        self.connection.execute("UPDATE pools SET name = %s, doc = %s WHERE id = %s", (pool["name"], as_json(pool), pool["id"]))

    # ---- workers (콘솔이 worker 에 붙인 정보: blocked, note, blockReason) -----------------------

    def worker_meta(self, worker_id: str) -> dict | None:
        return self._doc("SELECT doc FROM workers WHERE id = %s", (worker_id,))

    def all_worker_meta(self) -> dict[str, dict]:
        """WorkerId → meta (저장 순서)."""
        return {row["id"]: row["doc"] for row in self._rows("SELECT id, doc FROM workers ORDER BY seq")}

    def set_worker_meta(self, worker_id: str, meta: dict) -> None:
        self.connection.execute("INSERT INTO workers (id, doc) VALUES (%s, %s) ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc",
                                (worker_id, as_json(meta)))

    # ---- account ----------------------------------------------------------------------------

    def account(self) -> dict:
        return self._doc("SELECT doc FROM account WHERE id = 'account'") or {}

    def set_account(self, account: dict) -> None:
        self.connection.execute("UPDATE account SET doc = %s WHERE id = 'account'", (as_json(account),))

    def counts(self) -> dict[str, int]:
        """health 에 보이는 규모. workers 는 응답을 낸 worker, pool 에 든 worker, 메모가 붙은 worker 의 합집합이다."""
        result = {table: self.connection.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"] for table in COUNTED_TABLES}
        worker_ids = {row["worker_id"] for row in self._rows("SELECT DISTINCT worker_id FROM assignments")}
        worker_ids.update(row["id"] for row in self._rows("SELECT id FROM workers"))
        for pool in self._docs("SELECT doc FROM pools"):
            worker_ids.update(pool.get("workerIds", []))
        result["workers"] = len(worker_ids)
        return result


class Database:
    def __init__(self, url: str, data_dir: Path, *, max_connections: int = 10):
        self.url = url
        self.data_dir = Path(data_dir)
        self.max_connections = max_connections
        self.source = "seed"
        self.seeded_at: str | None = None
        self._pool: ConnectionPool | None = None
        self._init_lock = threading.Lock()

    @property
    def target(self) -> str:
        return describe_url(self.url)

    # ---- 연결 -------------------------------------------------------------------------------

    def open(self) -> None:
        """pool 을 연다. DB 에 닿지 않으면 CONNECT_TIMEOUT 초 뒤에 접속 대상을 적은 오류를 낸다."""
        if self._pool is not None:
            return
        pool = ConnectionPool(self.url, min_size=1, max_size=self.max_connections, open=False, name="backend",
                              kwargs={"autocommit": True, "row_factory": dict_row}, check=ConnectionPool.check_connection)
        try:
            pool.open(wait=True, timeout=CONNECT_TIMEOUT)
        except PoolTimeout:
            pool.close()
            raise RuntimeError(f"cannot connect to PostgreSQL at {self.target} within {CONNECT_TIMEOUT} s (check DATABASE_URL)") from None
        self._pool = pool

    def close(self) -> None:
        if self._pool is not None:
            self._pool.close()
            self._pool = None

    @contextmanager
    def connect(self) -> Iterator[psycopg.Connection]:
        """autocommit 연결 하나 (스키마 이전, seed, 시험용). 트랜잭션은 쓰는 쪽이 연다."""
        if self._pool is None:
            raise RuntimeError("the database is not open (call initialize() first)")
        with self._pool.connection() as connection:
            yield connection

    @contextmanager
    def transaction(self, write: bool = False) -> Iterator[Store]:
        """Store 를 트랜잭션 하나에 묶어 준다. write=True 면 쓰기 잠금을 잡아 다른 쓰기와 줄을 세운다."""
        with self.connect() as connection, connection.transaction():
            if write:
                connection.execute("SELECT pg_advisory_xact_lock(%s)", (WRITE_LOCK,))
            else:
                connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            yield Store(connection)

    def __getattr__(self, name: str) -> Callable:
        """Store 의 메서드를 한 번짜리 트랜잭션으로 감싸 그대로 쓸 수 있게 한다 (db.get_batch(id) 처럼).
        이름이 insert_, update_, delete_, set_ 으로 시작하면 쓰기 트랜잭션이다."""
        method = getattr(Store, name, None)
        if name.startswith("_") or method is None:
            raise AttributeError(name)
        write = name.startswith(WRITE_PREFIXES)

        def call(*args, **kwargs):
            with self.transaction(write=write) as store:
                return method(store, *args, **kwargs)

        return call

    # ---- 시작 -------------------------------------------------------------------------------

    def prepare(self) -> list[str]:
        """pool 을 열고 스키마 이전만 한다 (seed 는 하지 않는다). 이번에 적용한 이전 파일 목록."""
        self.open()
        with self.connect() as connection:
            connection.execute("SELECT pg_advisory_lock(%s)", (INIT_LOCK,))
            try:
                return apply_migrations(connection)
            finally:
                connection.execute("SELECT pg_advisory_unlock(%s)", (INIT_LOCK,))

    def initialize(self) -> None:
        """pool 을 열고, 스키마를 이전하고, seed 기록이 없으면 data/ 를 올린다. 프로세스마다 한 번 부른다.
        실패하면 pool 을 닫고 오류를 그대로 올린다."""
        with self._init_lock:
            try:
                self.open()
                with self.connect() as connection:
                    connection.execute("SELECT pg_advisory_lock(%s)", (INIT_LOCK,))
                    try:
                        applied = apply_migrations(connection)
                        if applied:
                            log.info("  schema  applied %s", ", ".join(applied))
                        seeded_at = self._meta(connection, "seededAt")
                        if seeded_at is None:
                            self._seed(connection)
                        else:
                            self.source = "snapshot"
                            self.seeded_at = seeded_at
                    finally:
                        connection.execute("SELECT pg_advisory_unlock(%s)", (INIT_LOCK,))
            except BaseException:
                self.close()
                raise

    def reseed(self) -> None:
        """seed 테이블을 비우고 data/ 를 다시 올린다."""
        with self.connect() as connection:
            self._seed(connection)

    def _seed(self, connection: psycopg.Connection) -> None:
        state = assemble_state(read_seed_files(self.data_dir))
        seeded_at = now_iso()
        write_state(connection, state, seeded_at)
        self.source = "seed"
        self.seeded_at = seeded_at

    @staticmethod
    def _meta(connection: psycopg.Connection, key: str) -> str | None:
        row = connection.execute("SELECT value FROM meta WHERE key = %s", (key,)).fetchone()
        return row["value"] if row else None


def write_state(connection: psycopg.Connection, state: SeedState, seeded_at: str) -> None:
    """seed 테이블을 비우고 state 로 채운다 (트랜잭션 하나). seed 와 예전 SQLite 가져오기(legacy_import)가 함께 쓴다.
    목록의 순서(seq)는 state 의 순서대로 매겨진다."""
    with connection.transaction():
        connection.execute("SELECT pg_advisory_xact_lock(%s)", (WRITE_LOCK,))
        connection.execute(f"TRUNCATE {', '.join(SEED_TABLES)} RESTART IDENTITY")
        with connection.cursor() as cursor:
            cursor.executemany(
                "INSERT INTO templates (id, name, updated_at, doc) VALUES (%s, %s, %s, %s)",
                [(t["id"], t["name"], t["updatedAt"], as_json(t)) for t in state.templates])
            cursor.executemany(
                "INSERT INTO batches (id, name, created_at, doc) VALUES (%s, %s, %s, %s)",
                [(b["id"], b["name"], b["createdAt"], as_json(b)) for b in state.batches])
            cursor.executemany(
                "INSERT INTO hits (id, batch_id, row_index, max_assignments, expiration, doc) VALUES (%s, %s, %s, %s, %s, %s)",
                [(h["HITId"], h["batchId"], h["rowIndex"], h["MaxAssignments"], h["Expiration"], as_json(h)) for h in state.hits])
            cursor.executemany(
                "INSERT INTO assignments (id, hit_id, worker_id, status, submit_time, doc) VALUES (%s, %s, %s, %s, %s, %s)",
                [(a["AssignmentId"], a["HITId"], a["WorkerId"], a["AssignmentStatus"], a["SubmitTime"], as_json(a))
                 for a in state.assignments])
            cursor.executemany(
                "INSERT INTO pools (id, name, doc) VALUES (%s, %s, %s)",
                [(p["id"], p["name"], as_json(p)) for p in state.pools])
            cursor.executemany(
                "INSERT INTO workers (id, doc) VALUES (%s, %s)",
                [(worker_id, as_json(meta)) for worker_id, meta in state.worker_meta.items()])
        connection.execute("INSERT INTO account (id, doc) VALUES ('account', %s)", (as_json(state.account),))
        connection.execute("INSERT INTO meta (key, value) VALUES ('seededAt', %s)", (seeded_at,))


def table_names(connection: psycopg.Connection) -> set[str]:
    """현재 search_path 의 첫 schema 에 있는 테이블 이름 (시험과 진단용)."""
    rows = connection.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()").fetchall()
    return {row["table_name"] for row in rows}

