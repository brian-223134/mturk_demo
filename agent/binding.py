"""LLM 이 binding 을 쓰는 단계. binding 은 HIT 데이터의 어떤 값이 rough design 의 어느 칸에 들어갈지 적은 JSON 이다.

    build_messages(request)                        요청 → chat completions 의 messages
    write_binding(config, api_key, allow_api, request, log_dir)  OpenRouter 호출 → {"binding", "message", "cannot", "usage", "provider"}

브라우저가 가안 정의와 데이터 요약(구조와 표본)을 보내므로 원본 파일 전체는 여기로 오지 않는다. binding 의 검사와 템플릿 조립은
브라우저(frontend/src/lib/design-binding.js)에 있고, 검사에 실패하면 브라우저가 오류를 errors 에 담아 다시 부른다.
형식 설명서는 binding_reference.md 다. 예시 binding 이 example/6-rough-design 과 같은지 frontend 테스트가 본다.
요청에 current 가 있으면 있는 binding 을 고치는 수정 요청이다. 답은 고친 binding 전체이고, 할 수 없는 요청이면 cannot 으로 이유를 답한다.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from agent.config import ModelConfig
from agent.planner.openrouter import OpenRouterPlanner

REFERENCE_FILE = Path(__file__).with_name("binding_reference.md")
CANNOT_KINDS = ("layout", "format")


def reference_text() -> str:
    return REFERENCE_FILE.read_text(encoding="utf-8")


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def build_messages(request: dict) -> list[dict]:
    """요청 {design, task_type, prompt, data, current?, earlier_requests?, previous?, errors?} → messages. errors 가 있으면 이전 답과 오류를 대화에 붙인다."""
    task = {"design": request["design"], "task_type": request["task_type"], "request": request["prompt"], "data": request["data"]}
    current = request.get("current")
    if current:
        task["current"] = current
        if request.get("earlier_requests"):
            task["earlier_requests"] = request["earlier_requests"]
    opening = "Revise the current binding as requested." if current else "Write the binding for this task."
    # 설명서 안의 규칙만으로는 한국어 요청에 영어로 답할 때가 있어 요청 바로 앞에서 다시 말한다
    opening += " Write `message` in the language of `request`."
    messages = [
        {"role": "system", "content": reference_text()},
        {"role": "user", "content": f"{opening}\n\n```json\n{_dump(task)}\n```"},
    ]
    errors = request.get("errors") or []
    if errors:
        messages.append({"role": "assistant", "content": _dump(request.get("previous") or {})})
        listed = "\n".join(f"- {error}" for error in errors)
        messages.append({"role": "user", "content": f"The console rejected this binding:\n{listed}\n\nReply with the whole corrected binding."})
    return messages


def write_binding(config: ModelConfig, api_key: str | None, allow_api: bool, request: dict, log_dir: Path | None = None) -> dict:
    """OpenRouter 에 binding 을 묻는다. design 과 task_type 은 사람이 고른 값으로 덮는다. cannot 이면 binding 은 None 이다. 실패하면 PlannerError."""
    planner = OpenRouterPlanner(config, api_key=api_key, allow_api=allow_api, log_dir=log_dir)
    reply = planner.complete(build_messages(request))
    message = reply.pop("message", None)
    message = message if isinstance(message, str) and message.strip() else None
    cannot = reply.pop("cannot", None)
    if cannot:
        # 모르는 값은 format 으로 본다. 가안 전환 안내는 layout 일 때만 보인다
        return {"binding": None, "cannot": cannot if cannot in CANNOT_KINDS else "format", "message": message, "usage": planner.total_usage, "provider": planner.last_provider}
    binding = {**reply, "design": request["design"]["id"], "task_type": request["task_type"]}
    return {"binding": binding, "cannot": None, "message": message, "usage": planner.total_usage, "provider": planner.last_provider}
