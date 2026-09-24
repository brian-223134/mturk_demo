"""테스트가 함께 쓰는 경로와 작은 도구.

경로는 이 파일의 위치(backend/tests/helpers.py)에서 저장소 루트를 찾아 정한다. 그래서 컨테이너(/app)에서도,
호스트에서 backend/ 로 들어가 pytest 를 돌려도 같은 파일을 읽는다. 특정 PC 의 절대 경로는 어디에도 적지 않는다.
"""

from __future__ import annotations

import re
import time
from pathlib import Path

from fastapi.testclient import TestClient

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "data"                                     # 시작 데이터 (seed)
MODELS_DIR = REPO_ROOT / "environment" / "models"                 # 모델 설정 yaml
ROUTES_TS = REPO_ROOT / "prototype" / "src" / "api" / "http" / "routes.ts"   # 경로 표의 원본 (계약서)
EXAMPLE_DIR = REPO_ROOT / "agent" / "examples" / "groundedness"   # LLM 없이 도는 예시 (raw + prompt + spec)

# routes.ts 의 한 줄:  listHits: { method: 'GET', path: '/batches/:batchId/hits', args: ['batchId', 'q'] },
ROUTE_LINE_RE = re.compile(
    r"^(?P<name>\w+):\s*\{\s*method:\s*'(?P<method>GET|POST|PUT|DELETE)',\s*path:\s*'(?P<path>[^']+)',"
    r"\s*args:\s*\[(?P<args>[^\]]*)\]\s*\},?$"
)


def parse_ts_routes(text: str, table: str) -> dict[str, tuple[str, str, tuple[str, ...]]]:
    """routes.ts 의 `export const <table> = { … } as const` 를 {이름: (메서드, 경로, 인자 튜플)} 로 읽는다 (등장 순서대로)."""
    start = text.index(f"export const {table} = {{")
    end = text.index("} as const", start)
    routes: dict[str, tuple[str, str, tuple[str, ...]]] = {}
    for raw_line in text[start:end].splitlines()[1:]:
        line = raw_line.strip()
        if not line or line.startswith("//"):
            continue
        match = ROUTE_LINE_RE.match(line)
        if not match:
            raise ValueError(f"cannot parse a {table} line of routes.ts: {line!r}")
        args = tuple(a.strip().strip("'\"") for a in match["args"].split(",") if a.strip())
        routes[match["name"]] = (match["method"], match["path"], args)
    return routes


def upload(name: str, content: bytes, content_type: str) -> tuple[str, bytes, str]:
    """httpx 의 files= 에 넣는 (파일 이름, 내용, content type)."""
    return (name, content, content_type)


def example_uploads() -> dict[str, tuple[str, bytes, str]]:
    """agent/examples/groundedness 의 세 파일을 POST /api/agent/jobs 의 raw, prompt, spec 으로."""
    return {
        "raw": upload("raw.json", (EXAMPLE_DIR / "raw.json").read_bytes(), "application/json"),
        "prompt": upload("prompt.md", (EXAMPLE_DIR / "prompt.md").read_bytes(), "text/markdown"),
        "spec": upload("task_spec.json", (EXAMPLE_DIR / "task_spec.json").read_bytes(), "application/json"),
    }


def wait_for_job(client: TestClient, job_id: str, timeout: float = 30.0) -> dict:
    """job 이 succeeded 나 failed 가 될 때까지 GET /api/agent/jobs/{id} 를 되풀이한다."""
    deadline = time.monotonic() + timeout
    while True:
        response = client.get(f"/api/agent/jobs/{job_id}")
        assert response.status_code == 200, response.text
        job = response.json()
        if job["status"] in ("succeeded", "failed"):
            return job
        assert time.monotonic() < deadline, f"job {job_id} still {job['status']} after {timeout} s: {job['log']}"
        time.sleep(0.05)


def step_statuses(job: dict) -> dict[str, str]:
    return {step["name"]: step["status"] for step in job["steps"]}
