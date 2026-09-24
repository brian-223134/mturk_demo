"""data/ 폴더 → SQLite seed. 규모(data/README.md, health 의 counts), seed 와 snapshot 의 구분, 깨진 seed 폴더의 SeedError.

기대값은 prototype/src/api/mock/data.test.ts 와 같다: 템플릿 2, batch 3, HIT 72 (40 + 16 + 16), assignment 231
(132 + 51 + 48), pool 2, worker 60.
"""

from __future__ import annotations

import shutil
from collections import Counter
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.db import Database
from app.main import create_app
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


def test_seed_then_snapshot(tmp_path: Path) -> None:
    """빈 DB 는 data/ 로 채우고(seed), 같은 파일을 다시 열면 DB 의 내용을 쓴다(snapshot)."""
    db_path = tmp_path / "var" / "backend.sqlite"
    first = Database(db_path, DATA_DIR)
    first.initialize()
    assert first.source == "seed"
    assert first.seeded_at
    assert first.counts() == EXPECTED_COUNTS

    second = Database(db_path, DATA_DIR)
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


def test_reseed_replaces_everything(tmp_path: Path) -> None:
    db = Database(tmp_path / "db.sqlite", DATA_DIR)
    db.initialize()
    with db.connect() as connection:
        connection.execute("DELETE FROM pools")
    assert db.counts()["pools"] == 0
    db.reseed()
    assert db.source == "seed"
    assert db.counts() == EXPECTED_COUNTS


def test_read_order_and_lookups(tmp_path: Path) -> None:
    db = Database(tmp_path / "db.sqlite", DATA_DIR)
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


def test_broken_seed_folder_missing_file(tmp_path: Path, make_client) -> None:
    """data/ 의 임시 사본에서 템플릿 HTML 하나를 지우면 어느 파일이 없는지 SeedError 로 알린다. 앱도 시작하지 못한다."""
    broken = tmp_path / "data"
    shutil.copytree(DATA_DIR, broken)
    (broken / "templates" / "chunk-fact-relevance.html").unlink()

    with pytest.raises(SeedError, match=r"data/templates/chunk-fact-relevance\.html: file is missing"):
        Database(tmp_path / "db.sqlite", broken).initialize()

    with pytest.raises(SeedError, match=r"chunk-fact-relevance\.html"):
        with make_client(data_dir=broken, db_path=tmp_path / "app.sqlite"):
            pass


def test_broken_seed_unknown_hit() -> None:
    """assignment 가 없는 HIT 를 가리키면 파일 이름과 함께 알린다 (data.test.ts 와 같은 경우)."""
    files = read_seed_files(DATA_DIR)
    files["batches/batch-1000001/assignments.json"][0]["HITId"] = "NO_SUCH_HIT"
    with pytest.raises(SeedError, match=r"data/batches/batch-1000001/assignments\.json: .*NO_SUCH_HIT"):
        assemble_state(files)


def test_missing_seed_folder(tmp_path: Path) -> None:
    with pytest.raises(SeedError, match="seed folder not found"):
        Database(tmp_path / "db.sqlite", tmp_path / "no-such-data").initialize()


def test_create_app_does_not_touch_disk_before_lifespan(make_settings) -> None:
    """create_app 만으로는 DB 도 job 폴더도 만들지 않는다 (lifespan 에서 만든다)."""
    settings = make_settings()
    create_app(settings)
    assert not settings.db_path.exists()
    assert not settings.output_dir.exists()
    with TestClient(create_app(settings)):
        assert settings.db_path.exists()
        assert settings.jobs_dir.is_dir()
