"""planner 프롬프트 조립. 프롬프트는 전부 영어다 (모델이 영어 지시를 더 안정적으로 따른다).

    시스템 프롬프트 = 역할 설명(ROLE: 두 가지 일과 작업 순서) + spec_reference.md(실행 시점에 읽는다) + 출력 규칙
    예시 대화       = user(합성 예시의 profile + prompt.md) + assistant(그 예시의 task_spec.json 원문)
    사용자 메시지   = profile_for_prompt로 줄인 profile JSON + 사용자의 prompt (최대 글자 수는 모델 설정의 profile_max_chars)
    재시도          = 직전 답(assistant) + 검증 오류 목록과 고쳐 달라는 요청(user)을 뒤에 붙인다

메시지 순서는 [system, user(예시 작업), assistant(예시 spec), user(실제 작업)] 이고 재시도 쌍은 그 뒤에 붙는다.
예시는 agent/examples/groundedness/ 의 raw.json(profile_records + profile_for_prompt, 최대 EXAMPLE_PROFILE_MAX_CHARS 자),
prompt.md, task_spec.json 이며 프로세스마다 한 번만 만든다 (example_messages, functools.cache). 참고 문서의 마지막
"Complete example" 절은 같은 spec 이라 프롬프트에서는 뺀다 (spec_reference(for_prompt=True)); 파일은 사람이 읽도록 그대로다.
build_messages(example=False) 는 예시 없이 [system, user] 만 만든다 (테스트용).

ROLE의 첫 줄은 테스트가 시스템 프롬프트에서 찾으므로 바꾸지 않는다.
"""

from __future__ import annotations

import functools
import json
import re
from pathlib import Path
from typing import Any

from agent import source
from agent.config import DEFAULT_PROFILE_MAX_CHARS
from agent.profile import profile_for_prompt, profile_records

AGENT_DIR = Path(__file__).resolve().parent.parent
REFERENCE_PATH = AGENT_DIR / "spec_reference.md"
EXAMPLE_DIR = AGENT_DIR / "examples" / "groundedness"
EXAMPLE_RECORD_ID = "$.id"
EXAMPLE_PROFILE_MAX_CHARS = 8000
# 참고 문서의 마지막 절 제목. 이 절부터 끝까지가 예시 spec 이라 프롬프트에서는 잘라 낸다
EXAMPLE_SECTION_RE = re.compile(r"^## \d+\. Complete example[ \t]*$", re.MULTILINE)

ROLE = """You are the planner of an annotation pipeline for Amazon Mechanical Turk.

A requester describes what crowd workers should judge, and a program has already profiled the raw data: every
path in the records with its types, sizes, examples, value histograms, anomalies and hints. Your only output is
the task spec, one JSON object that deterministic code turns into HITs. You have two jobs.

1. Analyse the profiled data and decide the preprocessing: which records or lists become the items (tabs) of a
   HIT, which fields are shown to the worker as context, which single list is the target the worker judges, where
   the existing reference labels are and how their values map to the options, and how attention items are built.
2. Design the content the workers see: the title and description, the instructions with concrete criteria for
   every option, the question and the option labels.

How to work:
- Read the hints and the anomalies of the profile first. The hints name the candidate context fields, target
  lists and label paths; the anomalies name the records that deviate from the majority shape.
- Use only paths that appear in the profile, spelled as the profile spells them. Never invent keys.
- Choose exactly one target list, and pick the iterate path so that each item shows one piece of evidence with
  all of its targets.
- Find a label path that addresses the same (item, target) pair as the context and target paths (same
  retriever, same model, same list), and map every observed label value to an option value.
- Prefer items_per_hit of at most 10 (fewer for long passages) and a mismatch attention item whose expected
  answer is unambiguous; use an instruction attention item only when no mismatch works.
- Write the instructions for non-expert English-speaking workers: say what to read, define every option with
  concrete criteria and its borderline cases, and give a short numbered procedure.
- Explain your choices in planner_notes.

The code never asks you again, so the spec must be complete and correct on its own. The spec format and the
output rules follow. After them, an example exchange shows a data profile with a requester prompt and the task
spec written for them; the real task comes after that example, and only the real task needs an answer."""

OUTPUT_RULES = """Output rules:
- Reply with exactly one JSON object and nothing else: no markdown code fences, no comments, no text before or after it.
- Include every key listed in the reference (use null where the reference allows it). No unknown keys, no trailing commas.
- Use only paths that appear in the data profile. Do not invent keys. Map keys shown as {key} in the profile are addressed with a variable, for example ['Passage {passage_no}'] or ['Fact {target_no}'].
- Field labels, the question, option labels and every instruction are read by workers: write them in plain English and never mention model names, retriever names or dataset names.
- Every string the workers see must be English.
- Follow the requester's prompt for what to show, what to judge, the HIT size and the attention check. Where the prompt is silent, follow the guidance in the reference.
- Set planner_notes to at most five sentences."""


def spec_reference(for_prompt: bool = False) -> str:
    """spec_reference.md 전문. 프롬프트마다 다시 읽으므로 문서를 고치면 바로 반영된다.

    for_prompt 면 마지막 "Complete example" 절(예시 spec)을 뺀다: 같은 spec 이 예시 대화의 assistant 답으로 들어가므로
    두 번 보내지 않는다. 절 제목을 못 찾으면 전문을 돌려준다.
    """
    text = REFERENCE_PATH.read_text(encoding="utf-8")
    if not for_prompt:
        return text
    match = EXAMPLE_SECTION_RE.search(text)
    if match is None:
        return text
    return text[:match.start()].rstrip() + "\n"


def system_prompt() -> str:
    return f"{ROLE}\n\n{spec_reference(for_prompt=True).strip()}\n\n{OUTPUT_RULES}"


def user_prompt(profile: dict, prompt: str, profile_max_chars: int = DEFAULT_PROFILE_MAX_CHARS) -> str:
    compact = profile_for_prompt(profile, profile_max_chars)
    profile_json = json.dumps(compact, ensure_ascii=False, indent=1)
    return (f"## Data profile (JSON)\n{profile_json}\n\n"
            f"## What the requester wants\n{prompt.strip()}\n\n"
            "Write the task spec for this data and this goal.")


@functools.cache
def example_messages() -> tuple[dict, dict]:
    """예시 대화 (user: 합성 예시의 profile + prompt, assistant: 그 task_spec.json 원문). 프로세스마다 한 번만 만든다.

    profile 은 실제 작업과 같은 방법(profile_records → profile_for_prompt)으로 만들되 record_id 를 EXAMPLE_RECORD_ID 로
    주고 EXAMPLE_PROFILE_MAX_CHARS 자로 줄인다. build_messages 는 이 dict 들을 복사해서 넣는다.
    """
    _, records = source.load_records(EXAMPLE_DIR / "raw.json")
    profile = profile_records(records, EXAMPLE_RECORD_ID)
    prompt = (EXAMPLE_DIR / "prompt.md").read_text(encoding="utf-8")
    spec_text = (EXAMPLE_DIR / "task_spec.json").read_text(encoding="utf-8")
    return ({"role": "user", "content": user_prompt(profile, prompt, EXAMPLE_PROFILE_MAX_CHARS)},
            {"role": "assistant", "content": spec_text})


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
                   previous: Any = None, profile_max_chars: int = DEFAULT_PROFILE_MAX_CHARS,
                   example: bool = True) -> list[dict]:
    """chat completions에 보낼 메시지 목록: [system, user(예시), assistant(예시 spec), user(실제 작업)].

    example=False 면 예시 쌍을 뺀다. errors가 있으면 직전 답과 수정 요청을 맨 뒤에 붙인다.
    """
    messages = [{"role": "system", "content": system_prompt()}]
    if example:
        messages.extend(dict(message) for message in example_messages())
    messages.append({"role": "user", "content": user_prompt(profile, prompt, profile_max_chars)})
    if errors:
        messages.append({"role": "assistant", "content": previous_text(previous)})
        messages.append({"role": "user", "content": fix_prompt(list(errors))})
    return messages
