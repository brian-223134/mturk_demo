"""예전 SQLite 저장소 → PostgreSQL 가져오기 (app/legacy_import.py).

예전 backend 가 만들던 모양(스키마 version 1)의 SQLite 파일을 테스트 안에서 만들고, 콘솔에서 바꾼 것처럼 템플릿 하나를 더하고
검수 결과 하나를 바꾼 뒤 가져온다. 순서(seq), 문서 내용, seededAt 이 그대로 옮겨지는지와 --replace 없이 덮어쓰지 않는지를 본다.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from app.legacy_import import LegacyImportError, import_sqlite, main, read_sqlite
from app.seed import assemble_state, read_seed_files
from helpers import DATA_DIR

# 예전 backend/app/db.py 의 SCHEMA (version 1) 그대로
LEGACY_SCHEMA = """
CREATE TABLE meta        (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE templates   (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name TEXT NOT NULL, updated_at TEXT NOT NULL, doc TEXT NOT NULL);
CREATE TABLE batches     (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, doc TEXT NOT NULL);
CREATE TABLE hits        (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, batch_id TEXT NOT NULL, row_index INTEGER NOT NULL,
                          max_assignments INTEGER NOT NULL, expiration TEXT NOT NULL, doc TEXT NOT NULL);
CREATE TABLE assignments (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, hit_id TEXT NOT NULL, worker_id TEXT NOT NULL,
                          status TEXT NOT NULL, submit_time TEXT NOT NULL, doc TEXT NOT NULL);
CREATE TABLE pools       (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, name TEXT NOT NULL, doc TEXT NOT NULL);
CREATE TABLE workers     (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, doc TEXT NOT NULL);
CREATE TABLE account     (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
"""
SEEDED_AT = "2026-09-25T01:02:03.456Z"
ADDED_TEMPLATE = {"id": "tpl-added-in-console", "name": "Added later", "html": "<p>${text}</p>", "placeholders": ["text"],
                  "updatedAt": "2026-10-01T00:00:00.000Z"}


def build_legacy_sqlite(path: Path, version: str = "1") -> dict:
    """data/ 의 seed 에 콘솔에서 생긴 변경 두 가지를 더한 SQLite 파일. 바꾼 assignment 를 돌려준다."""
    state = assemble_state(read_seed_files(DATA_DIR))
    state.templates.append(ADDED_TEMPLATE)
    changed = dict(state.assignments[-1], AssignmentStatus="Rejected", RequesterFeedback="checked in the console")
    state.assignments[-1] = changed
    state.worker_meta = {"W-legacy": {"note": "kept", "blocked": True, "blockReason": "spam"}}

    connection = sqlite3.connect(path)
    connection.executescript(LEGACY_SCHEMA)
    dump = lambda doc: json.dumps(doc, ensure_ascii=False, separators=(",", ":"))  # noqa: E731
    # 템플릿은 일부러 거꾸로 넣고 seq 는 원래 순서로 매겨, 가져오기가 넣은 순서(rowid)가 아니라 seq 를 따르는지 본다
    last = len(state.templates) - 1
    connection.executemany("INSERT INTO templates VALUES (?, ?, ?, ?, ?)",
                           [(t["id"], last - i, t["name"], t["updatedAt"], dump(t)) for i, t in enumerate(reversed(state.templates))])
    connection.executemany("INSERT INTO batches VALUES (?, ?, ?, ?, ?)",
                           [(b["id"], i, b["name"], b["createdAt"], dump(b)) for i, b in enumerate(state.batches)])
    connection.executemany("INSERT INTO hits VALUES (?, ?, ?, ?, ?, ?, ?)",
                           [(h["HITId"], i, h["batchId"], h["rowIndex"], h["MaxAssignments"], h["Expiration"], dump(h))
                            for i, h in enumerate(state.hits)])
    connection.executemany("INSERT INTO assignments VALUES (?, ?, ?, ?, ?, ?, ?)",
                           [(a["AssignmentId"], i, a["HITId"], a["WorkerId"], a["AssignmentStatus"], a["SubmitTime"], dump(a))
                            for i, a in enumerate(state.assignments)])
    connection.executemany("INSERT INTO pools VALUES (?, ?, ?, ?)", [(p["id"], i, p["name"], dump(p)) for i, p in enumerate(state.pools)])
    connection.executemany("INSERT INTO workers VALUES (?, ?, ?)", [(k, i, dump(v)) for i, (k, v) in enumerate(state.worker_meta.items())])
    connection.execute("INSERT INTO account VALUES ('account', ?)", (dump({"env": "mock", "AvailableBalance": "321.50"}),))
    connection.executemany("INSERT INTO meta VALUES (?, ?)", [("version", version), ("seededAt", SEEDED_AT)])
    connection.commit()
    connection.close()
    return changed


def test_read_sqlite_follows_seq_order(tmp_path: Path) -> None:
    path = tmp_path / "backend.sqlite"
    build_legacy_sqlite(path)
    state, seeded_at = read_sqlite(path)
    assert seeded_at == SEEDED_AT
    # 넣은 순서와 달리 seq 순서: 콘솔에서 더한 템플릿이 맨 뒤
    assert [t["id"] for t in state.templates] == ["tpl-chunk-fact-relevance", "tpl-query-fact-coverage", "tpl-added-in-console"]
    assert len(state.hits) == 72 and len(state.assignments) == 231
    assert state.account["AvailableBalance"] == "321.50"


def test_import_into_fresh_database(tmp_path: Path, make_database, make_client) -> None:
    """빈 DB 로 옮기면 스키마 이전까지 하고, 앱을 켜면 seed 하지 않고 옮긴 내용을 그대로 쓴다."""
    path = tmp_path / "backend.sqlite"
    changed = build_legacy_sqlite(path)
    counts = import_sqlite(make_database(), path)
    assert counts == {"templates": 3, "batches": 3, "hits": 72, "assignments": 231, "pools": 2, "workers": 61}

    with make_client() as client:
        health = client.get("/api/health").json()
        assert health["source"] == "snapshot" and health["counts"] == counts
        assert "tpl-added-in-console" in [t["id"] for t in client.get("/api/templates").json()]
        worker = client.get("/api/workers/W-legacy").json()
        assert worker["blocked"] is True and worker["note"] == "kept"
    db = make_database()
    db.open()
    assert db.get_assignments([changed["AssignmentId"]])[changed["AssignmentId"]] == changed
    assert db.account() == {"env": "mock", "AvailableBalance": "321.50"}
    assert db.list_batches()[0]["id"] == "batch-1000001"


def test_import_needs_replace_over_existing_data(tmp_path: Path, make_database) -> None:
    """backend 가 이미 seed 한 DB 에는 --replace 없이 덮어쓰지 않는다."""
    path = tmp_path / "backend.sqlite"
    build_legacy_sqlite(path)
    db = make_database()
    db.initialize()

    with pytest.raises(LegacyImportError, match="--replace"):
        import_sqlite(db, path)
    assert db.counts()["templates"] == 2

    import_sqlite(db, path, replace=True)
    assert db.counts()["templates"] == 3


def test_wrong_version_and_missing_file(tmp_path: Path, make_database, database_url: str, capsys) -> None:
    path = tmp_path / "backend.sqlite"
    build_legacy_sqlite(path, version="2")
    with pytest.raises(LegacyImportError, match="schema version '2'"):
        read_sqlite(path)

    assert main([str(tmp_path / "nope.sqlite"), "--database-url", database_url]) == 1
    assert "SQLite file not found" in capsys.readouterr().err
