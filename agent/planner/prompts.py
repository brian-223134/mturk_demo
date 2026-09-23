"""planner 프롬프트 조립.

    시스템 프롬프트 = 역할 설명 + spec_reference.md 전문(실행 시점에 읽는다) + 출력 규칙
    사용자 메시지   = profile_for_prompt로 줄인 profile JSON + 사용자의 prompt (최대 글자 수는 모델 설정의 profile_max_chars)
    재시도          = 직전 답(assistant) + 검증 오류 목록과 고쳐 달라는 요청(user)을 뒤에 붙인다
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from agent.config import DEFAULT_PROFILE_MAX_CHARS
from agent.profile import profile_for_prompt

REFERENCE_PATH = Path(__file__).resolve().parent.parent / "spec_reference.md"

ROLE = """You are the planner of an annotation pipeline for Amazon Mechanical Turk.

A requester describes what crowd workers should judge, and a program has already profiled the raw data.
Your only job is to write the task spec: one JSON object that tells deterministic code how to cut the data
into HIT items, which fields to show, what question to ask with which options, where the reference labels
are, and how to build attention checks. The code never asks you again, so the spec must be complete and
correct on its own. The spec format follows."""

OUTPUT_RULES = """Output rules:
- Reply with exactly one JSON object and nothing else: no markdown code fences, no comments, no text before or after it.
- Include every key listed in the reference (use null where the reference allows it). No unknown keys, no trailing commas.
- Use only paths that appear in the data profile. Do not invent keys. Map keys shown as {key} in the profile are addressed with a variable, for example ['Passage {passage_no}'] or ['Fact {target_no}'].
- Field labels, the question, option labels and every instruction are read by workers: write them in plain English and never mention model names, retriever names or dataset names.
- Follow the requester's prompt for what to show, what to judge, the HIT size and the attention check. Where the prompt is silent, follow the guidance in the reference."""


def spec_reference() -> str:
    """spec_reference.md 전문. 프롬프트마다 다시 읽으므로 문서를 고치면 바로 반영된다."""
    return REFERENCE_PATH.read_text(encoding="utf-8")


def system_prompt() -> str:
    return f"{ROLE}\n\n{spec_reference().strip()}\n\n{OUTPUT_RULES}"


def user_prompt(profile: dict, prompt: str, profile_max_chars: int = DEFAULT_PROFILE_MAX_CHARS) -> str:
    compact = profile_for_prompt(profile, profile_max_chars)
    profile_json = json.dumps(compact, ensure_ascii=False, indent=1)
    return (f"## Data profile (JSON)\n{profile_json}\n\n"
            f"## What the requester wants\n{prompt.strip()}\n\n"
            "Write the task spec for this data and this goal.")


def previous_text(previous: Any) -> str:
    """재시도 대화에 넣을 직전 답. dict면 JSON 문자열로 바꾼다."""
    if previous is None:
        return "{}"
    if isinstance(previous, str):
        return previous
    return json.dumps(previous, ensure_ascii=False, indent=2)


def fix_prompt(errors: list[str]) -> str:
    listed = "\n".join(f"- {message}" for message in errors)
    return (f"The spec above failed validation:\n{listed}\n\n"
            "Fix every problem and reply again with the complete corrected JSON object "
            "(the whole spec, not only the changed keys), following the same output rules.")


def build_messages(profile: dict, prompt: str, errors: list[str] | None = None,
                   previous: Any = None, profile_max_chars: int = DEFAULT_PROFILE_MAX_CHARS) -> list[dict]:
    """chat completions에 보낼 메시지 목록. errors가 있으면 직전 답과 수정 요청을 뒤에 붙인다."""
    messages = [{"role": "system", "content": system_prompt()},
                {"role": "user", "content": user_prompt(profile, prompt, profile_max_chars)}]
    if errors:
        messages.append({"role": "assistant", "content": previous_text(previous)})
        messages.append({"role": "user", "content": fix_prompt(list(errors))})
    return messages
