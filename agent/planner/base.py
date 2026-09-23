"""planner 공통: Planner 프로토콜, PlannerError, run_plan.

planner는 profile과 prompt를 받아 spec dict를 돌려준다 (검증 전). run_plan이 parse_spec으로 형식을 검사하고,
레코드가 있으면 validate_against_records로 경로가 실제로 풀리는지까지 검사한 뒤 task_spec.json으로 저장한다.

검증에 실패했을 때 planner가 fix(profile, prompt, previous, errors)와 max_retries를 갖고 있으면(OpenRouter)
오류 메시지를 대화에 붙여 그 횟수만큼 다시 묻는다. FilePlanner는 재시도가 없으므로 바로 SpecError가 난다.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Protocol

from agent.spec import SpecError, TaskSpec, parse_spec, spec_to_dict, validate_against_records

SPEC_FILE = "task_spec.json"


class PlannerError(RuntimeError):
    """planner가 spec dict를 만들지 못했을 때 (파일 없음, API 호출 불가, 응답이 JSON이 아님 등)."""


class Planner(Protocol):
    """profile과 prompt로 spec dict를 만드는 객체. name은 로그에 쓰는 짧은 이름이다."""

    name: str

    def plan(self, profile: dict, prompt: str) -> dict: ...


class RetryingPlanner(Planner, Protocol):
    """검증 오류를 받아 다시 시도할 수 있는 planner. run_plan이 max_retries만큼 fix를 부른다."""

    max_retries: int

    def fix(self, profile: dict, prompt: str, previous: dict, errors: list[str]) -> dict: ...


def check_spec_data(data: Any, records: list | None = None) -> tuple[TaskSpec | None, list[str]]:
    """spec dict를 파싱하고, 레코드가 있으면 실측 검사까지 한다. (spec 또는 None, 오류 목록)을 돌려준다."""
    try:
        spec = parse_spec(data)
    except SpecError as error:
        return None, list(error.messages)
    if records:
        errors = validate_against_records(spec, records)
        if errors:
            return None, errors
    return spec, []


def write_spec(spec: TaskSpec, path: Path) -> Path:
    """spec을 보기 좋은 JSON으로 저장한다 (spec_to_dict 형태, ensure_ascii=False)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(spec_to_dict(spec), handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    return path


def run_plan(profile: dict, prompt: str, planner: Planner, out_dir: Path,
             records: list | None = None) -> TaskSpec:
    """planner로 spec을 받아 검증하고 out_dir/task_spec.json에 저장한 뒤 TaskSpec을 돌려준다.

    검증에 실패하면 planner가 fix를 지원할 때 max_retries만큼 오류를 붙여 다시 묻고, 그래도 실패하면 SpecError.
    """
    out_dir = Path(out_dir)
    data = planner.plan(profile, prompt)
    spec, errors = check_spec_data(data, records)

    retries = int(getattr(planner, "max_retries", 0) or 0)
    fix = getattr(planner, "fix", None)
    attempts = 0
    while spec is None and fix is not None and attempts < retries:
        attempts += 1
        data = fix(profile, prompt, data, errors)
        spec, errors = check_spec_data(data, records)

    if spec is None:
        if attempts:
            errors = [f"the spec from {planner.name} is still invalid after {attempts} retry"] + errors
        raise SpecError(errors)
    write_spec(spec, out_dir / SPEC_FILE)
    return spec
