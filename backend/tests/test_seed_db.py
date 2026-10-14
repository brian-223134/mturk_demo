"""data/ 폴더 → PostgreSQL seed. 규모(data/README.md, health 의 counts), seed 와 snapshot 의 구분, 깨진 seed 폴더의 SeedError,
스키마 이전(app/schema.py)과 트랜잭션의 읽기 전용 구분.

기대값은 prototype/src/api/mock/data.test.ts 와 같다: 템플릿 2, batch 3, HIT 72 (40 + 16 + 16), assignment 231
(132 + 51 + 48), pool 2, worker 60.
"""

from __future__ import annotations

import shutil
from collections import Counter
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.db import table_names
from app.main import create_app
from app.schema import apply_migrations, migration_files
from app.seed import SeedError, assemble_state, read_seed_files
from helpers import DATA_DIR

EXPECTED_COUNTS = {"templates": 2, "batches": 3, "hits": 72, "assignments": 231, "pools": 2, "workers": 60}


def test_assemble_state_from_data() -> None:
    """data/ 를 읽어 만든 상태의 규모와, 파일에 없어서 계산하는 값(placeholders, attention)."""
    files = read_seed_files(DATA_DIR)
    assert "README.md" not in files, "only .json and .html are read"
    state = assemble_state(files)

    assert [t["id"] for t in state.templates] == ["tpl-chunk-fact-relevance", "tpl-query-fact-coverage"]
    for template in state.templates:
        assert "<crowd-form>" in template["html"]
        assert len(template["placeholders"]) == 12  # data.test.ts 규칙 6

    assert [b["id"] for b in state.batches] == ["batch-1000001", "batch-1000002", "batch-1000003"]
    for batch in state.batches:
        # batch 의 템플릿 사본은 같은 폴더의 template.html 에서 온다
        assert batch["templateHtml"] == (DATA_DIR / "batches" / batch["id"] / "template.html").read_text(encoding="utf-8")
        assert batch["settings"]["MaxAssignments"] == 3  # data.test.ts 규칙 5

    assert len(state.hits) == 72
    assert len(state.assignments) == 231
    assert all(a["attention"] is not None for a in state.assignments)
    assert len({a["WorkerId"] for a in state.assignments}) == 60
    assert [p["name"] for p in state.pools] == ["Trusted", "Excluded"]
    assert state.account == {"env": "mock", "AvailableBalance": "500.00"}

    # F1 의 검수 상태와 attention 판정의 분포 (data.test.ts: 판정은 실제 검수 결과와 일치하지 않는다)
    f1_hits = {h["HITId"] for h in state.hits if h["batchId"] == "batch-1000001"}
    table = Counter(
        f"{a['AssignmentStatus']}/{'pass' if a['attention']['passed'] else 'fail'}"
        for a in state.assignments if a["HITId"] in f1_hits
    )
    assert table == {"Approved/pass": 94, "Approved/fail": 14, "Rejected/fail": 11, "Rejected/pass": 7, "Submitted/pass": 6}


def test_seed_then_snapshot(make_database) -> None:
    """빈 DB 는 data/ 로 채우고(seed), 같은 DB 를 다시 열면 DB 의 내용을 쓴다(snapshot)."""
    first = make_database()
    first.initialize()
    assert first.source == "seed"
    assert first.seeded_at
    assert first.counts() == EXPECTED_COUNTS
    first.close()

    second = make_database()
    second.initialize()
    assert second.source == "snapshot"
    assert second.seeded_at == first.seeded_at
    assert second.counts() == EXPECTED_COUNTS


def test_health_reports_seed_then_snapshot(make_client) -> None:
    """앱을 처음 켜면 health 의 source 가 seed, 같은 DB 파일로 다시 켜면 snapshot 이다."""
    with make_client() as client:
        assert client.get("/api/health").json() == {"status": "ok", "source": "seed", "counts": EXPECTED_COUNTS}
    with make_client() as client:
        assert client.get("/api/health").json() == {"status": "ok", "source": "snapshot", "counts": EXPECTED_COUNTS}


def test_reseed_replaces_everything(make_database) -> None:
    db = make_database()
    db.initialize()
    with db.transaction(write=True) as store:
        store.connection.execute("DELETE FROM pools")
    assert db.counts()["pools"] == 0
    db.reseed()
    assert db.source == "seed"
    assert db.counts() == EXPECTED_COUNTS


def test_read_order_and_lookups(make_database) -> None:
    db = make_database()
    db.initialize()
    assert [t["id"] for t in db.list_templates()] == ["tpl-query-fact-coverage", "tpl-chunk-fact-relevance"]  # updatedAt 내림차순
    assert db.get_template("nope") is None
    assert [b["id"] for b in db.list_batches()] == ["batch-1000001", "batch-1000002", "batch-1000003"]        # seed 순서
    assert db.get_batch("nope") is None
    assert len(db.hits_of_batch("batch-1000001")) == 40
    counts = db.assignment_counts_of_batch("batch-1000001")
    assert sum(c.approved for c in counts.values()) == 108
    assert sum(c.rejected for c in counts.values()) == 18
    assert sum(c.submitted for c in counts.values()) == 6
    assert db.account() == {"env": "mock", "AvailableBalance": "500.00"}


def test_documents_round_trip_unchanged(make_database) -> None:
    """저장한 문서가 키 순서까지 그대로 돌아온다 (doc 이 JSONB 가 아니라 JSON 인 이유). 1.0 은 1 로 저장된다."""
    db = make_database()
    db.initialize()
    state = assemble_state(read_seed_files(DATA_DIR))
    assert list(db.get_batch("batch-1000001")) == list(state.batches[0])
    hit = db.hit_docs_of_batch("batch-1000001")[0]
    assert list(hit["input"]) == list(state.hits[0]["input"])
    assert hit == state.hits[0]

    pool = {"id": "pool-x", "name": "X", "workerIds": [], "score": 1.0, "nested": {"b": 2, "a": 1}}
    db.insert_pool(pool)
    saved = db.get_pool("pool-x")
    assert saved == {"id": "pool-x", "name": "X", "workerIds": [], "score": 1, "nested": {"b": 2, "a": 1}}
    assert isinstance(saved["score"], int) and list(saved["nested"]) == ["b", "a"]


def test_read_transactions_are_read_only(make_database) -> None:
    """write=False 인 트랜잭션에서 쓰면 PostgreSQL 이 거부한다 (쓰기 잠금 없이 쓰는 실수를 막는다)."""
    db = make_database()
    db.initialize()
    with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
        with db.transaction() as store:
            store.insert_pool({"id": "pool-x", "name": "X", "workerIds": []})
    assert db.get_pool("pool-x") is None
    db.insert_pool({"id": "pool-x", "name": "X", "workerIds": []})  # 한 번짜리 insert_ 는 쓰기 트랜잭션이다
    assert db.get_pool("pool-x")["name"] == "X"


def test_migrations_apply_once_and_roll_back_on_failure(tmp_path: Path, make_database) -> None:
    """이전 파일은 한 번만 적용되고, 실패한 파일은 DDL 까지 통째로 되돌아간다 (다음에 다시 시도)."""
    db = make_database()
    db.open()
    folder = tmp_path / "migrations"
    folder.mkdir()
    (folder / "0001_first.sql").write_text("CREATE TABLE first_table (id TEXT PRIMARY KEY);", encoding="utf-8")
    (folder / "0002_broken.sql").write_text(
        "CREATE TABLE second_table (id TEXT PRIMARY KEY);\nINSERT INTO no_such_table VALUES (1);", encoding="utf-8")
    with db.connect() as connection:
        with pytest.raises(psycopg.errors.UndefinedTable):
            apply_migrations(connection, folder)
        assert {"first_table", "schema_migrations"} <= table_names(connection)
        assert "second_table" not in table_names(connection)

        (folder / "0002_broken.sql").write_text("CREATE TABLE second_table (id TEXT PRIMARY KEY);", encoding="utf-8")
        assert apply_migrations(connection, folder) == ["0002_broken"]
        assert apply_migrations(connection, folder) == []
        versions = [row["version"] for row in connection.execute("SELECT version FROM schema_migrations ORDER BY version")]
        assert versions == ["0001_first", "0002_broken"]

    (folder / "notes.sql").write_text("-- not a migration", encoding="utf-8")
    with pytest.raises(ValueError, match="notes.sql"):
        migration_files(folder)


def test_broken_seed_folder_missing_file(tmp_path: Path, make_database, make_client) -> None:
    """data/ 의 임시 사본에서 템플릿 HTML 하나를 지우면 어느 파일이 없는지 SeedError 로 알린다. 앱도 시작하지 못한다."""
    broken = tmp_path / "data"
    shutil.copytree(DATA_DIR, broken)
    (broken / "templates" / "chunk-fact-relevance.html").unlink()

    with pytest.raises(SeedError, match=r"data/templates/chunk-fact-relevance\.html: file is missing"):
        make_database(broken).initialize()

    with pytest.raises(SeedError, match=r"chunk-fact-relevance\.html"):
        with make_client(data_dir=broken):
            pass


def test_broken_seed_unknown_hit() -> None:
    """assignment 가 없는 HIT 를 가리키면 파일 이름과 함께 알린다 (data.test.ts 와 같은 경우)."""
    files = read_seed_files(DATA_DIR)
    files["batches/batch-1000001/assignments.json"][0]["HITId"] = "NO_SUCH_HIT"
    with pytest.raises(SeedError, match=r"data/batches/batch-1000001/assignments\.json: .*NO_SUCH_HIT"):
        assemble_state(files)


def test_missing_seed_folder(tmp_path: Path, make_database) -> None:
    with pytest.raises(SeedError, match="seed folder not found"):
        make_database(tmp_path / "no-such-data").initialize()


def test_create_app_does_not_touch_db_before_lifespan(make_settings, make_database) -> None:
    """create_app 만으로는 DB 에 테이블을 만들지도, job 폴더를 만들지도 않는다 (lifespan 에서 만든다)."""
    settings = make_settings()
    create_app(settings)
    probe = make_database()
    probe.open()
    with probe.connect() as connection:
        assert table_names(connection) == set()
    assert not settings.output_dir.exists()
    with TestClient(create_app(settings)):
        with probe.connect() as connection:
            assert {"templates", "assignments", "schema_migrations"} <= table_names(connection)
        assert settings.jobs_dir.is_dir()
