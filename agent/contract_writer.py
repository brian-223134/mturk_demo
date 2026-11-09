"""Agent 가 Requester 의 prompt 와 데이터 요약으로 자유 계약(task contract)을 쓰는 단계. 실험용이다 (scripts/html_experiment/).

    build_messages(request)                                     요청 → chat completions 의 messages
    write_contract(config, api_key, allow_api, request, log_dir)  OpenRouter 호출 → {"contract", "message", "cannot", "usage", "provider"}

계약은 보여 줄 값(fields)과 문항(questions)을 몇 개든 적고, 문항마다 대조 기준과 attention 을 단다. 가안(rough design)은 쓰지 않는다.
검사·조립은 frontend/src/lib/task-contract.js 가 맡고, 실패하면 오류를 errors 에 담아 다시 부른다. 설명서는 contract_reference.md 다.

명령줄: python3 -m agent.contract_writer <request.json> --out <reply.json> [--log-dir DIR] [--model-config NAME] [--allow-api]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from agent.config import DEFAULT_MODELS_DIR, ModelConfig, load_model_config
from agent.planner.openrouter import OpenRouterPlanner, PlannerError, resolve_api_key

REFERENCE_FILE = Path(__file__).with_name("contract_reference.md")
DEFAULT_MODEL = "deepseek-v4.1-flash"
DEFAULT_ENV_FILE = Path("environment/.env")
TASK_KEYS = ("request", "data")


def reference_text() -> str:
    return REFERENCE_FILE.read_text(encoding="utf-8")


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2)


def build_messages(request: dict) -> list[dict]:
    """요청 {request, data, current?, earlier_requests?, previous?, errors?} → messages.
    current 가 있으면 있는 계약을 요청대로 고치는 수정 요청이다. errors 가 있으면 이전 계약과 오류를 붙인다."""
    task = {key: request[key] for key in TASK_KEYS if key in request}
    current = request.get("current")
    if current:
        task["current"] = current
        if request.get("earlier_requests"):
            task["earlier_requests"] = request["earlier_requests"]
    opening = ("Revise the current task contract as requested." if current else "Write the task contract for this request.") + " Write `message` in the language of `request`."
    messages = [
        {"role": "system", "content": reference_text()},
        {"role": "user", "content": f"{opening}\n\n```json\n{_dump(task)}\n```"},
    ]
    errors = request.get("errors") or []
    if errors:
        messages.append({"role": "assistant", "content": _dump({"contract": request.get("previous")})})
        listed = "\n".join(f"- {error}" for error in errors)
        messages.append({"role": "user", "content": f"The console rejected this contract:\n{listed}\n\nReply with the whole corrected contract."})
    return messages


def write_contract(config: ModelConfig, api_key: str | None, allow_api: bool, request: dict, log_dir: Path | None = None) -> dict:
    """OpenRouter 에 계약을 묻는다. cannot 이면 contract 는 None 이다. 계약 키가 없으면 답 전체를 계약으로 본다(검사가 판단). 실패하면 PlannerError."""
    planner = OpenRouterPlanner(config, api_key=api_key, allow_api=allow_api, log_dir=log_dir)
    reply = planner.complete(build_messages(request))
    message = reply.get("message")
    message = message if isinstance(message, str) and message.strip() else None
    common = {"message": message, "usage": planner.total_usage, "provider": planner.last_provider}
    if reply.get("cannot"):
        return {"contract": None, "cannot": "format", **common}
    contract = reply.get("contract") if "contract" in reply else {k: v for k, v in reply.items() if k != "message"}
    return {"contract": contract, "cannot": None, **common}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m agent.contract_writer", description="Agent 가 자유 계약을 쓴다 (유료 호출).")
    parser.add_argument("request", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--log-dir", type=Path)
    parser.add_argument("--model-config", default=DEFAULT_MODEL)
    parser.add_argument("--models-dir", type=Path, default=DEFAULT_MODELS_DIR)
    parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE)
    parser.add_argument("--allow-api", action="store_true", help="실제 OpenRouter 호출을 허용한다. 없으면 호출 직전에 멈춘다.")
    args = parser.parse_args(argv)
    request = json.loads(args.request.read_text(encoding="utf-8"))
    config = load_model_config(args.model_config, args.models_dir)
    if args.log_dir:
        args.log_dir.mkdir(parents=True, exist_ok=True)
    try:
        result = write_contract(config, resolve_api_key(None, args.env_file), args.allow_api, request, args.log_dir)
    except PlannerError as error:
        args.out.write_text(_dump({"error": str(error)}), encoding="utf-8")
        print(f"error: {error}", file=sys.stderr)
        return 1
    result["model"] = {"name": config.name, "model": config.model, "served_by": result.pop("provider", None)}
    args.out.write_text(_dump(result), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
