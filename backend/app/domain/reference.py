"""Review 표의 대조 기준 (MTurk 의 Input.GroundTruth 역할). prototype/src/domain/reference.ts 를 그대로 옮겼다.
입력 컬럼의 값을 문항에 대응시키거나, 컬럼이 없으면 같은 HIT 의 다른 worker 들 majority 를 쓴다.

reference.test.ts 의 기대값:
    normalize_label("  Not Covered ") == "not covered"
    parse_reference_cell('{"general_0_1": "Covered", "n": 2}') == {"general_0_1": "Covered", "n": 2}
    parse_reference_cell("{'general_0_1': 'Covered', 'general_1_1': 'Not covered'}")  (Python repr 도 읽는다)
    parse_reference_cell("{'a': True, 'b': False, 'c': None, 'd': 'None'}") == {"a": True, "b": False, "c": None, "d": "None"}
    parse_reference_cell("{'a': 'don't'}") == "{'a': 'don't'}"        (깨진 리터럴은 평문)
    parse_reference_cell("") is None, parse_reference_cell("Covered") == "Covered"
    map_reference_to_answers({"general_0_1": "Covered", "general_1_1_coverage": "Exact"}, [general_0_1_coverage, general_1_1_coverage, attention_2_1_coverage])
        == {"general_0_1_coverage": "Covered", "general_1_1_coverage": "Exact"}     (같은 키, 없으면 `키_` 접두어 중 가장 긴 것)
    map_reference_to_answers(["a", "b"], 위 answers) == {general_0_1_coverage: "a", general_1_1_coverage: "b"}   (attention 을 뺀 수와 같으면)
    map_reference_to_answers("grounded", [general_1, attention_1]) == {"general_1": "grounded"}                     (일반 문항이 하나일 때)
    majority_reference([[q1 a, q2 a, q3 a], [q1 a, q2 b], [q1 b, q2 b]]) == {"q1": "a", "q2": "b", "q3": "a"}
    agreement_with_reference(…) : attention 제외, 기준이 있는 문항만, 대소문자와 공백 무시. 비교할 문항이 없으면 None
"""

from __future__ import annotations

import json
import re
from typing import Any

from app.domain.attention import is_attention_name
from app.domain.js import is_js_number, js_number, js_string
from app.domain.agreement import majority_of_tally

PYTHON_WORDS = {"True": "true", "False": "false", "None": "null"}
PYTHON_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "'": "'", '"': '"', "\\": "\\"}
_PYTHON_WORD_RE = re.compile(r"\b(True|False|None)\b", re.ASCII)
_HEX_RE = re.compile(r"^[0-9a-fA-F]+$")


def normalize_label(value: str) -> str:
    """값 비교용. 대소문자와 앞뒤 공백을 무시한다 (LLM 라벨 `Not covered` ↔ worker 답 `Not Covered`)."""
    return value.strip().lower()


def _reject_constant(name: str) -> None:
    raise ValueError(f"JSON.parse does not accept {name}")


def json_parse(text: str) -> Any:
    """JSON.parse 와 같은 엄격함으로 (NaN, Infinity 는 거절)."""
    return json.loads(text, parse_constant=_reject_constant)


def python_to_json(text: str) -> str | None:
    """Python repr(작은따옴표 문자열, True/False/None)을 JSON 텍스트로. 닫히지 않은 문자열이면 None."""
    out = ""
    i = 0
    length = len(text)
    while i < length:
        if text[i] != "'":
            next_quote = text.find("'", i)
            end = length if next_quote < 0 else next_quote
            out += _PYTHON_WORD_RE.sub(lambda m: PYTHON_WORDS[m.group(1)], text[i:end])
            i = end
            continue
        inner = ""
        i += 1
        while i < length and text[i] != "'":
            if text[i] != "\\":
                inner += text[i]
                i += 1
                continue
            code = text[i + 1] if i + 1 < length else ""
            if code in ("x", "u"):
                width = 2 if code == "x" else 4
                hex_digits = text[i + 2:i + 2 + width]
                if not _HEX_RE.match(hex_digits) or len(hex_digits) != width:
                    return None
                inner += chr(int(hex_digits, 16))
                i += 2 + len(hex_digits)
            else:
                inner += PYTHON_ESCAPES.get(code, code)
                i += 2
        if i >= length:
            return None
        i += 1
        out += json.dumps(inner, ensure_ascii=False)
    return out


def parse_reference_cell(cell: str) -> Any:
    """셀 문자열 → 값. JSON → 실패하면 Python 리터럴 → 그래도 안 되면 셀 전체가 값 하나. 빈 셀은 None (undefined).

    Python 변환은 셀에 큰따옴표가 없을 때만 한다 (repr 은 작은따옴표가 든 문자열을 큰따옴표로 감싼다).
    """
    text = cell.strip()
    if not text:
        return None
    try:
        return json_parse(text)
    except ValueError:
        pass
    if '"' in text:
        return text
    converted = python_to_json(text)
    if converted is None:
        return text
    try:
        return json_parse(converted)
    except ValueError:
        return text


def as_label(value: Any) -> str | None:
    """string | number | boolean 만 문자열로. 그 외는 None."""
    if isinstance(value, (str, bool)) or is_js_number(value):
        return js_string(value)
    return None


def map_reference_to_answers(parsed: Any, answers: list[dict], attention_prefix: str) -> dict[str, str]:
    """파싱된 값을 이 assignment 의 문항 이름에 대응시킨다.

    - object: 문항 이름과 같은 키, 없으면 `name.startswith(key + '_')` 인 키 중 가장 긴 것. 값은 string|number|boolean 만
    - array: 위치로. 길이가 답 수와 같으면 모든 답에, attention 을 뺀 답 수와 같으면 attention 을 뺀 답에. 둘 다 아니면 없음
    - 그 외 스칼라: attention 을 뺀 답이 정확히 하나일 때 그 답에
    """
    reference: dict[str, str] = {}
    if parsed is None:
        return reference

    if isinstance(parsed, list):
        general = [a for a in answers if not is_attention_name(a["name"], attention_prefix)]
        targets = answers if len(parsed) == len(answers) else general if len(parsed) == len(general) else []
        for index, answer in enumerate(targets):
            label = as_label(parsed[index])
            if label is not None:
                reference[answer["name"]] = label
        return reference

    if isinstance(parsed, dict):
        for answer in answers:
            best_key: str | None = None
            for key in parsed:
                if answer["name"] != key and not answer["name"].startswith(f"{key}_"):
                    continue
                if best_key is None or len(key) > len(best_key):
                    best_key = key
            if best_key is None:
                continue
            label = as_label(parsed[best_key])
            if label is not None:
                reference[answer["name"]] = label
        return reference

    label = as_label(parsed)
    general = [a for a in answers if not is_attention_name(a["name"], attention_prefix)]
    if label is not None and len(general) == 1:
        reference[general[0]["name"]] = label
    return reference


def majority_reference(others: list[list[dict]]) -> dict[str, str]:
    """다른 worker 들(반려 제외)의 답으로 문항별 majority. 동률이거나 표가 없는 문항은 키가 없다."""
    tallies: dict[str, dict[str, int]] = {}
    for answers in others:
        for answer in answers:
            counts = tallies.setdefault(answer["name"], {})
            counts[answer["value"]] = counts.get(answer["value"], 0) + 1
    reference: dict[str, str] = {}
    for name, counts in tallies.items():
        winner = majority_of_tally(counts)
        if winner is not None:
            reference[name] = winner
    return reference


def agreement_with_reference(answers: list[dict], reference: dict[str, str], attention_prefix: str) -> float | int | None:
    """attention 문항을 빼고 reference 가 있는 문항만 비교한 일치 비율. 비교할 문항이 없으면 None."""
    compared = agreed = 0
    for answer in answers:
        if is_attention_name(answer["name"], attention_prefix):
            continue
        expected = reference.get(answer["name"])
        if expected is None:
            continue
        compared += 1
        if normalize_label(expected) == normalize_label(str(answer["value"])):
            agreed += 1
    return None if compared == 0 else js_number(agreed / compared)
