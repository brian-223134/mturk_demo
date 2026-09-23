"""spec 파일을 그대로 쓰는 planner. LLM 없이 전 과정을 돌리거나, 손으로 쓴 spec을 검증해 저장할 때 쓴다."""

from __future__ import annotations

import json
from pathlib import Path

from agent.planner.base import PlannerError


class FilePlanner:
    """spec_path의 JSON 객체를 spec dict로 돌려준다. 검증과 저장은 run_plan이 한다. 재시도는 없다."""

    name = "file"
    max_retries = 0

    def __init__(self, spec_path: Path | str):
        self.spec_path = Path(spec_path)

    def plan(self, profile: dict, prompt: str) -> dict:
        try:
            with self.spec_path.open(encoding="utf-8") as handle:
                data = json.load(handle)
        except OSError as error:
            raise PlannerError(f"cannot read spec file {self.spec_path}: {error.strerror or error}") from None
        except ValueError as error:
            raise PlannerError(f"{self.spec_path}: invalid JSON: {error}") from None
        if not isinstance(data, dict):
            raise PlannerError(f"{self.spec_path}: the spec must be a JSON object")
        return data
