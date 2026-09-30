"""task_spec.json의 데이터클래스, 파서, 검증.

spec은 LLM(planner)이나 사람이 채우고, 전처리·렌더·검증은 spec만 보고 결정적으로 동작한다. 형식은
spec_reference.md에 영어로 설명해 두었다 (planner 프롬프트에 그대로 들어간다).

    parse_spec(data)                     dict → TaskSpec. 형식 오류를 전부 모아 SpecError(messages)로 올린다
    load_spec(path)                      JSON 파일 → TaskSpec
    spec_to_dict(spec)                   TaskSpec → dict (parse_spec의 역. json.dump 가능)
    check_spec(spec)                     데이터 없이 할 수 있는 정합성 검사. 오류 문자열 목록
    validate_against_records(spec, records)
                                         첫 레코드 몇 개로 경로가 실제로 풀리는지 검사. 오류 문자열 목록. 풀리지 않는 경로에는
                                         실제 레코드에 있는 가장 가까운 경로를 " (did you mean '…'?)"로 붙이고, 최상위 키가 없으면
                                         레코드의 최상위 키를 적는다. 이어서 DATA_CHECK_RECORDS개까지의 레코드로 내용 검사를 한다:
                                         contains가 라벨 목록의 원소와 한 번도 맞지 않음, 라벨·target·문맥 경로가 같은 부모의 서로
                                         다른 키(다른 retriever·model)를 가리킴, worker 문구에 데이터의 내부 이름('RT25' 같은 키),
                                         contains hint인데 라벨 맵에 없는 항목이 있고 missing이 null
    question_blocks(questions), answer_slots(spec, n_targets)
                                         탭 안의 문항 묶음과 답 칸의 순서 (화면 순서). 전처리·렌더·검증이 같이 쓴다
    record_id_of, record_variables, iter_item_variables, field_value, resolve_targets,
    target_variables, hint_label, hint_reason, map_hint, filter_matches
                                         전처리(preprocess)도 같은 규칙을 쓰도록 공개한 도우미들

spec_version 2가 지금 형식이다: item.questions에 문항 여러 개(choice, multi_select, likert, text)를 두고, 문항마다
scope(target이면 target마다, item이면 탭마다 한 번), hint, required_when을 적는다. spec_version 1(옛 형식:
item.question 하나 + item.hint + attention.expected_value)도 읽는다. 읽으면 같은 내부 모델(문항 하나, scope target,
id "answer", 답 이름 접미어는 옛 answer_suffix)로 바꾸고 spec_version은 1로 남긴다. spec_to_dict는 v1 spec을 v1
모양으로 되돌려 쓰므로 parse_spec(spec_to_dict(s)) == s 이고 답 이름도 그대로다.

오류 메시지는 "$.item.questions[1].options: …"처럼 spec 안의 JSON 경로로 시작한다 (v1이면 "$.item.question…").

최상위의 planner_notes(문자열 또는 null)는 planner가 자기 선택을 설명한 메모다. 파이프라인은 저장만 하고 쓰지 않는다.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Iterator

from agent import paths
from agent.paths import MISSING, PathError

SPEC_VERSION = 2
LEGACY_SPEC_VERSION = 1
SPEC_VERSIONS = (LEGACY_SPEC_VERSION, SPEC_VERSION)
TASK_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
OPTION_VALUE_RE = re.compile(r"^[A-Za-z0-9_ .-]+$")
SUFFIX_RE = re.compile(r"^[A-Za-z0-9_]*$")
QUESTION_ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")

RESERVED_COLUMNS = ("hit_id", "record_ids", "item_ids", "attention")
RESERVED_VARIABLES = ("record_index", "record_no", "record_id", "target", "target_index", "target_no", "target_key")
SOURCE_FORMATS = ("json_array", "json_object_values", "jsonl", "csv")
FIELD_ROLES = ("context", "target")
FIELD_STYLES = ("text", "passage", "list")
QUESTION_TYPES = ("choice", "multi_select", "likert", "text")
QUESTION_SCOPES = ("target", "item")
GROUP_BY = ("record", "sequential")
POSITIONS = ("random", "first", "last")
STRATEGIES = ("mismatch", "instruction")

LEGACY_QUESTION_ID = "answer"          # v1 spec의 문항 하나에 붙이는 id (attention.expected의 키)
DEFAULT_NONE_LABEL = "None of the above"
DEFAULT_REFERENCE_COLUMN = "llm_label"
DEFAULT_ATTENTION_COLUMN = "attention_expected"
DEFAULT_ITEMS_PER_HIT = 10
DEFAULT_ATTENTION_SEED = 42
MAX_LIKERT_POINTS = 11
CONTAINS_VALUES = ("true", "false")    # hint.contains가 만드는 원시 라벨
VALIDATE_RECORDS = 5
DATA_CHECK_RECORDS = 20                # 내용 검사(contains, 키 일치, 내부 이름, 빠진 라벨)에 쓰는 레코드 수
DATA_CHECK_ITEMS = 2000                # 내용 검사에서 보는 항목 수 상한
SUGGEST_MIN_SCORE = 0.45               # 경로 제안을 붙이는 최소 유사도 (토큰 Jaccard + 0.5 × 철자 유사도 + 어간 보너스)
TOP_LEVEL_KEYS_SHOWN = 12
# 데이터 키 중 구조용 번호 라벨('Chunk 3', 'Atomic fact1', 'Sub-question 2'). 숫자가 든 다른 키('RT25', 'mdl-5')는 내부 이름으로 본다
ENUMERATED_LABEL_RE = re.compile(r"^[A-Za-z][a-z]*(?:[ -][A-Za-z][a-z]*)* ?\d+$")
TARGET_SCALAR_HINT = ("; a target must be a list shown inside one tab — if each tab judges one thing, make it a context "
                      "field and use scope \"item\"")


class SpecError(ValueError):
    """spec 형식 오류 또는 spec이 데이터와 맞지 않는 오류. messages에 오류 문자열들이 있다."""

    def __init__(self, messages: list[str] | str):
        self.messages = [messages] if isinstance(messages, str) else list(messages)
        super().__init__("\n".join(self.messages))


# ----------------------------------------------------------------------------------------------
# 데이터클래스
# ----------------------------------------------------------------------------------------------


@dataclass
class TaskInfo:
    id: str
    title: str
    description: str = ""
    keywords: list[str] = field(default_factory=list)


@dataclass
class FilterSpec:
    """레코드 필터. mode가 equals면 경로 값 == value, exists면 (경로가 풀리는지) == value."""

    path: str
    mode: str
    value: Any = None


@dataclass
class SampleSpec:
    n: int
    seed: int = 0


@dataclass
class SourceSpec:
    format: str | None = None
    record_id: str | None = None
    filter: FilterSpec | None = None
    sample: SampleSpec | None = None
    limit: int | None = None


@dataclass
class IterateSpec:
    """iterate 한 단계. group_size가 있으면 원소를 그 개수씩 묶은 목록이 변수 값이다 (모자란 마지막 묶음은 버린다)."""

    var: str
    path: str
    limit: int | None = None
    group_size: int | None = None


@dataclass
class FieldSpec:
    name: str
    path: str
    label: str
    role: str = "context"
    style: str = "text"


@dataclass
class OptionSpec:
    value: str
    label: str


@dataclass
class ScaleSpec:
    min: int
    max: int
    min_label: str | None = None
    max_label: str | None = None


@dataclass
class ConditionSpec:
    """required_when: 앞 문항 question의 답이 value일 때만 필수."""

    question: str
    value: str


@dataclass
class HintSpec:
    """기존 라벨의 위치. contains가 있으면 label_path의 목록(또는 객체의 키)에 그 글이 있는지가 원시 라벨("true"/"false")이다."""

    label_path: str
    reason_path: str | None = None
    contains: str | None = None
    map: dict[str, str] | None = None
    missing: str | None = None


@dataclass
class QuestionSpec:
    """문항 하나. scope가 target이면 항목의 target마다, item이면 항목(탭)마다 한 번 묻는다.

    answer_suffix는 v1 spec에서 읽은 옛 접미어다. None(v2)이면 답 이름 접미어는 "_" + id다."""

    id: str
    text: str
    type: str = "choice"
    scope: str = "target"
    options: list[OptionSpec] = field(default_factory=list)
    none_label: str | None = None
    scale: ScaleSpec | None = None
    min_chars: int = 0
    required: bool = True
    required_when: ConditionSpec | None = None
    hint: HintSpec | None = None
    answer_suffix: str | None = None

    @property
    def suffix(self) -> str:
        """답 이름 끝에 붙는 글. v2는 "_" + id, v1은 옛 answer_suffix."""
        return "_" + self.id if self.answer_suffix is None else self.answer_suffix

    @property
    def values(self) -> list[str]:
        """답으로 저장될 수 있는 값들. likert는 척도의 정수 문자열, text는 빈 목록."""
        if self.type == "likert":
            scale = self.scale
            if scale is None or not 1 <= scale.max - scale.min + 1 <= MAX_LIKERT_POINTS:
                return []
            return [str(value) for value in range(scale.min, scale.max + 1)]
        if self.type == "text":
            return []
        return [option.value for option in self.options]

    @property
    def none_text(self) -> str:
        """multi_select의 "해당 없음" 칸 문구."""
        return self.none_label or DEFAULT_NONE_LABEL


@dataclass
class ItemSpec:
    iterate: list[IterateSpec]
    fields: dict[str, FieldSpec]
    questions: list[QuestionSpec]
    skip_if_no_targets: bool = True


@dataclass
class MismatchSpec:
    swap_fields: list[str]
    distance: int = 50


@dataclass
class InstructionAttentionSpec:
    text: str


@dataclass
class AttentionSpec:
    """attention 항목. expected는 문항 id → 기대 값 (v1은 {"answer": expected_value})."""

    strategy: str
    expected: dict[str, str]
    per_hit: int = 1
    position: str = "random"
    seed: int = DEFAULT_ATTENTION_SEED
    max_targets: int | None = None
    mismatch: MismatchSpec | None = None
    instruction: InstructionAttentionSpec | None = None


@dataclass
class HitSpec:
    items_per_hit: int = DEFAULT_ITEMS_PER_HIT
    group_by: str = "record"
    attention: AttentionSpec | None = None


@dataclass
class CriterionSpec:
    label: str
    text: str


@dataclass
class NoticesSpec:
    attention: bool = True
    research: bool = True


@dataclass
class InstructionsSpec:
    summary: str
    background: str | None = None
    criteria: list[CriterionSpec] = field(default_factory=list)
    steps: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    tip: str | None = None
    notices: NoticesSpec = field(default_factory=NoticesSpec)


@dataclass
class OutputSpec:
    reference_column: str = DEFAULT_REFERENCE_COLUMN
    reason_column: str | None = None
    attention_column: str = DEFAULT_ATTENTION_COLUMN


@dataclass
class TaskSpec:
    task: TaskInfo
    source: SourceSpec
    item: ItemSpec
    hit: HitSpec
    instructions: InstructionsSpec
    output: OutputSpec
    spec_version: int = SPEC_VERSION
    planner_notes: str | None = None

    @property
    def legacy(self) -> bool:
        """spec_version 1(옛 형식)에서 읽은 spec인지."""
        return self.spec_version == LEGACY_SPEC_VERSION

    @property
    def target_field(self) -> FieldSpec | None:
        """role이 target인 필드. 없으면 None (v2는 target 문항이 없으면 target 필드가 없어도 된다)."""
        for spec in self.item.fields.values():
            if spec.role == "target":
                return spec
        return None

    @property
    def context_fields(self) -> list[FieldSpec]:
        return [spec for spec in self.item.fields.values() if spec.role == "context"]

    @property
    def questions(self) -> list[QuestionSpec]:
        return self.item.questions

    def question(self, question_id: str) -> QuestionSpec | None:
        return next((q for q in self.item.questions if q.id == question_id), None)

    @property
    def option_values(self) -> list[str]:
        """모든 문항의 값을 처음 나온 순서대로 모은 목록 (text 제외)."""
        out: list[str] = []
        for question in self.item.questions:
            for value in question.values:
                if value not in out:
                    out.append(value)
        return out

    @property
    def free_text_suffixes(self) -> list[str]:
        """자유 서술(text) 문항의 답 이름 접미어들. 콘솔이 이 접미어로 자유 서술 답을 가려낸다."""
        return [q.suffix for q in self.item.questions if q.type == "text"]


# ----------------------------------------------------------------------------------------------
# 파싱 (형식 오류를 모은다)
# ----------------------------------------------------------------------------------------------

_REQUIRED = object()
_TYPE_NAMES = {str: "a string", int: "an integer", bool: "a boolean", list: "a list", dict: "an object"}


class _Reader:
    """오류를 모으면서 값을 꺼내는 도우미. 값이 틀리면 오류를 적고 기본값을 돌려준다."""

    def __init__(self) -> None:
        self.errors: list[str] = []

    def error(self, where: str, message: str) -> None:
        self.errors.append(f"{where}: {message}")

    def check_keys(self, obj: dict, where: str, allowed: tuple[str, ...]) -> None:
        for key in obj:
            if key not in allowed:
                self.error(f"{where}.{key}", f"unknown key (allowed: {', '.join(allowed)})")

    def get(self, obj: dict, key: str, where: str, kind: type, default: Any = _REQUIRED, allow_none: bool = False) -> Any:
        """obj[key]를 kind 타입으로 꺼낸다. 없거나 null이면 기본값(필수면 오류). 타입이 틀리면 오류를 적고 기본값."""
        here = f"{where}.{key}"
        value = obj.get(key)
        if value is None:
            if key in obj and allow_none:
                return None
            if default is _REQUIRED:
                self.error(here, "required")
                return None
            return default
        if not isinstance(value, kind) or (kind is int and isinstance(value, bool)):
            self.error(here, f"must be {_TYPE_NAMES[kind]}")
            return None if default is _REQUIRED else default
        return value

    def str_list(self, obj: dict, key: str, where: str, default: Any = _REQUIRED) -> list[str]:
        value = self.get(obj, key, where, list, default)
        if not isinstance(value, list):
            return [] if not isinstance(default, list) else list(default)
        out = []
        for index, item in enumerate(value):
            if isinstance(item, str):
                out.append(item)
            else:
                self.error(f"{where}.{key}[{index}]", "must be a string")
        return out

    def choice(self, obj: dict, key: str, where: str, choices: tuple[str, ...], default: Any = _REQUIRED) -> str:
        value = self.get(obj, key, where, str, default)
        if value is not None and value not in choices:
            self.error(f"{where}.{key}", f"must be one of {', '.join(repr(c) for c in choices)}")
            return default if isinstance(default, str) else choices[0]
        return value if value is not None else (default if isinstance(default, str) else "")

    def obj(self, obj: dict, key: str, where: str, required: bool) -> dict | None:
        """하위 객체. 없으면 (required가 아니면) None, null도 None."""
        if key not in obj or obj[key] is None:
            if required:
                self.error(f"{where}.{key}", "required")
            return None
        value = obj[key]
        if not isinstance(value, dict):
            self.error(f"{where}.{key}", "must be an object")
            return None
        return value

    def str_map(self, obj: dict, key: str, where: str, what: str) -> dict[str, str] | None:
        """문자열 → 문자열 객체 (hint.map, attention.expected). null이면 None."""
        data = self.get(obj, key, where, dict, None, allow_none=True)
        if data is None:
            return None
        out: dict[str, str] = {}
        for name, value in data.items():
            if isinstance(value, str):
                out[name] = value
            else:
                self.error(f"{where}.{key}.{name}", f"must be a string ({what})")
        return out


def parse_spec(data: dict) -> TaskSpec:
    """dict → TaskSpec. 형식 오류와 정합성 오류를 전부 모아 SpecError로 올린다.

    spec_version이 없으면 모양으로 정한다: item에 question이 있고 questions가 없으면 1, 아니면 2."""
    if not isinstance(data, dict):
        raise SpecError(["$: spec must be a JSON object"])
    reader = _Reader()
    reader.check_keys(data, "$", ("spec_version", "task", "source", "item", "hit", "instructions", "output", "planner_notes"))
    version = _spec_version(reader, data)
    legacy = version == LEGACY_SPEC_VERSION

    task = _parse_task(reader, reader.obj(data, "task", "$", True) or {}, "$.task")
    source = _parse_source(reader, reader.obj(data, "source", "$", False) or {}, "$.source")
    item_data = reader.obj(data, "item", "$", True) or {}
    item = _parse_item_v1(reader, item_data, "$.item") if legacy else _parse_item(reader, item_data, "$.item")
    hit = _parse_hit(reader, reader.obj(data, "hit", "$", False) or {}, "$.hit", legacy)
    instructions = _parse_instructions(reader, reader.obj(data, "instructions", "$", False) or {}, "$.instructions", task)
    output = _parse_output(reader, reader.obj(data, "output", "$", False) or {}, "$.output", legacy)
    planner_notes = reader.get(data, "planner_notes", "$", str, None, allow_none=True)

    spec = TaskSpec(task=task, source=source, item=item, hit=hit, instructions=instructions, output=output,
                    spec_version=version, planner_notes=planner_notes)
    errors = reader.errors + [message for message in check_spec(spec) if message not in reader.errors]
    if errors:
        raise SpecError(errors)
    return spec


def _spec_version(reader: _Reader, data: dict) -> int:
    value = data.get("spec_version")
    if value is None:
        item = data.get("item")
        if isinstance(item, dict) and "question" in item and "questions" not in item:
            return LEGACY_SPEC_VERSION
        return SPEC_VERSION
    if isinstance(value, bool) or not isinstance(value, int):
        reader.error("$.spec_version", "must be an integer")
        return SPEC_VERSION
    if value not in SPEC_VERSIONS:
        reader.error("$.spec_version", f"must be {SPEC_VERSION} (or {LEGACY_SPEC_VERSION} for the legacy single-question format)")
        return SPEC_VERSION
    return value


def _parse_task(reader: _Reader, data: dict, where: str) -> TaskInfo:
    reader.check_keys(data, where, ("id", "title", "description", "keywords"))
    return TaskInfo(
        id=reader.get(data, "id", where, str) or "",
        title=reader.get(data, "title", where, str) or "",
        description=reader.get(data, "description", where, str, "") or "",
        keywords=reader.str_list(data, "keywords", where, []),
    )


def _parse_source(reader: _Reader, data: dict, where: str) -> SourceSpec:
    reader.check_keys(data, where, ("format", "record_id", "filter", "sample", "limit"))
    filter_spec = None
    filter_data = reader.obj(data, "filter", where, False)
    if filter_data is not None:
        here = f"{where}.filter"
        reader.check_keys(filter_data, here, ("path", "equals", "exists"))
        path = reader.get(filter_data, "path", here, str) or ""
        if "exists" in filter_data and "equals" in filter_data:
            reader.error(here, "use either \"equals\" or \"exists\", not both")
        if "exists" in filter_data:
            exists = reader.get(filter_data, "exists", here, bool)
            filter_spec = FilterSpec(path=path, mode="exists", value=bool(exists))
        elif "equals" in filter_data:
            filter_spec = FilterSpec(path=path, mode="equals", value=filter_data["equals"])
        else:
            reader.error(here, "needs \"equals\" or \"exists\"")
    sample_spec = None
    sample_data = reader.obj(data, "sample", where, False)
    if sample_data is not None:
        here = f"{where}.sample"
        reader.check_keys(sample_data, here, ("n", "seed"))
        sample_spec = SampleSpec(n=reader.get(sample_data, "n", here, int) or 0, seed=reader.get(sample_data, "seed", here, int, 0))
    return SourceSpec(
        format=reader.get(data, "format", where, str, None, allow_none=True),
        record_id=reader.get(data, "record_id", where, str, None, allow_none=True),
        filter=filter_spec,
        sample=sample_spec,
        limit=reader.get(data, "limit", where, int, None, allow_none=True),
    )


def _parse_iterate(reader: _Reader, data: dict, where: str, legacy: bool) -> list[IterateSpec]:
    iterate: list[IterateSpec] = []
    keys = ("var", "path", "limit") if legacy else ("var", "path", "limit", "group_size")
    for index, entry in enumerate(reader.get(data, "iterate", where, list, []) or []):
        here = f"{where}.iterate[{index}]"
        if not isinstance(entry, dict):
            reader.error(here, "must be an object")
            continue
        reader.check_keys(entry, here, keys)
        iterate.append(IterateSpec(
            var=reader.get(entry, "var", here, str) or "",
            path=reader.get(entry, "path", here, str) or "",
            limit=reader.get(entry, "limit", here, int, None, allow_none=True),
            group_size=None if legacy else reader.get(entry, "group_size", here, int, None, allow_none=True),
        ))
    return iterate


def _parse_fields(reader: _Reader, data: dict, where: str) -> dict[str, FieldSpec]:
    fields: dict[str, FieldSpec] = {}
    fields_data = reader.obj(data, "fields", where, True)
    if fields_data is None:
        return fields
    for name, entry in fields_data.items():
        here = f"{where}.fields.{name}"
        if not isinstance(entry, dict):
            reader.error(here, "must be an object")
            continue
        reader.check_keys(entry, here, ("path", "label", "role", "style"))
        fields[name] = FieldSpec(
            name=name,
            path=reader.get(entry, "path", here, str) or "",
            label=reader.get(entry, "label", here, str, name) or name,
            role=reader.choice(entry, "role", here, FIELD_ROLES, "context"),
            style=reader.choice(entry, "style", here, FIELD_STYLES, "text"),
        )
    return fields


def _parse_options(reader: _Reader, data: dict, where: str, required: bool) -> list[OptionSpec]:
    options: list[OptionSpec] = []
    raw = reader.get(data, "options", where, list) if required else reader.get(data, "options", where, list, [])
    for index, entry in enumerate(raw or []):
        here = f"{where}.options[{index}]"
        if not isinstance(entry, dict):
            reader.error(here, "must be an object")
            continue
        reader.check_keys(entry, here, ("value", "label"))
        value = reader.get(entry, "value", here, str) or ""
        options.append(OptionSpec(value=value, label=reader.get(entry, "label", here, str, value) or value))
    return options


def _parse_hint(reader: _Reader, data: dict, where: str, legacy: bool) -> HintSpec | None:
    hint_data = reader.obj(data, "hint", where, False)
    if hint_data is None:
        return None
    here = f"{where}.hint"
    keys = ("label_path", "reason_path", "map", "missing") if legacy else ("label_path", "reason_path", "contains", "map", "missing")
    reader.check_keys(hint_data, here, keys)
    return HintSpec(
        label_path=reader.get(hint_data, "label_path", here, str) or "",
        reason_path=reader.get(hint_data, "reason_path", here, str, None, allow_none=True),
        contains=None if legacy else reader.get(hint_data, "contains", here, str, None, allow_none=True),
        map=reader.str_map(hint_data, "map", here, "an option value"),
        missing=reader.get(hint_data, "missing", here, str, None, allow_none=True),
    )


def _parse_item(reader: _Reader, data: dict, where: str) -> ItemSpec:
    reader.check_keys(data, where, ("iterate", "fields", "questions", "skip_if_no_targets"))
    iterate = _parse_iterate(reader, data, where, legacy=False)
    fields = _parse_fields(reader, data, where)
    questions: list[QuestionSpec] = []
    for index, entry in enumerate(reader.get(data, "questions", where, list) or []):
        here = f"{where}.questions[{index}]"
        if not isinstance(entry, dict):
            reader.error(here, "must be an object")
            continue
        questions.append(_parse_question(reader, entry, here))
    skip = reader.get(data, "skip_if_no_targets", where, bool, True)
    return ItemSpec(iterate=iterate, fields=fields, questions=questions, skip_if_no_targets=skip)


def _parse_question(reader: _Reader, data: dict, where: str) -> QuestionSpec:
    reader.check_keys(data, where, ("id", "text", "type", "scope", "options", "none_label", "scale", "min_chars",
                                    "required", "required_when", "hint"))
    scale = None
    scale_data = reader.obj(data, "scale", where, False)
    if scale_data is not None:
        here = f"{where}.scale"
        reader.check_keys(scale_data, here, ("min", "max", "min_label", "max_label"))
        low = reader.get(scale_data, "min", here, int)
        high = reader.get(scale_data, "max", here, int)
        scale = ScaleSpec(
            min=low if low is not None else 1,
            max=high if high is not None else (low if low is not None else 1) + 1,
            min_label=reader.get(scale_data, "min_label", here, str, None, allow_none=True),
            max_label=reader.get(scale_data, "max_label", here, str, None, allow_none=True),
        )
    condition = None
    condition_data = reader.obj(data, "required_when", where, False)
    if condition_data is not None:
        here = f"{where}.required_when"
        reader.check_keys(condition_data, here, ("question", "value"))
        condition = ConditionSpec(question=reader.get(condition_data, "question", here, str) or "",
                                  value=reader.get(condition_data, "value", here, str) or "")
    return QuestionSpec(
        id=reader.get(data, "id", where, str) or "",
        text=reader.get(data, "text", where, str) or "",
        type=reader.choice(data, "type", where, QUESTION_TYPES, "choice"),
        scope=reader.choice(data, "scope", where, QUESTION_SCOPES, "target"),
        options=_parse_options(reader, data, where, required=False),
        none_label=reader.get(data, "none_label", where, str, None, allow_none=True),
        scale=scale,
        min_chars=reader.get(data, "min_chars", where, int, 0),
        required=bool(reader.get(data, "required", where, bool, True)),
        required_when=condition,
        hint=_parse_hint(reader, data, where, legacy=False),
    )


def _parse_item_v1(reader: _Reader, data: dict, where: str) -> ItemSpec:
    """옛 형식(item.question + item.hint)을 문항 하나(id "answer", scope target, choice)로 읽는다."""
    reader.check_keys(data, where, ("iterate", "fields", "question", "hint", "skip_if_no_targets"))
    iterate = _parse_iterate(reader, data, where, legacy=True)
    fields = _parse_fields(reader, data, where)
    question_data = reader.obj(data, "question", where, True) or {}
    here = f"{where}.question"
    reader.check_keys(question_data, here, ("text", "options", "answer_suffix"))
    question = QuestionSpec(
        id=LEGACY_QUESTION_ID,
        text=reader.get(question_data, "text", here, str) or "",
        type="choice",
        scope="target",
        options=_parse_options(reader, question_data, here, required=True),
        hint=_parse_hint(reader, data, where, legacy=True),
        answer_suffix=reader.get(question_data, "answer_suffix", here, str, "") or "",
    )
    skip = reader.get(data, "skip_if_no_targets", where, bool, True)
    return ItemSpec(iterate=iterate, fields=fields, questions=[question], skip_if_no_targets=skip)


def _parse_hit(reader: _Reader, data: dict, where: str, legacy: bool) -> HitSpec:
    reader.check_keys(data, where, ("items_per_hit", "group_by", "attention"))
    attention = None
    attention_data = reader.obj(data, "attention", where, False)
    if attention_data is not None:
        here = f"{where}.attention"
        expected_key = "expected_value" if legacy else "expected"
        reader.check_keys(attention_data, here, ("per_hit", "position", "seed", "strategy", expected_key,
                                                 "max_targets", "mismatch", "instruction"))
        mismatch = None
        mismatch_data = reader.obj(attention_data, "mismatch", here, False)
        if mismatch_data is not None:
            reader.check_keys(mismatch_data, f"{here}.mismatch", ("swap_fields", "distance"))
            mismatch = MismatchSpec(
                swap_fields=reader.str_list(mismatch_data, "swap_fields", f"{here}.mismatch"),
                distance=reader.get(mismatch_data, "distance", f"{here}.mismatch", int, 50),
            )
        instruction = None
        instruction_data = reader.obj(attention_data, "instruction", here, False)
        if instruction_data is not None:
            reader.check_keys(instruction_data, f"{here}.instruction", ("text",))
            instruction = InstructionAttentionSpec(text=reader.get(instruction_data, "text", f"{here}.instruction", str) or "")
        if legacy:
            expected = {LEGACY_QUESTION_ID: reader.get(attention_data, "expected_value", here, str) or ""}
        else:
            # 비었거나 없으면 check_spec이 "at least one question id …"로 알린다
            expected = reader.str_map(attention_data, "expected", here, "a value of that question") or {}
        attention = AttentionSpec(
            strategy=reader.choice(attention_data, "strategy", here, STRATEGIES),
            expected=expected,
            per_hit=reader.get(attention_data, "per_hit", here, int, 1),
            position=reader.choice(attention_data, "position", here, POSITIONS, "random"),
            seed=reader.get(attention_data, "seed", here, int, DEFAULT_ATTENTION_SEED),
            max_targets=reader.get(attention_data, "max_targets", here, int, None, allow_none=True),
            mismatch=mismatch,
            instruction=instruction,
        )
    return HitSpec(
        items_per_hit=reader.get(data, "items_per_hit", where, int, DEFAULT_ITEMS_PER_HIT),
        group_by=reader.choice(data, "group_by", where, GROUP_BY, "record"),
        attention=attention,
    )


def _parse_instructions(reader: _Reader, data: dict, where: str, task: TaskInfo) -> InstructionsSpec:
    reader.check_keys(data, where, ("summary", "background", "criteria", "steps", "notes", "tip", "notices"))
    criteria: list[CriterionSpec] = []
    for index, entry in enumerate(reader.get(data, "criteria", where, list, []) or []):
        here = f"{where}.criteria[{index}]"
        if not isinstance(entry, dict):
            reader.error(here, "must be an object")
            continue
        reader.check_keys(entry, here, ("label", "text"))
        criteria.append(CriterionSpec(label=reader.get(entry, "label", here, str) or "", text=reader.get(entry, "text", here, str) or ""))
    notices = NoticesSpec()
    notices_data = reader.obj(data, "notices", where, False)
    if notices_data is not None:
        here = f"{where}.notices"
        reader.check_keys(notices_data, here, ("attention", "research"))
        notices = NoticesSpec(
            attention=bool(reader.get(notices_data, "attention", here, bool, True)),
            research=bool(reader.get(notices_data, "research", here, bool, True)),
        )
    return InstructionsSpec(
        summary=reader.get(data, "summary", where, str, task.description) or task.description,
        background=reader.get(data, "background", where, str, None, allow_none=True),
        criteria=criteria,
        steps=reader.str_list(data, "steps", where, []),
        notes=reader.str_list(data, "notes", where, []),
        tip=reader.get(data, "tip", where, str, None, allow_none=True),
        notices=notices,
    )


def _parse_output(reader: _Reader, data: dict, where: str, legacy: bool) -> OutputSpec:
    keys = ("reference_column", "reason_column") if legacy else ("reference_column", "reason_column", "attention_column")
    reader.check_keys(data, where, keys)
    attention_column = DEFAULT_ATTENTION_COLUMN
    if not legacy:
        attention_column = reader.get(data, "attention_column", where, str, DEFAULT_ATTENTION_COLUMN) or DEFAULT_ATTENTION_COLUMN
    return OutputSpec(
        reference_column=reader.get(data, "reference_column", where, str, DEFAULT_REFERENCE_COLUMN) or DEFAULT_REFERENCE_COLUMN,
        reason_column=reader.get(data, "reason_column", where, str, None, allow_none=True),
        attention_column=attention_column,
    )


def load_spec(path: Path) -> TaskSpec:
    """JSON 파일에서 spec을 읽는다. JSON 자체가 깨졌으면 SpecError."""
    path = Path(path)
    try:
        with path.open(encoding="utf-8") as handle:
            data = json.load(handle)
    except OSError as error:
        raise SpecError([f"{path}: {error.strerror or error}"]) from None
    except ValueError as error:
        raise SpecError([f"{path.name}: invalid JSON: {error}"]) from None
    return parse_spec(data)


def spec_to_dict(spec: TaskSpec) -> dict:
    """TaskSpec → JSON으로 저장할 수 있는 dict. parse_spec(spec_to_dict(spec))는 같은 spec이 된다.

    v2는 기본값까지 모든 키를 쓴다. v1(옛 형식)에서 읽은 spec은 v1 모양으로 쓴다."""
    legacy = spec.legacy
    source = spec.source
    filter_data = None
    if source.filter is not None:
        filter_data = {"path": source.filter.path, source.filter.mode: source.filter.value}
    item = spec.item
    fields = {name: {"path": f.path, "label": f.label, "role": f.role, "style": f.style} for name, f in item.fields.items()}
    if legacy:
        question = item.questions[0] if item.questions else QuestionSpec(id=LEGACY_QUESTION_ID, text="")
        item_data = {
            "iterate": [{"var": it.var, "path": it.path, "limit": it.limit} for it in item.iterate],
            "fields": fields,
            "question": {"text": question.text,
                         "options": [{"value": o.value, "label": o.label} for o in question.options],
                         "answer_suffix": question.answer_suffix or ""},
            "hint": _hint_dict(question.hint, legacy=True),
            "skip_if_no_targets": item.skip_if_no_targets,
        }
    else:
        item_data = {
            "iterate": [{"var": it.var, "path": it.path, "limit": it.limit, "group_size": it.group_size} for it in item.iterate],
            "fields": fields,
            "questions": [_question_dict(q) for q in item.questions],
            "skip_if_no_targets": item.skip_if_no_targets,
        }
    attention = None
    if spec.hit.attention is not None:
        a = spec.hit.attention
        attention = {"per_hit": a.per_hit, "position": a.position, "seed": a.seed, "strategy": a.strategy}
        if legacy:
            attention["expected_value"] = a.expected.get(LEGACY_QUESTION_ID, next(iter(a.expected.values()), ""))
        else:
            attention["expected"] = dict(a.expected)
        attention.update({
            "max_targets": a.max_targets,
            "mismatch": {"swap_fields": list(a.mismatch.swap_fields), "distance": a.mismatch.distance} if a.mismatch else None,
            "instruction": {"text": a.instruction.text} if a.instruction else None,
        })
    ins = spec.instructions
    output = {"reference_column": spec.output.reference_column, "reason_column": spec.output.reason_column}
    if not legacy:
        output["attention_column"] = spec.output.attention_column
    return {
        "spec_version": spec.spec_version,
        "task": {"id": spec.task.id, "title": spec.task.title, "description": spec.task.description,
                 "keywords": list(spec.task.keywords)},
        "source": {
            "format": source.format, "record_id": source.record_id, "filter": filter_data,
            "sample": {"n": source.sample.n, "seed": source.sample.seed} if source.sample else None,
            "limit": source.limit,
        },
        "item": item_data,
        "hit": {"items_per_hit": spec.hit.items_per_hit, "group_by": spec.hit.group_by, "attention": attention},
        "instructions": {
            "summary": ins.summary, "background": ins.background,
            "criteria": [{"label": c.label, "text": c.text} for c in ins.criteria],
            "steps": list(ins.steps), "notes": list(ins.notes), "tip": ins.tip,
            "notices": {"attention": ins.notices.attention, "research": ins.notices.research},
        },
        "output": output,
        "planner_notes": spec.planner_notes,
    }


def _hint_dict(hint: HintSpec | None, legacy: bool) -> dict | None:
    if hint is None:
        return None
    data: dict[str, Any] = {"label_path": hint.label_path, "reason_path": hint.reason_path}
    if not legacy:
        data["contains"] = hint.contains
    data["map"] = dict(hint.map) if hint.map is not None else None
    data["missing"] = hint.missing
    return data


def _question_dict(q: QuestionSpec) -> dict:
    scale = None
    if q.scale is not None:
        scale = {"min": q.scale.min, "max": q.scale.max, "min_label": q.scale.min_label, "max_label": q.scale.max_label}
    return {
        "id": q.id,
        "text": q.text,
        "type": q.type,
        "scope": q.scope,
        "options": [{"value": o.value, "label": o.label} for o in q.options],
        "none_label": q.none_label,
        "scale": scale,
        "min_chars": q.min_chars,
        "required": q.required,
        "required_when": {"question": q.required_when.question, "value": q.required_when.value} if q.required_when else None,
        "hint": _hint_dict(q.hint, legacy=False),
    }


# ----------------------------------------------------------------------------------------------
# 정합성 검사 (데이터 없이)
# ----------------------------------------------------------------------------------------------


def question_where(spec: TaskSpec, index: int) -> str:
    """오류 메시지에 쓰는 문항의 JSON 경로 (v1은 $.item.question 하나)."""
    return "$.item.question" if spec.legacy else f"$.item.questions[{index}]"


def hint_where(spec: TaskSpec, index: int) -> str:
    return "$.item.hint" if spec.legacy else f"$.item.questions[{index}].hint"


def check_spec(spec: TaskSpec) -> list[str]:
    """데이터 없이 할 수 있는 검사: 이름 규칙, 경로 문법, 변수 참조, 문항과 값, attention 설정, 출력 컬럼."""
    errors: list[str] = []
    add = errors.append

    if not TASK_ID_RE.match(spec.task.id or ""):
        add("$.task.id: must match ^[a-z0-9][a-z0-9-]*$")
    if not spec.task.title.strip():
        add("$.task.title: must not be empty")

    source = spec.source
    if source.format is not None and source.format not in SOURCE_FORMATS:
        add(f"$.source.format: must be null or one of {', '.join(repr(f) for f in SOURCE_FORMATS)}")
    if source.record_id is not None:
        _check_path(source.record_id, "$.source.record_id", (), errors)
    if source.filter is not None:
        _check_path(source.filter.path, "$.source.filter.path", (), errors)
    if source.sample is not None and source.sample.n < 1:
        add("$.source.sample.n: must be at least 1")
    if source.limit is not None and source.limit < 1:
        add("$.source.limit: must be at least 1")

    item = spec.item
    record_vars = ("record_index", "record_no", "record_id")
    iterate_vars: list[str] = []
    for index, it in enumerate(item.iterate):
        where = f"$.item.iterate[{index}]"
        if not NAME_RE.match(it.var or ""):
            add(f"{where}.var: must match ^[A-Za-z_][A-Za-z0-9_]*$")
        elif it.var in RESERVED_VARIABLES:
            add(f"{where}.var: {it.var!r} is a reserved variable name")
        elif it.var in iterate_vars:
            add(f"{where}.var: duplicate variable {it.var!r}")
        allowed = record_vars + tuple(_expand_vars(iterate_vars))
        _check_path(it.path, f"{where}.path", allowed, errors)
        if it.limit is not None and it.limit < 1:
            add(f"{where}.limit: must be null or at least 1")
        if it.group_size is not None and it.group_size < 2:
            add(f"{where}.group_size: must be null or at least 2")
        if NAME_RE.match(it.var or "") and it.var not in RESERVED_VARIABLES and it.var not in iterate_vars:
            iterate_vars.append(it.var)
    item_vars = record_vars + tuple(_expand_vars(iterate_vars))
    target_vars = item_vars + ("target", "target_index", "target_no", "target_key")

    output = spec.output
    output_columns = [output.reference_column, output.attention_column]
    if output.reason_column is not None:
        output_columns.append(output.reason_column)
    reserved = set(RESERVED_COLUMNS) | set(output_columns)
    if not item.fields:
        add("$.item.fields: at least one field is required")
    targets = []
    for name, f in item.fields.items():
        where = f"$.item.fields.{name}"
        if not NAME_RE.match(name):
            add(f"{where}: field name must match ^[A-Za-z_][A-Za-z0-9_]*$")
        elif name in reserved:
            add(f"{where}: field name {name!r} is reserved (hit_id, record_ids, item_ids, attention, output columns)")
        if f.role not in FIELD_ROLES:
            add(f"{where}.role: must be one of {', '.join(repr(r) for r in FIELD_ROLES)}")
        if f.style not in FIELD_STYLES:
            add(f"{where}.style: must be one of {', '.join(repr(s) for s in FIELD_STYLES)}")
        if not f.label.strip():
            add(f"{where}.label: must not be empty")
        _check_path(f.path, f"{where}.path", item_vars, errors)
        if f.role == "target":
            targets.append(name)
    if spec.legacy:
        if item.fields and len(targets) != 1:
            add(f"$.item.fields: exactly one field must have role \"target\" (found {len(targets)}: {', '.join(targets) or 'none'})")
    elif len(targets) > 1:
        add(f"$.item.fields: at most one field may have role \"target\" (found {len(targets)}: {', '.join(targets)})")

    _check_questions(spec, bool(targets), item_vars, target_vars, errors)
    _check_hit(spec, bool(targets), errors)

    if not NAME_RE.match(output.reference_column or ""):
        add("$.output.reference_column: must match ^[A-Za-z_][A-Za-z0-9_]*$")
    elif output.reference_column in RESERVED_COLUMNS:
        add(f"$.output.reference_column: {output.reference_column!r} is reserved")
    if output.reason_column is not None:
        if not NAME_RE.match(output.reason_column):
            add("$.output.reason_column: must match ^[A-Za-z_][A-Za-z0-9_]*$")
        elif output.reason_column in RESERVED_COLUMNS:
            add(f"$.output.reason_column: {output.reason_column!r} is reserved")
        elif output.reason_column == output.reference_column:
            add("$.output.reason_column: must differ from reference_column")
    if not NAME_RE.match(output.attention_column or ""):
        add("$.output.attention_column: must match ^[A-Za-z_][A-Za-z0-9_]*$")
    elif output.attention_column in RESERVED_COLUMNS:
        add(f"$.output.attention_column: {output.attention_column!r} is reserved")
    elif output.attention_column in (output.reference_column, output.reason_column):
        add("$.output.attention_column: must differ from reference_column and reason_column")
    return errors


def _value_word(question: QuestionSpec) -> str:
    return "a scale value" if question.type == "likert" else "an option value"


def _check_questions(spec: TaskSpec, has_target: bool, item_vars: tuple[str, ...], target_vars: tuple[str, ...],
                     errors: list[str]) -> None:
    add = errors.append
    questions = spec.item.questions
    if not questions:
        add("$.item.questions: at least one question is required")
    earlier: dict[str, QuestionSpec] = {}
    all_ids = [q.id for q in questions]
    for index, q in enumerate(questions):
        where = question_where(spec, index)
        if spec.legacy:
            if not SUFFIX_RE.match(q.answer_suffix or ""):
                add(f"{where}.answer_suffix: must match ^[A-Za-z0-9_]*$")
        else:
            if not QUESTION_ID_RE.match(q.id or ""):
                add(f"{where}.id: must match ^[a-z][a-z0-9_]*$")
            elif q.id in earlier:
                add(f"{where}.id: duplicate question id {q.id!r}")
        if not q.text.strip():
            add(f"{where}.text: must not be empty")
        if q.type not in QUESTION_TYPES:
            add(f"{where}.type: must be one of {', '.join(repr(t) for t in QUESTION_TYPES)}")
        if q.scope not in QUESTION_SCOPES:
            add(f"{where}.scope: must be one of {', '.join(repr(s) for s in QUESTION_SCOPES)}")
        _check_options(q, where, errors)
        if q.none_label is not None:
            if q.type != "multi_select":
                add(f"{where}.none_label: only for multi_select questions (use null)")
            elif not q.none_label.strip():
                add(f"{where}.none_label: must not be empty (null uses {DEFAULT_NONE_LABEL!r})")
        _check_scale(q, where, errors)
        if q.min_chars < 0:
            add(f"{where}.min_chars: must be 0 or more")
        elif q.min_chars > 0 and q.type != "text":
            add(f"{where}.min_chars: only for text questions (use 0)")
        if q.type == "multi_select" and q.scope != "target":
            add(f"{where}.scope: a multi_select question asks about the targets, so its scope must be \"target\"")
        if q.scope == "target" and not has_target and not spec.legacy:
            add(f"{where}.scope: \"target\" needs a field with role \"target\" (use scope \"item\" to ask once per tab)")
        _check_condition(spec, q, where, earlier, all_ids, errors)
        if q.hint is not None:
            _check_hint(spec, q, index, target_vars if q.scope == "target" else item_vars, errors)
        if q.id and q.id not in earlier:
            earlier[q.id] = q

    # 자유 서술 답은 콘솔이 이름 접미어로 가려낸다: 한쪽이 text면 "_" 경계 접미어가 겹치면 안 된다
    for index, a in enumerate(questions):
        for other_index, b in enumerate(questions):
            if index == other_index or not a.id or not b.id or a.id == b.id or "text" not in (a.type, b.type):
                continue
            if a.id.endswith("_" + b.id):
                add(f"{question_where(spec, other_index)}.id: {b.id!r} is a '_' suffix of the question id {a.id!r}; with a "
                    "text question involved the console could not tell their answers apart, so rename one of them")


def _check_options(q: QuestionSpec, where: str, errors: list[str]) -> None:
    add = errors.append
    if q.type in ("likert", "text"):
        if q.options:
            add(f"{where}.options: must be empty for a {q.type} question")
        return
    values: list[str] = []
    for index, option in enumerate(q.options):
        here = f"{where}.options[{index}]"
        if not OPTION_VALUE_RE.match(option.value or ""):
            add(f"{here}.value: must match ^[A-Za-z0-9_ .-]+$")
        elif option.value in values:
            add(f"{here}.value: duplicate option value {option.value!r}")
        if not option.label.strip():
            add(f"{here}.label: must not be empty")
        values.append(option.value)
    if q.type == "multi_select" and len(q.options) != 2:
        add(f"{where}.options: a multi_select question needs exactly 2 options: first the value stored for a ticked "
            "target, then the value for a target that is not ticked")
    elif q.type == "choice" and len(q.options) < 2:
        add(f"{where}.options: at least 2 options are required")


def _check_scale(q: QuestionSpec, where: str, errors: list[str]) -> None:
    add = errors.append
    if q.type != "likert":
        if q.scale is not None:
            add(f"{where}.scale: only for likert questions (use null)")
        return
    scale = q.scale
    if scale is None:
        add(f"{where}.scale: required for a likert question ({{\"min\": 1, \"max\": 5, \"min_label\": …, \"max_label\": …}})")
        return
    if scale.max <= scale.min:
        add(f"{where}.scale.max: must be greater than scale.min")
    elif scale.max - scale.min + 1 > MAX_LIKERT_POINTS:
        add(f"{where}.scale: at most {MAX_LIKERT_POINTS} points (max - min + 1)")
    for key in ("min_label", "max_label"):
        label = getattr(scale, key)
        if label is not None and not label.strip():
            add(f"{where}.scale.{key}: must not be empty (use null)")


def _check_condition(spec: TaskSpec, q: QuestionSpec, where: str, earlier: dict[str, QuestionSpec],
                     all_ids: list[str], errors: list[str]) -> None:
    condition = q.required_when
    if condition is None:
        return
    add = errors.append
    here = f"{where}.required_when"
    if not q.required:
        add(f"{here}: only for required questions (set required to true; the question is then required only when "
            "the condition holds)")
    ref = earlier.get(condition.question)
    if ref is None:
        if condition.question in all_ids and condition.question != q.id:
            add(f"{here}.question: {condition.question!r} must come before this question")
        else:
            add(f"{here}.question: {condition.question!r} is not an earlier question id "
                f"(earlier: {', '.join(earlier) or 'none'})")
        return
    if ref.type == "text":
        add(f"{here}.question: {condition.question!r} is a text question; a condition needs a question with fixed values")
        return
    if condition.value not in ref.values:
        add(f"{here}.value: {condition.value!r} is not {_value_word(ref)} of {condition.question!r} ({', '.join(ref.values)})")
    if q.scope == "item" and ref.scope == "target":
        add(f"{here}.question: an item-scoped question cannot depend on the target-scoped question {condition.question!r}")


def _check_hint(spec: TaskSpec, q: QuestionSpec, index: int, variables: tuple[str, ...], errors: list[str]) -> None:
    add = errors.append
    hint = q.hint
    assert hint is not None
    where = hint_where(spec, index)
    if q.type == "text":
        add(f"{where}: not allowed for a text question (free text has no reference; use null)")
        return
    values = q.values
    _check_path(hint.label_path, f"{where}.label_path", variables, errors)
    if hint.reason_path is not None:
        _check_path(hint.reason_path, f"{where}.reason_path", variables, errors)
    if hint.contains is not None:
        if not hint.contains.strip():
            add(f"{where}.contains: must not be empty (use null)")
        for name in paths.variable_names(hint.contains):
            if name not in variables:
                add(f"{where}.contains: unknown variable {{{name}}} (available: {', '.join(variables) or 'none'})")
        if hint.map is None:
            if not set(CONTAINS_VALUES) <= set(values):
                add(f"{where}.contains: needs a map from \"true\"/\"false\" to {_value_word(q)}s "
                    f"(or options with the values \"true\" and \"false\")")
        elif not set(CONTAINS_VALUES) & set(hint.map):
            add(f"{where}.map: with contains, the raw labels are \"true\" and \"false\"; map them to {_value_word(q)}s")
    if hint.map is not None:
        for key, value in hint.map.items():
            if value not in values:
                add(f"{where}.map.{key}: {value!r} is not {_value_word(q)} ({', '.join(values)})")
    if hint.missing is not None and hint.missing not in values:
        add(f"{where}.missing: {hint.missing!r} is not {_value_word(q)} ({', '.join(values)})")


def _check_hit(spec: TaskSpec, has_target: bool, errors: list[str]) -> None:
    add = errors.append
    hit = spec.hit
    if hit.items_per_hit < 1:
        add("$.hit.items_per_hit: must be at least 1")
    if hit.group_by not in GROUP_BY:
        add(f"$.hit.group_by: must be one of {', '.join(repr(g) for g in GROUP_BY)}")
    attention = hit.attention
    if attention is None:
        return
    where = "$.hit.attention"
    if attention.per_hit < 0:
        add(f"{where}.per_hit: must be 0 or more")
    if attention.position not in POSITIONS:
        add(f"{where}.position: must be one of {', '.join(repr(p) for p in POSITIONS)}")
    if attention.strategy not in STRATEGIES:
        add(f"{where}.strategy: must be one of {', '.join(repr(s) for s in STRATEGIES)}")
    questions = {q.id: q for q in spec.item.questions}
    if spec.legacy:
        values = spec.item.questions[0].values if spec.item.questions else []
        value = attention.expected.get(LEGACY_QUESTION_ID, "")
        if value not in values:
            add(f"{where}.expected_value: {value!r} is not an option value ({', '.join(values)})")
    else:
        if not attention.expected:
            add(f"{where}.expected: at least one question id with its expected value is required")
        for question_id, value in attention.expected.items():
            q = questions.get(question_id)
            if q is None:
                add(f"{where}.expected.{question_id}: not a question id ({', '.join(questions) or 'none'})")
            elif q.type == "text":
                add(f"{where}.expected.{question_id}: a text question has no expected value")
            elif value not in q.values:
                add(f"{where}.expected.{question_id}: {value!r} is not {_value_word(q)} of this question ({', '.join(q.values)})")
    if attention.max_targets is not None and attention.max_targets < 1:
        add(f"{where}.max_targets: must be null or at least 1")
    context_names = [name for name, f in spec.item.fields.items() if f.role == "context"]
    if attention.strategy == "mismatch":
        if attention.mismatch is None:
            add(f"{where}.mismatch: required when strategy is \"mismatch\"")
        else:
            if not attention.mismatch.swap_fields:
                add(f"{where}.mismatch.swap_fields: at least one context field is required")
            for name in attention.mismatch.swap_fields:
                if name not in context_names:
                    add(f"{where}.mismatch.swap_fields: {name!r} is not a context field ({', '.join(context_names) or 'none'})")
            if attention.mismatch.distance < 1:
                add(f"{where}.mismatch.distance: must be at least 1")
    elif attention.strategy == "instruction":
        if not has_target and not spec.legacy:
            add(f"{where}.strategy: \"instruction\" needs a field with role \"target\" (the instruction text replaces "
                "the targets); use \"mismatch\"")
        if attention.instruction is None:
            add(f"{where}.instruction: required when strategy is \"instruction\"")
        elif not attention.instruction.text.strip():
            add(f"{where}.instruction.text: must not be empty")


def _expand_vars(names: list[str]) -> list[str]:
    out = []
    for name in names:
        out.extend((name, f"{name}_index", f"{name}_no", f"{name}_key"))
    return out


_DOTTED_KEY_RE = re.compile(r"\.(\{[A-Za-z_][A-Za-z0-9_]*\}[^.\[]*|\d[^.\[]*)")


def _check_path(path: str, where: str, allowed_vars: tuple[str, ...], errors: list[str]) -> None:
    if not isinstance(path, str) or not path:
        errors.append(f"{where}: path is required")
        return
    try:
        paths.check_syntax(path)
    except PathError as error:
        dotted = _DOTTED_KEY_RE.search(path)
        if dotted is not None:
            # '.{sub_key}', '.1' 처럼 변수나 숫자를 점 뒤에 쓴 경우: 고치는 방법을 알려 준다
            errors.append(f"{where}: invalid path {path!r}: {dotted.group(0)!r} is not allowed after '.'; an object key that "
                          "is a variable or starts with a digit is written in quotes, e.g. ['{sub_key}'] or "
                          "['Core subquery {sub_no}'], and a list index as [0]")
        else:
            errors.append(f"{where}: invalid path: {error}")
        return
    for name in paths.variable_names(path):
        if name not in allowed_vars:
            errors.append(f"{where}: unknown variable {{{name}}} (available: {', '.join(allowed_vars) or 'none'})")


# ----------------------------------------------------------------------------------------------
# 탭 안의 문항 배치 (전처리의 답 순서, 렌더의 화면 순서, 검증의 답 이름 시뮬레이션이 같이 쓴다)
# ----------------------------------------------------------------------------------------------


def question_blocks(questions: list[QuestionSpec]) -> list[tuple[str, list[int]]]:
    """문항들을 화면 묶음으로 나눈다. (kind, 문항 index 목록) 목록.

    kind는 "targets"(연속한 target 문항 중 multi_select가 아닌 것들: target마다 카드 하나에 차례로 묻는다),
    "multi"(multi_select 하나: 문항 글 아래 target마다 체크박스), "item"(item 문항 하나)."""
    blocks: list[tuple[str, list[int]]] = []
    for index, q in enumerate(questions):
        if q.scope == "target" and q.type != "multi_select":
            if blocks and blocks[-1][0] == "targets":
                blocks[-1][1].append(index)
            else:
                blocks.append(("targets", [index]))
        elif q.scope == "target":
            blocks.append(("multi", [index]))
        else:
            blocks.append(("item", [index]))
    return blocks


def answer_slots(spec: TaskSpec, n_targets: int) -> list[tuple[QuestionSpec, int | None]]:
    """target이 n_targets개인 탭의 답 칸들을 화면 순서대로: (문항, target 번호(1부터) 또는 item 문항이면 None)."""
    questions = spec.item.questions
    slots: list[tuple[QuestionSpec, int | None]] = []
    for kind, indexes in question_blocks(questions):
        if kind == "targets":
            for target_no in range(1, n_targets + 1):
                slots.extend((questions[index], target_no) for index in indexes)
        elif kind == "multi":
            slots.extend((questions[indexes[0]], target_no) for target_no in range(1, n_targets + 1))
        else:
            slots.append((questions[indexes[0]], None))
    return slots


# ----------------------------------------------------------------------------------------------
# 레코드에 spec을 적용하는 규칙 (검증과 전처리가 함께 쓴다)
# ----------------------------------------------------------------------------------------------


def record_id_of(spec: TaskSpec, record: Any, record_index: int) -> str:
    """레코드 ID. source.record_id 경로가 문자열·정수로 풀리면 그 값, 아니면 r{record_no}."""
    path = spec.source.record_id
    if path:
        value = paths.evaluate(path, record)
        if isinstance(value, (str, int)) and not isinstance(value, bool):
            return str(value)
    return f"r{record_index + 1}"


def record_variables(record_index: int, record_id: str) -> dict[str, Any]:
    return {"record_index": record_index, "record_no": record_index + 1, "record_id": record_id}


def filter_matches(filter_spec: FilterSpec, record: Any) -> bool:
    value = paths.evaluate(filter_spec.path, record)
    if filter_spec.mode == "exists":
        return (value is not MISSING) == bool(filter_spec.value)
    return value is not MISSING and value == filter_spec.value


def iter_item_variables(spec: TaskSpec, record: Any, base: dict[str, Any]) -> Iterator[dict[str, Any]]:
    """iterate를 데카르트 곱으로 돌며 항목마다 변수 dict를 낸다 (X, X_index, X_no, X_key 포함).

    iterate 경로가 리스트나 dict로 풀리지 않으면 SpecError."""
    if not spec.item.iterate:
        yield dict(base)
        return
    yield from _iterate_from(spec, record, base, 0)


def _iterate_from(spec: TaskSpec, record: Any, variables: dict[str, Any], index: int) -> Iterator[dict[str, Any]]:
    if index == len(spec.item.iterate):
        yield dict(variables)
        return
    it = spec.item.iterate[index]
    container = paths.evaluate(it.path, record, variables)
    where = f"$.item.iterate[{index}].path"
    if container is MISSING:
        raise SpecError([f"{where}: {it.path!r} does not resolve in record {variables.get('record_id')!r}"])
    if isinstance(container, dict):
        entries = list(container.items())
    elif isinstance(container, list):
        entries = list(enumerate(container))
    else:
        raise SpecError([f"{where}: {it.path!r} resolves to {type(container).__name__} in record "
                         f"{variables.get('record_id')!r}, expected a list or an object"])
    if it.limit is not None:
        entries = entries[: it.limit]
    if it.group_size is not None:
        # 원소를 group_size개씩 묶는다. 값은 원소 목록, 키는 묶음 첫 원소의 키. 모자란 마지막 묶음은 버린다
        size = it.group_size
        entries = [(entries[start][0], [value for _, value in entries[start:start + size]])
                   for start in range(0, len(entries) - size + 1, size)]
    for position, (key, value) in enumerate(entries):
        child = dict(variables)
        child[it.var] = value
        child[f"{it.var}_index"] = position
        child[f"{it.var}_no"] = position + 1
        child[f"{it.var}_key"] = key
        yield from _iterate_from(spec, record, child, index + 1)


def field_value(field_spec: FieldSpec, record: Any, variables: dict[str, Any]) -> str | list[str] | None:
    """context 필드 값. 문자열(숫자·불도 문자열로) 또는 문자열 리스트. 없거나 형이 맞지 않으면 None."""
    value = paths.evaluate(field_spec.path, record, variables)
    return coerce_text(value)


def coerce_text(value: Any) -> str | list[str] | None:
    if isinstance(value, str):
        return value
    if isinstance(value, (bool, int, float)):
        return str(value)
    if isinstance(value, list):
        out = []
        for element in value:
            if isinstance(element, str):
                out.append(element)
            elif isinstance(element, (bool, int, float)):
                out.append(str(element))
            else:
                return None
        return out
    return None


def resolve_targets(field_spec: FieldSpec, record: Any, variables: dict[str, Any]) -> tuple[list[str], list[str | int]]:
    """target 필드를 (문자열 목록, 키 목록)으로 푼다. 원천이 dict면 키가, 리스트면 index가 키다.

    경로가 풀리지 않거나 문자열 리스트가 아니면 SpecError. 빈 리스트는 그대로 돌려준다."""
    where = f"$.item.fields.{field_spec.name}.path"
    path = field_spec.path
    trailing = _strip_trailing_wildcard(path)
    if trailing is not None and not paths.has_wildcard(trailing):
        container = paths.evaluate(trailing, record, variables)
    else:
        container = paths.evaluate(path, record, variables)
    if container is MISSING:
        raise SpecError([f"{where}: {path!r} does not resolve in record {variables.get('record_id')!r}"])
    if isinstance(container, dict):
        keys: list[str | int] = list(container.keys())
        raw = list(container.values())
    elif isinstance(container, list):
        keys = list(range(len(container)))
        raw = container
    else:
        raise SpecError([f"{where}: {path!r} resolves to {type(container).__name__} in record "
                         f"{variables.get('record_id')!r}, expected a list of strings"])
    targets: list[str] = []
    for element in raw:
        if isinstance(element, str):
            targets.append(element)
        elif isinstance(element, (int, float)) and not isinstance(element, bool):
            targets.append(str(element))
        else:
            raise SpecError([f"{where}: {path!r} contains a {type(element).__name__} in record "
                             f"{variables.get('record_id')!r}, expected strings"])
    return targets, keys


def _strip_trailing_wildcard(path: str) -> str | None:
    if path.endswith("[*]") and len(path) > 3:
        return path[:-3]
    if path.endswith(".*") and len(path) > 2:
        return path[:-2]
    return None


def target_variables(variables: dict[str, Any], target: str, index: int, key: str | int) -> dict[str, Any]:
    out = dict(variables)
    out["target"] = target
    out["target_index"] = index
    out["target_no"] = index + 1
    out["target_key"] = key
    return out


def fill_text(template: str, variables: dict[str, Any]) -> str:
    """글 안의 {name}을 str(변수 값)으로 바꾼다 (hint.contains). 모르는 변수는 PathError."""

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in variables:
            raise PathError(f"unknown variable {{{name}}} in {template!r}")
        return str(variables[name])

    return paths.VAR_RE.sub(replace, template)


def contains_label(hint: HintSpec, value: Any, variables: dict[str, Any]) -> Any:
    """label_path의 값에 hint.contains의 글이 있는지: 목록이면 원소, 객체면 키와 비교해 "true"/"false".

    값이 없거나(MISSING, null) 목록·객체가 아니면 MISSING (→ hint.missing)."""
    if value is MISSING or value is None or not isinstance(value, (list, dict)):
        return MISSING
    needle = fill_text(hint.contains or "", variables).strip()
    members = value.keys() if isinstance(value, dict) else value
    for member in members:
        if isinstance(member, (str, int, float)) and not isinstance(member, bool) and str(member).strip() == needle:
            return "true"
    return "false"


def hint_label(hint: HintSpec, record: Any, variables: dict[str, Any]) -> Any:
    """hint의 원시 라벨. contains가 없으면 label_path의 값, 있으면 contains_label의 "true"/"false" (없으면 MISSING)."""
    value = paths.evaluate(hint.label_path, record, variables)
    if hint.contains is None:
        return value
    return contains_label(hint, value, variables)


def hint_reason(hint: HintSpec, record: Any, variables: dict[str, Any]) -> str | None:
    """reason_path의 값 (문자열이 아니면 JSON 문자열). 없으면 None."""
    if hint.reason_path is None:
        return None
    raw = paths.evaluate(hint.reason_path, record, variables)
    if raw is MISSING or raw is None:
        return None
    return raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False)


def map_hint(hint: HintSpec, raw: Any) -> str | None:
    """원시 라벨 값을 option value로 바꾼다. 없거나 map에 없으면 hint.missing."""
    if raw is MISSING or raw is None:
        return hint.missing
    text = str(raw).strip()
    if hint.map is None:
        return text
    return hint.map.get(text, hint.missing)


# ----------------------------------------------------------------------------------------------
# 경로 제안 (풀리지 않는 경로에 실제로 있는 가장 가까운 경로를 붙인다. 외부 도구 plan._suggest의 방식)
# ----------------------------------------------------------------------------------------------

_TOKEN_SPLIT_RE = re.compile(r"[.\[\]{}'\"*$\s]+")
_VARIABLE_KEY_RE = re.compile(r"\[(['\"])(?:(?!\1).)*\{[A-Za-z_][A-Za-z0-9_]*\}(?:(?!\1).)*\1\]")


def known_paths(records: list[Any]) -> list[str]:
    """레코드들에 실제로 있는 경로 패턴 (profile의 표기: 목록은 [*], 맵 키는 {key})."""
    from agent.profile import profile_records  # profile은 무거우므로 제안이 필요할 때만 읽는다

    return [entry["path"] for entry in profile_records(list(records)).get("paths", []) if entry.get("path") != "$"]


def _path_tokens(path: str) -> set[str]:
    return {token for token in _TOKEN_SPLIT_RE.split(path.lower()) if token}


def _last_token(path: str) -> str:
    tokens = [token for token in _TOKEN_SPLIT_RE.split(path.lower()) if token]
    return tokens[-1] if tokens else ""


def _stem_bonus(a: str, b: str) -> float:
    """마지막 이름이 같은 어간(앞 3글자 이상)으로 시작하면 주는 보너스 (question ↔ query)."""
    shared = 0
    for x, y in zip(a, b):
        if x != y:
            break
        shared += 1
    return 0.5 * shared / max(len(a), len(b)) if shared >= 3 else 0.0


def suggest_path(path: str, known: list[str]) -> str | None:
    """known 중 path와 가장 비슷한 경로 하나 (토큰 Jaccard + 0.5 × 철자 유사도 + 어간 보너스). 충분히 비슷한 것이 없으면 None.

    변수가 든 따옴표 키(['Chunk {chunk_no}'])는 profile처럼 .{key}로 바꿔서 비교한다. 최상위 키 하나뿐인 경로($.x)는
    최상위 경로들과만 비교한다."""
    if not path.startswith("$"):
        return None
    normalized = _VARIABLE_KEY_RE.sub(".{key}", path)
    tokens = _path_tokens(normalized)
    last = _last_token(normalized)
    candidates = known
    if len(tokens) == 1:
        candidates = [candidate for candidate in known if len(_path_tokens(candidate)) == 1]
    best, best_score = None, 0.0
    for candidate in candidates:
        if candidate in (path, normalized):
            continue
        candidate_tokens = _path_tokens(candidate)
        overlap = len(tokens & candidate_tokens) / max(1, len(tokens | candidate_tokens))
        score = (overlap + 0.5 * SequenceMatcher(None, normalized.lower(), candidate.lower()).ratio()
                 + _stem_bonus(last, _last_token(candidate)))
        if score > best_score:
            best, best_score = candidate, score
    return best if best_score >= SUGGEST_MIN_SCORE else None


def _missing_top_key(path: str, record: Any) -> list[str] | None:
    """path의 첫 키가 레코드에 없으면 레코드의 최상위 키들, 있으면 None."""
    if not path.startswith("$") or not isinstance(record, dict):
        return None
    try:
        segments = paths.parse(paths.substitute(path, _AnyVariables()))
    except PathError:
        return None
    if len(segments) < 2 or segments[1].kind != "key" or segments[1].value in record:
        return None
    return [str(key) for key in record]


class _AnyVariables(dict):
    """경로 문법만 볼 때 쓰는 변수 표. 어떤 이름이든 "1"."""

    def __missing__(self, key: str) -> str:
        return "1"


def _static_prefix(path: str) -> str | None:
    """변수가 처음 나오는 세그먼트 앞까지의 경로 ($.a.b['Chunk {n}'].c → $.a.b). 변수가 없거나 루트가 변수면 None."""
    position = path.find("{")
    if not path.startswith("$") or position < 0:
        return None
    cut = max(path.rfind(".", 0, position), path.rfind("[", 0, position))
    if cut <= 0:
        return None
    prefix = path[:cut]
    try:
        paths.check_syntax(prefix)
    except PathError:
        return None
    return prefix


# ----------------------------------------------------------------------------------------------
# 실측 검증
# ----------------------------------------------------------------------------------------------


@dataclass
class _HintCount:
    total: int = 0
    resolved: int = 0
    mapped: int = 0
    reasons: int = 0
    broken: bool = False
    unmapped: list[str] = field(default_factory=list)


def validate_against_records(spec: TaskSpec, records: list[Any], max_records: int = VALIDATE_RECORDS) -> list[str]:
    """첫 레코드 몇 개(필터 통과분)로 경로가 풀리는지 검사한다. 오류 문자열 목록. 비어 있으면 통과."""
    errors = check_spec(spec)
    if errors:
        return errors
    if not records:
        return ["no records to validate against"]

    deep: list[tuple[int, Any]] = []
    for index, record in enumerate(records):
        if spec.source.filter is not None:
            try:
                if not filter_matches(spec.source.filter, record):
                    continue
            except PathError as error:
                return [f"$.source.filter.path: {error}"]
        deep.append((index, record))
        if len(deep) >= max(max_records, DATA_CHECK_RECORDS):
            break
    if not deep:
        return ["$.source.filter: no record matches the filter"]
    checked = deep[:max_records]

    seen: set[str] = set()
    known: list[str] | None = None

    def add(message: str, path: str | None = None, record: Any = None) -> None:
        # 같은 문제를 레코드마다 되풀이하지 않는다: " in record …" 앞부분이 같으면 한 번만 적는다
        nonlocal known
        key = message.split(" in record ")[0]
        if key in seen:
            return
        seen.add(key)
        if path is not None and ("does not resolve" in message or "never resolves" in message):
            if known is None:
                known = known_paths([record for _, record in checked])
            suggestion = suggest_path(path, known)
            if suggestion:
                message += f" (did you mean {suggestion!r}?)"
            top_keys = _missing_top_key(path, record) if record is not None else None
            if top_keys:
                more = ", …" if len(top_keys) > TOP_LEVEL_KEYS_SHOWN else ""
                message += f" (top-level keys: {', '.join(top_keys[:TOP_LEVEL_KEYS_SHOWN])}{more})"
        errors.append(message)

    target_field = spec.target_field
    hinted = [(index, q) for index, q in enumerate(spec.item.questions) if q.hint is not None and q.type != "text"]
    counts = {index: _HintCount() for index, _ in hinted}
    items_total = 0
    items_with_targets = 0
    target_errors = 0

    def check_hint(index: int, q: QuestionSpec, record: Any, variables: dict[str, Any]) -> None:
        hint = q.hint
        count = counts[index]
        if hint is None or count.broken:
            return
        where = hint_where(spec, index)
        count.total += 1
        try:
            value = paths.evaluate(hint.label_path, record, variables)
            label = value if hint.contains is None else contains_label(hint, value, variables)
        except PathError as error:
            add(f"{where}.label_path: {error}")
            count.broken = True
            return
        if value is not MISSING and value is not None:
            count.resolved += 1
            if hint.contains is not None and not isinstance(value, (list, dict)):
                add(f"{where}.label_path: {hint.label_path!r} resolves to {type(value).__name__} in record "
                    f"{variables.get('record_id')!r}, expected a list or an object (hint.contains is set)")
        if label is not MISSING and label is not None:
            text = str(label).strip()
            known_label = text in hint.map if hint.map is not None else text in q.values
            if known_label:
                count.mapped += 1
            elif text not in count.unmapped:
                count.unmapped.append(text)
        if hint.reason_path is not None:
            try:
                reason = paths.evaluate(hint.reason_path, record, variables)
            except PathError as error:
                add(f"{where}.reason_path: {error}")
                count.broken = True
                return
            if reason is not MISSING and reason is not None:
                count.reasons += 1

    for index, record in checked:
        if spec.source.record_id:
            value = paths.evaluate(spec.source.record_id, record)
            if value is MISSING:
                add(f"$.source.record_id: {spec.source.record_id!r} does not resolve in record #{index + 1}", spec.source.record_id, record)
            elif not isinstance(value, (str, int)) or isinstance(value, bool):
                add(f"$.source.record_id: {spec.source.record_id!r} resolves to {type(value).__name__} in record #{index + 1}, expected a string")
        record_id = record_id_of(spec, record, index)
        base = record_variables(index, record_id)
        try:
            items = list(iter_item_variables(spec, record, base))
        except SpecError as error:
            for message in error.messages:
                add(message, _iterate_path(spec, message), record)
            continue
        except PathError as error:
            add(f"$.item.iterate: {error}")
            continue

        for variables in items:
            items_total += 1
            for f in spec.context_fields:
                where = f"$.item.fields.{f.name}.path"
                try:
                    value = paths.evaluate(f.path, record, variables)
                except PathError as error:
                    add(f"{where}: {error}")
                    continue
                if value is MISSING:
                    add(f"{where}: {f.path!r} does not resolve in record {record_id!r}", f.path, record)
                elif coerce_text(value) is None:
                    add(f"{where}: {f.path!r} resolves to {type(value).__name__} in record {record_id!r}, expected text or a list of texts")
            targets: list[str] = []
            keys: list[str | int] = []
            if target_field is not None:
                try:
                    targets, keys = resolve_targets(target_field, record, variables)
                except SpecError as error:
                    target_errors += 1
                    for message in error.messages:
                        if " resolves to " in message and message.endswith("expected a list of strings"):
                            message += TARGET_SCALAR_HINT
                        add(message, target_field.path, record)
                    continue
                except PathError as error:
                    target_errors += 1
                    add(f"$.item.fields.{target_field.name}.path: {error}")
                    continue
                if not targets:
                    if not spec.item.skip_if_no_targets:
                        add(f"$.item.fields.{target_field.name}.path: no targets in record {record_id!r} and skip_if_no_targets is false")
                    continue
                items_with_targets += 1
            for question_index, q in hinted:
                if q.scope == "item":
                    check_hint(question_index, q, record, variables)
                    continue
                for position, (target, key) in enumerate(zip(targets, keys)):
                    check_hint(question_index, q, record, target_variables(variables, target, position, key))

    count = len(checked)
    if items_total == 0:
        add(f"$.item.iterate: the first {count} record(s) produce no items")
    elif target_field is not None and items_with_targets == 0 and target_errors == 0:
        add(f"$.item.fields.{target_field.name}.path: no item has targets in the first {count} record(s)")
    for index, q in hinted:
        hint = q.hint
        tally = counts[index]
        if hint is None or tally.total == 0 or tally.broken:
            continue
        where = hint_where(spec, index)
        what = "targets" if q.scope == "target" else "items"
        if tally.resolved == 0:
            # 드문드문한 라벨 맵(없는 키가 곧 "해당 없음")은 missing이 있고 변수 앞까지의 경로가 풀리면 오류로 보지 않는다
            prefix = _static_prefix(hint.label_path)
            sparse = hint.missing is not None and prefix is not None and any(
                paths.evaluate(prefix, record) is not MISSING for _, record in checked)
            if not sparse:
                add(f"{where}.label_path: {hint.label_path!r} never resolves for the {what} of the first {count} record(s)",
                    hint.label_path, checked[0][1])
        elif tally.mapped == 0:
            add(f"{where}.map: no observed label maps to {_value_word(q)} (observed: {', '.join(repr(v) for v in tally.unmapped[:8])})")
        if hint.reason_path is not None and tally.reasons == 0:
            add(f"{where}.reason_path: {hint.reason_path!r} never resolves for the {what} of the first {count} record(s)",
                hint.reason_path)
    attention = spec.hit.attention
    if attention is not None and attention.strategy == "mismatch" and attention.per_hit > 0 and len(records) < 2:
        add("$.hit.attention.mismatch: needs at least 2 records to take fields from another record")
    _data_checks(spec, [record for _, record in deep], add)
    return errors


def _iterate_path(spec: TaskSpec, message: str) -> str | None:
    """iterate 오류 메시지("$.item.iterate[1].path: …")가 가리키는 iterate 경로."""
    match = re.match(r"\$\.item\.iterate\[(\d+)\]\.path:", message)
    if match is None:
        return None
    index = int(match.group(1))
    return spec.item.iterate[index].path if index < len(spec.item.iterate) else None


# ----------------------------------------------------------------------------------------------
# 내용 검사 (경로는 풀리지만 뜻이 틀린 spec을 잡는다. DATA_CHECK_RECORDS개까지의 레코드로 본다)
# ----------------------------------------------------------------------------------------------


def _data_checks(spec: TaskSpec, records: list[Any], add) -> None:
    """contains가 라벨 목록과 맞는지, 라벨 맵에 빠진 항목이 있는데 missing이 없는지, 경로들이 같은 대상(같은 retriever·
    model 키)을 가리키는지, worker 문구에 데이터의 내부 이름이 있는지 본다. 오류는 add로 알린다."""
    contexts = _item_contexts(spec, records)
    count = len(records)
    for index, q in enumerate(spec.item.questions):
        hint = q.hint
        if hint is None or hint.contains is None or q.type == "text":
            continue
        scopes = list(_hint_scopes(q, contexts))
        _check_contains_matches(spec, index, q, scopes, count, add)
        if hint.missing is None:
            _check_missing_entries(spec, index, q, scopes, add)
    _check_key_consistency(spec, records, add)
    _check_internal_names(spec, records, add)


def _item_contexts(spec: TaskSpec, records: list[Any]) -> list[tuple[Any, dict[str, Any], list[str], list[str | int]]]:
    """(레코드, 항목 변수, targets, keys) 목록. 풀리지 않는 레코드·항목은 조용히 건너뛴다 (그런 오류는 앞에서 알렸다)."""
    target_field = spec.target_field
    out: list[tuple[Any, dict[str, Any], list[str], list[str | int]]] = []
    for index, record in enumerate(records):
        try:
            base = record_variables(index, record_id_of(spec, record, index))
            items = list(iter_item_variables(spec, record, base))
        except (SpecError, PathError):
            continue
        for variables in items:
            targets: list[str] = []
            keys: list[str | int] = []
            if target_field is not None:
                try:
                    targets, keys = resolve_targets(target_field, record, variables)
                except (SpecError, PathError):
                    continue
            out.append((record, variables, targets, keys))
            if len(out) >= DATA_CHECK_ITEMS:
                return out
    return out


def _hint_scopes(q: QuestionSpec, contexts) -> Iterator[tuple[Any, dict[str, Any]]]:
    """문항의 hint를 평가하는 (레코드, 변수) 목록: item 문항은 항목마다, target 문항은 target마다."""
    for record, variables, targets, keys in contexts:
        if q.scope == "item":
            yield record, variables
        else:
            for position, (target, key) in enumerate(zip(targets, keys)):
                yield record, target_variables(variables, target, position, key)


def _members(value: Any) -> list[str]:
    """contains가 비교하는 원소들: 목록이면 원소, 객체면 키 (문자열·숫자만, 앞뒤 공백 제거)."""
    items = value.keys() if isinstance(value, dict) else value if isinstance(value, list) else []
    return [str(item).strip() for item in items if isinstance(item, (str, int, float)) and not isinstance(item, bool)]


def _candidate_variables(spec: TaskSpec, q: QuestionSpec) -> list[str]:
    names = ["target_key", "target_no", "target"] if q.scope == "target" else []
    for it in spec.item.iterate:
        names.extend((f"{it.var}_key", f"{it.var}_no", it.var))
    return names


def _check_contains_matches(spec: TaskSpec, index: int, q: QuestionSpec, scopes, count: int, add) -> None:
    """라벨 목록이 비어 있지 않은데 contains의 글이 한 번도 없으면 오류. 목록 원소와 맞는 변수가 있으면 알려 준다."""
    hint = q.hint
    assert hint is not None and hint.contains is not None
    lists = 0
    examples: list[str] = []
    scores: dict[str, int] = {}
    for record, variables in scopes:
        try:
            members = _members(paths.evaluate(hint.label_path, record, variables))
            needle = fill_text(hint.contains, variables).strip()
        except PathError:
            return
        if not members:
            continue
        lists += 1
        if needle in members:
            return  # 한 번이라도 맞으면 된다
        for member in members:
            if member not in examples and len(examples) < 3:
                examples.append(member)
        for name in _candidate_variables(spec, q):
            value = variables.get(name)
            if isinstance(value, bool) or not isinstance(value, (str, int)) or (name.endswith("_key") and not isinstance(value, str)):
                continue
            text = str(value).strip()
            if not text or len(text) > 200:
                continue
            for member in members:
                if member == text:
                    template = "{" + name + "}"
                elif isinstance(value, int) and member.endswith(text) and len(member) > len(text) and not member[-len(text) - 1].isdigit():
                    template = member[: -len(text)] + "{" + name + "}"
                else:
                    continue
                scores[template] = scores.get(template, 0) + 1
    if lists == 0:
        return  # 판단할 수 없다
    where = hint_where(spec, index)
    message = (f"{where}.contains: {hint.contains!r} is never found in the label lists of question {q.id!r} ({lists} non-empty "
               f"list(s) in the first {count} record(s)); the lists hold values like {', '.join(repr(e) for e in examples)}")
    ranked = sorted(scores.items(), key=lambda entry: (entry[1], entry[0].startswith("{")), reverse=True)
    ranked = [template for template, _ in ranked if template != hint.contains]
    if ranked:
        message += f"; \"contains\": {json.dumps(ranked[0])} matches them"
    else:
        message += "; write contains so that it produces one of these values"
    add(message)


_TRAILING_NUMBER_RE = re.compile(r"(\d+)\s*$")


def _check_missing_entries(spec: TaskSpec, index: int, q: QuestionSpec, scopes, add) -> None:
    """contains hint의 라벨 맵은 있는데 이 항목의 항목(키)이 없고 missing이 null이면 오류.

    맵이 비어 있거나 더 큰 번호의 키가 있는데 빠진 경우만 센다 (번호 끝의 키는 아직 라벨이 없는 것일 수 있다)."""
    hint = q.hint
    assert hint is not None
    prefix = _static_prefix(hint.label_path)
    if prefix is None:
        return
    try:
        depth = len(paths.parse(prefix))
    except PathError:
        return
    absent = 0
    example: tuple[str, Any] | None = None
    for record, variables in scopes:
        try:
            value = paths.evaluate(hint.label_path, record, variables)
            container = paths.evaluate(prefix, record)
            segments = paths.parse(paths.substitute(hint.label_path, variables))
        except PathError:
            return
        if value is not MISSING and value is not None:
            continue
        if not isinstance(container, dict) or len(segments) <= depth or segments[depth].kind != "key":
            continue
        entry = str(segments[depth].value)
        if entry in container:
            continue
        number = _TRAILING_NUMBER_RE.search(entry)
        larger = number is not None and any(
            (other := _TRAILING_NUMBER_RE.search(str(key))) is not None and int(other.group(1)) > int(number.group(1))
            for key in container)
        if container and not larger:
            continue
        absent += 1
        if example is None:
            example = (entry, variables.get("record_id"))
    if not absent or example is None:
        return
    negative = None
    if hint.map is not None:
        negative = hint.map.get("false")
    elif "false" in q.values:
        negative = "false"
    advice = f"set missing to {negative!r}" if negative else "set missing to the value that means 'no'"
    add(f"{hint_where(spec, index)}.missing: {absent} answer(s) have no label entry (e.g. {example[0]!r} in record "
        f"{example[1]!r}) although the label map {prefix} exists; if an absent entry means 'no', {advice}")


def _literal_chain(path: str) -> list[tuple[str, str]]:
    """경로 앞부분의 글자 그대로인 키들: (부모 경로, 키) 목록. 변수·와일드카드·인덱스가 나오면 멈춘다."""
    if not isinstance(path, str) or not path.startswith("$"):
        return []
    cut = path
    if "{" in path:
        prefix = _static_prefix(path)
        if prefix is None:
            return []
        cut = prefix
    try:
        segments = paths.parse(cut)
    except PathError:
        return []
    chain: list[tuple[str, str]] = []
    parents = [segments[0]]
    for segment in segments[1:]:
        if segment.kind != "key":
            break
        chain.append((paths.format_path(parents), segment.value))
        parents.append(segment)
    return chain


def _shape(value: Any) -> tuple | None:
    """형제 값들이 같은 모양인지 비교할 요약. 빈 목록·객체는 None (비교에서 뺀다)."""
    if isinstance(value, dict):
        return ("dict", frozenset(re.sub(r"\d+", "#", str(key)) for key in value)) if value else None
    if isinstance(value, list):
        return ("list", type(value[0]).__name__) if value else None
    return (type(value).__name__,)


def _alternatives(parent: str, records: list[Any], cache: dict[str, set[str]]) -> set[str]:
    """parent가 같은 모양의 값을 가진 대안들의 맵(retriever·model별 목록 같은 것)이면 그 키들, 아니면 빈 집합.

    최상위($)는 늘 제외한다. 키가 2개 이상인 레코드 가운데 값 모양이 같은 레코드가 더 많아야 대안으로 본다."""
    if parent in cache:
        return cache[parent]
    keys: set[str] = set()
    same = different = 0
    if parent != "$":
        for record in records:
            try:
                container = paths.evaluate(parent, record)
            except PathError:
                break
            if not isinstance(container, dict) or len(container) < 2:
                continue
            shapes = {shape for shape in (_shape(value) for value in container.values()) if shape is not None}
            if len(shapes) <= 1:
                same += 1
                keys.update(str(key) for key in container)
            else:
                different += 1
    cache[parent] = keys if same > different else set()
    return cache[parent]


def _check_key_consistency(spec: TaskSpec, records: list[Any], add) -> None:
    """라벨 경로와 target·문맥 경로가 같은 부모의 서로 다른 키를 쓰면 오류 (다른 model의 facts에 대한 라벨 같은 실수).

    예: target이 $.atomic_facts.RT25.A[*]인데 라벨이 $.relevance_check.RT25.B…를 읽고, A와 B가 $.atomic_facts.RT25의
    키이면 알린다. 그 키를 문맥 경로가 쓰고 있으면(두 model을 나란히 보이는 작업) 알리지 않는다."""
    cache: dict[str, set[str]] = {}
    target_field = spec.target_field
    anchors: list[tuple[str, str, str]] = []  # (역할, 필드 경로, 경로)
    if target_field is not None:
        anchors.append(("target", f"$.item.fields.{target_field.name}.path", target_field.path))
    for f in spec.context_fields:
        anchors.append(("context", f"$.item.fields.{f.name}.path", f.path))
    for position, it in enumerate(spec.item.iterate):
        anchors.append(("context", f"$.item.iterate[{position}].path", it.path))
    chains = [(role, where, path, _literal_chain(path)) for role, where, path in anchors]
    anchor_keys = {key for _, _, _, chain in chains for _, key in chain}
    context_keys = {key for role, _, _, chain in chains if role == "context" for _, key in chain}
    target_keys = {key for role, _, _, chain in chains if role == "target" for _, key in chain}

    for index, q in enumerate(spec.item.questions):
        if q.hint is None or q.type == "text":
            continue
        label_keys = [key for _, key in _literal_chain(q.hint.label_path)]
        for role, _, path, chain in chains:
            for parent, key in chain:
                siblings = _alternatives(parent, records, cache)
                for other in label_keys:
                    if other == key or other not in siblings or key in label_keys or other in anchor_keys:
                        continue
                    if role == "target":
                        add(f"{hint_where(spec, index)}.label_path: reads labels for {other!r} but the targets come from "
                            f"{key!r} (both are keys of {parent}); labels must address the same targets — use the same key "
                            "in both paths")
                    else:
                        add(f"{hint_where(spec, index)}.label_path: reads labels for {other!r} but the tab shows {path} "
                            f"({other!r} and {key!r} are both keys of {parent}); labels must address what the tab shows — "
                            "use the same key in both paths")

    for role, where, path, chain in chains:
        if role != "target":
            continue
        for target_parent, target_key in chain:
            target_siblings = _alternatives(target_parent, records, cache)
            for other_role, _, other_path, other_chain in chains:
                if other_role != "context":
                    continue
                for context_parent, context_key in other_chain:
                    if context_key == target_key or target_key in context_keys or context_key in target_keys:
                        continue
                    if context_parent == target_parent:
                        continue  # 같은 맵의 두 키를 나란히 보이는 비교 작업이다
                    if context_key in target_siblings:
                        parent = target_parent
                    elif target_key in _alternatives(context_parent, records, cache):
                        parent = context_parent
                    else:
                        continue
                    add(f"{where}: the targets come from {target_key!r} but the tab shows {other_path} ({target_key!r} and "
                        f"{context_key!r} are both keys of {parent}); show targets and context from the same source — use "
                        "the same key in both paths")


_PATH_KEY_RE = re.compile(r"\.([A-Za-z_][A-Za-z0-9_-]*)|\[(['\"])([^'\"{}]*)\2\]")


_NUMBER_SUFFIX_RE = re.compile(r"\s*\d+$")


def _is_internal_name(key: str, siblings: set[str] | None = None) -> bool:
    """숫자가 들었지만 구조용 번호 라벨('Chunk 3', 'Atomic fact1')도 순수한 숫자도 아닌 키 ('RT25', 'mdl-5', 'mdl3_27B').

    띄어쓰기 없는 '글자+숫자' 키('fact1', 'rt25')는 형제 키(siblings)에 같은 글자에 번호만 다른 키가 있으면 번호 라벨로,
    없으면 내부 이름으로 본다. 형제를 모르면 번호 라벨로 본다 (잘못 알리지 않도록)."""
    if not any(ch.isdigit() for ch in key) or key.isdigit():
        return False
    if not ENUMERATED_LABEL_RE.match(key):
        return True
    if " " in key or siblings is None:
        return False
    stem = _NUMBER_SUFFIX_RE.sub("", key)
    return not any(other != key and _NUMBER_SUFFIX_RE.search(other) and _NUMBER_SUFFIX_RE.sub("", other) == stem
                   for other in siblings)


def _spec_paths(spec: TaskSpec) -> list[str]:
    out = [spec.source.record_id or "", spec.source.filter.path if spec.source.filter else ""]
    out.extend(it.path for it in spec.item.iterate)
    out.extend(f.path for f in spec.item.fields.values())
    for q in spec.item.questions:
        if q.hint is not None:
            out.extend(path for path in (q.hint.label_path, q.hint.reason_path) if path)
    return [path for path in out if path]


def _worker_strings(spec: TaskSpec) -> list[tuple[str, str]]:
    """worker가 읽는 문구들: (spec 안의 JSON 경로, 글)."""
    out = [("$.task.title", spec.task.title), ("$.task.description", spec.task.description)]
    out.extend((f"$.task.keywords[{i}]", keyword) for i, keyword in enumerate(spec.task.keywords))
    ins = spec.instructions
    out.extend([("$.instructions.summary", ins.summary), ("$.instructions.background", ins.background or ""),
                ("$.instructions.tip", ins.tip or "")])
    for i, criterion in enumerate(ins.criteria):
        out.extend([(f"$.instructions.criteria[{i}].label", criterion.label), (f"$.instructions.criteria[{i}].text", criterion.text)])
    out.extend((f"$.instructions.steps[{i}]", step) for i, step in enumerate(ins.steps))
    out.extend((f"$.instructions.notes[{i}]", note) for i, note in enumerate(ins.notes))
    for name, f in spec.item.fields.items():
        out.append((f"$.item.fields.{name}.label", f.label))
    for index, q in enumerate(spec.item.questions):
        where = question_where(spec, index)
        out.append((f"{where}.text", q.text))
        out.extend((f"{where}.options[{i}].label", option.label) for i, option in enumerate(q.options))
        if q.none_label:
            out.append((f"{where}.none_label", q.none_label))
        if q.scale is not None:
            out.extend((f"{where}.scale.{key}", getattr(q.scale, key) or "") for key in ("min_label", "max_label"))
    attention = spec.hit.attention
    if attention is not None and attention.instruction is not None:
        out.append(("$.hit.attention.instruction.text", attention.instruction.text))
    return [(where, text) for where, text in out if text]


def _check_internal_names(spec: TaskSpec, records: list[Any], add) -> None:
    """spec의 경로가 쓰는 데이터 키 중 내부 이름('RT25', 'mdl-5')과 그 형제 키가 worker 문구에 나오면 오류."""
    siblings: dict[str, set[str]] = {}  # 경로 앞부분의 키 → 레코드에서 본 형제 키들 (최상위 제외)
    for path in _spec_paths(spec):
        for parent, key in _literal_chain(path):
            if parent == "$":
                continue
            for record in records:
                try:
                    container = paths.evaluate(parent, record)
                except PathError:
                    break
                if isinstance(container, dict):
                    siblings.setdefault(key, set()).update(str(k) for k in container)
    names: list[str] = []
    for path in _spec_paths(spec):
        for match in _PATH_KEY_RE.finditer(path):
            key = match.group(1) or match.group(3) or ""
            if key not in names and _is_internal_name(key, siblings.get(key)):
                names.append(key)
    for key in list(names):
        for other in sorted(siblings.get(key, ())):
            if other not in names and _is_internal_name(other, siblings[key]):
                names.append(other)
    if not names:
        return
    patterns = [(name, re.compile(r"(?<![A-Za-z0-9])" + re.escape(name) + r"(?![A-Za-z0-9])", re.IGNORECASE)) for name in names]
    for where, text in _worker_strings(spec):
        for name, pattern in patterns:
            if pattern.search(text):
                add(f"{where}: mentions {name!r}, an internal name from the data; describe it in plain words "
                    "(e.g. 'retrieved passage')")
                break
