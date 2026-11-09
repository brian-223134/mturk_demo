"""그려진 task 페이지가 Requester 가 요청한 배치·표현대로인지 LLM 이 판정하는 단계 (요청한 배치의 자동 확인).

    build_messages(request)                                   요청 → chat completions 의 messages
    judge_layout(config, api_key, allow_api, request, log_dir)  OpenRouter 호출 → {"checks", "message", "usage", "provider"}

브라우저가 페이지를 실제로 그린 뒤 잰 값(칸의 위치·폭·탭·굵기·색)을 보낸다. HTML 이나 페이지를 쓴 Agent 의 설명이 아니라
그려진 결과로 판정하게 하려는 것이다. 판정이 틀릴 수 있으므로 결과는 페이지를 버리는 데 쓰지 않고, 고쳐 달라는 요청과 경고로만 쓴다.
설명서는 layout_reference.md 다.

명령줄: python3 -m agent.layout_judge <request.json> --out <reply.json> [--log-dir DIR] [--model-config NAME] [--allow-api]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from agent.config import DEFAULT_MODELS_DIR, ModelConfig, load_model_config
from agent.planner.openrouter import OpenRouterPlanner, PlannerError, resolve_api_key

REFERENCE_FILE = Path(__file__).with_name("layout_reference.md")
DEFAULT_MODEL = "deepseek-v4.1-flash"
DEFAULT_ENV_FILE = Path("environment/.env")
RESULTS = ("met", "not_met", "unclear")


def reference_text() -> str:
    return REFERENCE_FILE.read_text(encoding="utf-8")


def build_messages(request: dict) -> list[dict]:
    """요청 {request, page, fixed?} → messages. fixed 는 계약이 정해서 페이지가 바꿀 수 없는 것들이다."""
    task = {"request": request["request"], "page": request["page"]}
    if request.get("fixed"):
        task["fixed"] = request["fixed"]
    opening = "Check the drawn page against the request. Write `wish`, `evidence` and `message` in the language of `request`."
    return [
        {"role": "system", "content": reference_text()},
        {"role": "user", "content": f"{opening}\n\n```json\n{json.dumps(task, ensure_ascii=False, indent=2)}\n```"},
    ]


def _checks(value: Any) -> list[dict]:
    """모양이 맞는 판정만 남긴다. 결과 값이 셋 중 하나가 아니면 unclear 로 본다."""
    checks = []
    for item in value if isinstance(value, list) else []:
        if not isinstance(item, dict) or not isinstance(item.get("wish"), str) or not item["wish"].strip():
            continue
        result = item.get("result") if item.get("result") in RESULTS else "unclear"
        evidence = item.get("evidence") if isinstance(item.get("evidence"), str) else ""
        checks.append({"wish": item["wish"].strip(), "result": result, "evidence": evidence.strip()})
    return checks


def judge_layout(config: ModelConfig, api_key: str | None, allow_api: bool, request: dict, log_dir: Path | None = None) -> dict:
    """OpenRouter 에 판정을 묻는다. 실패하면 PlannerError."""
    planner = OpenRouterPlanner(config, api_key=api_key, allow_api=allow_api, log_dir=log_dir)
    reply = planner.complete(build_messages(request))
    message = reply.get("message")
    return {"checks": _checks(reply.get("checks")), "message": message.strip() if isinstance(message, str) and message.strip() else None,
            "usage": planner.total_usage, "provider": planner.last_provider}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m agent.layout_judge", description="그려진 페이지가 요청한 배치대로인지 판정한다 (유료 호출).")
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
        result = judge_layout(config, resolve_api_key(None, args.env_file), args.allow_api, request, args.log_dir)
    except PlannerError as error:
        args.out.write_text(json.dumps({"error": str(error)}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"error: {error}", file=sys.stderr)
        return 1
    result["model"] = {"name": config.name, "model": config.model, "served_by": result.pop("provider", None)}
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
