"""Job 의 모양. GET /api/agent/jobs/{id} 가 돌려주는 JSON 과 job 폴더의 job.json 이 같은 형태다.

    {"id": "job-YYYYMMDD-HHMMSS-<4 hex>", "name", "status": queued|running|succeeded|failed,
     "created_at", "started_at", "finished_at",
     "input": {"raw": 원본 파일 이름, "prompt": 파일 이름 | "prompt_text" | null, "spec": 파일 이름 | null},
     "planner": {"mode": file|openrouter, "model_config": 이름 | null, "allow_api": bool},
     "steps": [{"name": profile|plan|preprocess|render|validate, "status": pending|running|succeeded|failed|skipped,
                "started_at", "finished_at", "error"}],
     "log": ["<ISO 시각> <메시지>", …], "planner_notes", "summary", "validation", "usage", "files", "error"}
"""

from __future__ import annotations

import secrets
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

STEP_NAMES = ("profile", "plan", "preprocess", "render", "validate")
# files 목록에서 앞에 두는 이름과 순서. 그 밖의 파일(plan_request.json 등)은 이름순으로 뒤에 붙는다.
KNOWN_FILES = ("profile.json", "profile.md", "task_spec.json", "hits.csv", "settings.json", "items.jsonl",
               "summary.json", "template.html", "validation.json")
JOB_FILE = "job.json"
INPUT_DIR = "input"
PROMPT_TEXT_FILE = "prompt_text.md"   # prompt_text 로 받은 본문을 input/ 에 저장하는 이름
PROMPT_TEXT_MARKER = "prompt_text"    # input.prompt 에 적는 표시


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_job_id(now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    return f"job-{now.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(2)}"


@dataclass
class Step:
    name: str
    status: str = "pending"
    started_at: str | None = None
    finished_at: str | None = None
    error: str | None = None


@dataclass
class JobInput:
    raw: str
    prompt: str | None = None
    spec: str | None = None


@dataclass
class PlannerInfo:
    mode: str                       # file | openrouter
    model_config: str | None = None
    allow_api: bool = False


@dataclass
class Job:
    id: str
    name: str
    input: JobInput
    planner: PlannerInfo
    status: str = "queued"
    created_at: str = field(default_factory=now_iso)
    started_at: str | None = None
    finished_at: str | None = None
    steps: list[Step] = field(default_factory=lambda: [Step(name) for name in STEP_NAMES])
    log: list[str] = field(default_factory=list)
    planner_notes: str | None = None
    summary: dict | None = None
    validation: dict | None = None
    usage: dict | None = None
    files: list[str] = field(default_factory=list)
    error: str | None = None

    def step(self, name: str) -> Step:
        for step in self.steps:
            if step.name == name:
                return step
        raise KeyError(name)

    def add_log(self, message: str) -> str:
        line = f"{now_iso()} {message}"
        self.log.append(line)
        return line

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "status": self.status,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "input": asdict(self.input),
            "planner": asdict(self.planner),
            "steps": [asdict(step) for step in self.steps],
            "log": list(self.log),
            "planner_notes": self.planner_notes,
            "summary": self.summary,
            "validation": self.validation,
            "usage": self.usage,
            "files": list(self.files),
            "error": self.error,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Job":
        steps = [Step(**{k: s.get(k) for k in ("name", "status", "started_at", "finished_at", "error")})
                 for s in data.get("steps", [])]
        known = {step.name for step in steps}
        steps.extend(Step(name) for name in STEP_NAMES if name not in known)
        return cls(
            id=str(data["id"]),
            name=str(data.get("name") or data["id"]),
            input=JobInput(**{k: data.get("input", {}).get(k) for k in ("raw", "prompt", "spec")}),
            planner=PlannerInfo(
                mode=str(data.get("planner", {}).get("mode") or "file"),
                model_config=data.get("planner", {}).get("model_config"),
                allow_api=bool(data.get("planner", {}).get("allow_api", False)),
            ),
            status=str(data.get("status") or "queued"),
            created_at=str(data.get("created_at") or now_iso()),
            started_at=data.get("started_at"),
            finished_at=data.get("finished_at"),
            steps=steps,
            log=[str(line) for line in data.get("log", [])],
            planner_notes=data.get("planner_notes"),
            summary=data.get("summary"),
            validation=data.get("validation"),
            usage=data.get("usage"),
            files=[str(name) for name in data.get("files", [])],
            error=data.get("error"),
        )


def order_files(names: list[str]) -> list[str]:
    """KNOWN_FILES 순서로 먼저, 나머지는 이름순."""
    present = set(names)
    ordered = [name for name in KNOWN_FILES if name in present]
    ordered.extend(sorted(name for name in present if name not in KNOWN_FILES))
    return ordered


def usage_dict(total: dict | None) -> dict | None:
    """OpenRouterPlanner.total_usage → {"calls", "prompt_tokens", "completion_tokens", "total_tokens", "cost"}."""
    if not isinstance(total, dict):
        return None

    def integer(key: str) -> int:
        value = total.get(key, 0)
        return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0

    cost = total.get("cost")
    return {
        "calls": integer("calls"),
        "prompt_tokens": integer("prompt_tokens"),
        "completion_tokens": integer("completion_tokens"),
        "total_tokens": integer("total_tokens"),
        "cost": float(cost) if isinstance(cost, (int, float)) and not isinstance(cost, bool) else None,
    }
