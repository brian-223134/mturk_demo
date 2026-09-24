"""data/ 폴더(JSON + HTML) → 시작 상태. prototype/src/api/mock/seedFiles.ts 의 assembleState 와 같은 규칙이다.
폴더 구조는 data/README.md 에 있다.

    read_seed_files(data_dir)   data/ 기준 상대 경로 → 내용 (.json 은 파싱된 값, .html 은 문자열)
    assemble_state(files)       templates, batches, hits, assignments, pools, worker_meta, account 를 만든다

템플릿의 placeholders 와 assignment 의 attention 은 파일에 없으므로 여기서 계산한다 (HTML 과 batch 의 attentionRule 로).
파일끼리 맞지 않으면 SeedError 로 어느 파일의 무엇이 잘못됐는지 알린다.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.domain.attention import judge_attention
from app.domain.template import extract_placeholders

DEFAULT_ACCOUNT = {"env": "mock", "AvailableBalance": "500.00"}
BATCH_FILE_RE = re.compile(r"^batches/([^/]+)/batch\.json$")


class SeedError(Exception):
    def __init__(self, file: str, problem: str):
        super().__init__(f"data/{file}: {problem}")


@dataclass
class SeedState:
    templates: list[dict] = field(default_factory=list)
    batches: list[dict] = field(default_factory=list)
    hits: list[dict] = field(default_factory=list)
    assignments: list[dict] = field(default_factory=list)
    pools: list[dict] = field(default_factory=list)
    worker_meta: dict[str, dict] = field(default_factory=dict)
    account: dict = field(default_factory=lambda: dict(DEFAULT_ACCOUNT))


def read_seed_files(data_dir: Path) -> dict[str, Any]:
    """data_dir 아래의 .json 과 .html 을 모두 읽는다. 다른 파일(README.md)은 건너뛴다."""
    data_dir = Path(data_dir)
    if not data_dir.is_dir():
        raise SeedError("", f"seed folder not found: {data_dir}")
    files: dict[str, Any] = {}
    for full in sorted(p for p in data_dir.rglob("*") if p.is_file()):
        path = full.relative_to(data_dir).as_posix()
        if path.endswith(".json"):
            try:
                files[path] = json.loads(full.read_text(encoding="utf-8"))
            except ValueError as error:
                raise SeedError(path, f"invalid JSON ({error})") from None
        elif path.endswith(".html"):
            files[path] = full.read_text(encoding="utf-8")
    return files


def _require_list(files: dict[str, Any], path: str) -> list:
    value = files.get(path)
    if not isinstance(value, list):
        raise SeedError(path, "expected a JSON array")
    return value


def _require_html(files: dict[str, Any], path: str) -> str:
    value = files.get(path)
    if not isinstance(value, str):
        raise SeedError(path, "file is missing")
    return value


def assemble_state(files: dict[str, Any]) -> SeedState:
    state = SeedState()

    for entry in _require_list(files, "templates/index.json"):
        html = _require_html(files, f"templates/{entry['file']}")
        state.templates.append({
            "id": entry["id"],
            "name": entry["name"],
            "html": html,
            "placeholders": extract_placeholders(html),
            "updatedAt": entry["updatedAt"],
        })

    batch_ids = sorted(m.group(1) for m in (BATCH_FILE_RE.match(p) for p in files) if m)
    seen_hits: set[str] = set()
    seen_assignments: set[str] = set()

    for folder in batch_ids:
        directory = f"batches/{folder}"
        batch_file = files[f"{directory}/batch.json"]
        if not isinstance(batch_file, dict):
            raise SeedError(f"{directory}/batch.json", "expected a JSON object")
        if batch_file.get("id") != folder:
            raise SeedError(f"{directory}/batch.json",
                            f'"id" is {json.dumps(batch_file.get("id"))} but the folder is "{folder}"')
        state.batches.append({**batch_file, "templateHtml": _require_html(files, f"{directory}/template.html")})

        hit_ids_here: set[str] = set()
        for hit in _require_list(files, f"{directory}/hits.json"):
            if hit.get("batchId") != folder:
                raise SeedError(f"{directory}/hits.json",
                                f"HIT {hit.get('HITId')} has batchId {json.dumps(hit.get('batchId'))}")
            if hit["HITId"] in seen_hits:
                raise SeedError(f"{directory}/hits.json", f"duplicate HITId {hit['HITId']}")
            seen_hits.add(hit["HITId"])
            hit_ids_here.add(hit["HITId"])
            state.hits.append(hit)

        for assignment in _require_list(files, f"{directory}/assignments.json"):
            if assignment.get("HITId") not in hit_ids_here:
                raise SeedError(f"{directory}/assignments.json",
                                f"assignment {assignment.get('AssignmentId')} points to unknown HIT {assignment.get('HITId')}")
            if assignment["AssignmentId"] in seen_assignments:
                raise SeedError(f"{directory}/assignments.json", f"duplicate AssignmentId {assignment['AssignmentId']}")
            seen_assignments.add(assignment["AssignmentId"])
            state.assignments.append({
                **assignment,
                "attention": judge_attention(assignment.get("answers", []), batch_file.get("attentionRule")),
            })

    if "pools.json" in files:
        state.pools = _require_list(files, "pools.json")
    workers = files.get("workers.json")
    state.worker_meta = workers if isinstance(workers, dict) else {}
    account = files.get("account.json")
    state.account = account if isinstance(account, dict) else dict(DEFAULT_ACCOUNT)
    return state
