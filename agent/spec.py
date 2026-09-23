"""task_spec.json의 데이터클래스, 파서, 검증.

spec은 LLM(planner)이나 사람이 채우고, 전처리·렌더·검증은 spec만 보고 결정적으로 동작한다. 형식은
spec_reference.md에 영어로 설명해 두었다 (planner 프롬프트에 그대로 들어간다).

    parse_spec(data)                     dict → TaskSpec. 형식 오류를 전부 모아 SpecError(messages)로 올린다
    load_spec(path)                      JSON 파일 → TaskSpec
    spec_to_dict(spec)                   TaskSpec → dict (parse_spec의 역. json.dump 가능)
    check_spec(spec)                     데이터 없이 할 수 있는 정합성 검사. 오류 문자열 목록
    validate_against_records(spec, records)
                                         첫 레코드 몇 개로 경로가 실제로 풀리는지 검사. 오류 문자열 목록
    record_id_of, record_variables, iter_item_variables, field_value, resolve_targets,
    target_variables, map_hint, filter_matches
                                         전처리(preprocess)도 같은 규칙을 쓰도록 공개한 도우미들

오류 메시지는 "$.item.fields.facts.role: …"처럼 spec 안의 JSON 경로로 시작한다.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

from agent import paths
from agent.paths import MISSING, PathError

SPEC_VERSION = 1
TASK_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
OPTION_VALUE_RE = re.compile(r"^[A-Za-z0-9_ .-]+$")
SUFFIX_RE = re.compile(r"^[A-Za-z0-9_]*$")

RESERVED_COLUMNS = ("hit_id", "record_ids", "item_ids", "attention")
RESERVED_VARIABLES = ("record_index", "record_no", "record_id", "target", "target_index", "target_no", "target_key")
SOURCE_FORMATS = ("json_array", "json_object_values", "jsonl", "csv")
FIELD_ROLES = ("context", "target")
FIELD_STYLES = ("text", "passage", "list")
GROUP_BY = ("record", "sequential")
POSITIONS = ("random", "first", "last")
STRATEGIES = ("mismatch", "instruction")

DEFAULT_REFERENCE_COLUMN = "llm_label"
DEFAULT_ITEMS_PER_HIT = 10
DEFAULT_ATTENTION_SEED = 42
VALIDATE_RECORDS = 5


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
    var: str
    path: str
    limit: int | None = None


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
class QuestionSpec:
    text: str
    options: list[OptionSpec]
    answer_suffix: str = ""


@dataclass
class HintSpec:
    label_path: str
    reason_path: str | None = None
    map: dict[str, str] | None = None
    missing: str | None = None


@dataclass
class ItemSpec:
    iterate: list[IterateSpec]
    fields: dict[str, FieldSpec]
    question: QuestionSpec
    hint: HintSpec | None = None
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
    strategy: str
    expected_value: str
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


@dataclass
class TaskSpec:
    task: TaskInfo
    source: SourceSpec
    item: ItemSpec
    hit: HitSpec
    instructions: InstructionsSpec
    output: OutputSpec
    spec_version: int = SPEC_VERSION

    @property
    def target_field(self) -> FieldSpec:
        """role이 target인 필드 (check_spec을 통과한 spec에는 정확히 하나 있다)."""
        for spec in self.item.fields.values():
            if spec.role == "target":
                return spec
        raise SpecError("$.item.fields: no field has role \"target\"")

    @property
    def context_fields(self) -> list[FieldSpec]:
        return [spec for spec in self.item.fields.values() if spec.role == "context"]

    @property
    def option_values(self) -> list[str]:
        return [option.value for option in self.item.question.options]


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


def parse_spec(data: dict) -> TaskSpec:
    """dict → TaskSpec. 형식 오류와 정합성 오류를 전부 모아 SpecError로 올린다."""
    if not isinstance(data, dict):
        raise SpecError(["$: spec must be a JSON object"])
    reader = _Reader()
    reader.check_keys(data, "$", ("spec_version", "task", "source", "item", "hit", "instructions", "output"))
    version = reader.get(data, "spec_version", "$", int, SPEC_VERSION)
    if version != SPEC_VERSION:
        reader.error("$.spec_version", f"must be {SPEC_VERSION}")

    task = _parse_task(reader, reader.obj(data, "task", "$", True) or {}, "$.task")
    source = _parse_source(reader, reader.obj(data, "source", "$", False) or {}, "$.source")
    item = _parse_item(reader, reader.obj(data, "item", "$", True) or {}, "$.item")
    hit = _parse_hit(reader, reader.obj(data, "hit", "$", False) or {}, "$.hit")
    instructions = _parse_instructions(reader, reader.obj(data, "instructions", "$", False) or {}, "$.instructions", task)
    output = _parse_output(reader, reader.obj(data, "output", "$", False) or {}, "$.output")

    spec = TaskSpec(task=task, source=source, item=item, hit=hit, instructions=instructions, output=output,
                    spec_version=SPEC_VERSION)
    errors = reader.errors + [message for message in check_spec(spec) if message not in reader.errors]
    if errors:
        raise SpecError(errors)
    return spec


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


def _parse_item(reader: _Reader, data: dict, where: str) -> ItemSpec:
    reader.check_keys(data, where, ("iterate", "fields", "question", "hint", "skip_if_no_targets"))
    iterate: list[IterateSpec] = []
    iterate_data = reader.get(data, "iterate", where, list, [])
    for index, entry in enumerate(iterate_data or []):
        here = f"{where}.iterate[{index}]"
        if not isinstance(entry, dict):
            reader.error(here, "must be an object")
            continue
        reader.check_keys(entry, here, ("var", "path", "limit"))
        iterate.append(IterateSpec(
            var=reader.get(entry, "var", here, str) or "",
            path=reader.get(entry, "path", here, str) or "",
            limit=reader.get(entry, "limit", here, int, None, allow_none=True),
        ))

    fields: dict[str, FieldSpec] = {}
    fields_data = reader.obj(data, "fields", where, True)
    if fields_data is not None:
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

    question_data = reader.obj(data, "question", where, True) or {}
    here = f"{where}.question"
    reader.check_keys(question_data, here, ("text", "options", "answer_suffix"))
    options: list[OptionSpec] = []
    for index, entry in enumerate(reader.get(question_data, "options", here, list) or []):
        option_where = f"{here}.options[{index}]"
        if not isinstance(entry, dict):
            reader.error(option_where, "must be an object")
            continue
        reader.check_keys(entry, option_where, ("value", "label"))
        value = reader.get(entry, "value", option_where, str) or ""
        options.append(OptionSpec(value=value, label=reader.get(entry, "label", option_where, str, value) or value))
    question = QuestionSpec(
        text=reader.get(question_data, "text", here, str) or "",
        options=options,
        answer_suffix=reader.get(question_data, "answer_suffix", here, str, "") or "",
    )

    hint = None
    hint_data = reader.obj(data, "hint", where, False)
    if hint_data is not None:
        here = f"{where}.hint"
        reader.check_keys(hint_data, here, ("label_path", "reason_path", "map", "missing"))
        mapping = None
        map_data = reader.get(hint_data, "map", here, dict, None, allow_none=True)
        if map_data is not None:
            mapping = {}
            for key, value in map_data.items():
                if isinstance(value, str):
                    mapping[key] = value
                else:
                    reader.error(f"{here}.map.{key}", "must be a string (an option value)")
        hint = HintSpec(
            label_path=reader.get(hint_data, "label_path", here, str) or "",
            reason_path=reader.get(hint_data, "reason_path", here, str, None, allow_none=True),
            map=mapping,
            missing=reader.get(hint_data, "missing", here, str, None, allow_none=True),
        )

    skip = reader.get(data, "skip_if_no_targets", where, bool, True)
    return ItemSpec(iterate=iterate, fields=fields, question=question, hint=hint, skip_if_no_targets=skip)


def _parse_hit(reader: _Reader, data: dict, where: str) -> HitSpec:
    reader.check_keys(data, where, ("items_per_hit", "group_by", "attention"))
    attention = None
    attention_data = reader.obj(data, "attention", where, False)
    if attention_data is not None:
        here = f"{where}.attention"
        reader.check_keys(attention_data, here, ("per_hit", "position", "seed", "strategy", "expected_value",
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
        attention = AttentionSpec(
            strategy=reader.choice(attention_data, "strategy", here, STRATEGIES),
            expected_value=reader.get(attention_data, "expected_value", here, str) or "",
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


def _parse_output(reader: _Reader, data: dict, where: str) -> OutputSpec:
    reader.check_keys(data, where, ("reference_column", "reason_column"))
    return OutputSpec(
        reference_column=reader.get(data, "reference_column", where, str, DEFAULT_REFERENCE_COLUMN) or DEFAULT_REFERENCE_COLUMN,
        reason_column=reader.get(data, "reason_column", where, str, None, allow_none=True),
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
    """TaskSpec → JSON으로 저장할 수 있는 dict. parse_spec(spec_to_dict(spec))는 같은 spec이 된다."""
    source = spec.source
    filter_data = None
    if source.filter is not None:
        filter_data = {"path": source.filter.path, source.filter.mode: source.filter.value}
    item = spec.item
    hint = None
    if item.hint is not None:
        hint = {"label_path": item.hint.label_path, "reason_path": item.hint.reason_path,
                "map": dict(item.hint.map) if item.hint.map is not None else None, "missing": item.hint.missing}
    attention = None
    if spec.hit.attention is not None:
        a = spec.hit.attention
        attention = {
            "per_hit": a.per_hit, "position": a.position, "seed": a.seed, "strategy": a.strategy,
            "expected_value": a.expected_value, "max_targets": a.max_targets,
            "mismatch": {"swap_fields": list(a.mismatch.swap_fields), "distance": a.mismatch.distance} if a.mismatch else None,
            "instruction": {"text": a.instruction.text} if a.instruction else None,
        }
    ins = spec.instructions
    return {
        "spec_version": spec.spec_version,
        "task": {"id": spec.task.id, "title": spec.task.title, "description": spec.task.description,
                 "keywords": list(spec.task.keywords)},
        "source": {
            "format": source.format, "record_id": source.record_id, "filter": filter_data,
            "sample": {"n": source.sample.n, "seed": source.sample.seed} if source.sample else None,
            "limit": source.limit,
        },
        "item": {
            "iterate": [{"var": it.var, "path": it.path, "limit": it.limit} for it in item.iterate],
            "fields": {name: {"path": f.path, "label": f.label, "role": f.role, "style": f.style}
                       for name, f in item.fields.items()},
            "question": {"text": item.question.text,
                         "options": [{"value": o.value, "label": o.label} for o in item.question.options],
                         "answer_suffix": item.question.answer_suffix},
            "hint": hint,
            "skip_if_no_targets": item.skip_if_no_targets,
        },
        "hit": {"items_per_hit": spec.hit.items_per_hit, "group_by": spec.hit.group_by, "attention": attention},
        "instructions": {
            "summary": ins.summary, "background": ins.background,
            "criteria": [{"label": c.label, "text": c.text} for c in ins.criteria],
            "steps": list(ins.steps), "notes": list(ins.notes), "tip": ins.tip,
            "notices": {"attention": ins.notices.attention, "research": ins.notices.research},
        },
        "output": {"reference_column": spec.output.reference_column, "reason_column": spec.output.reason_column},
    }


# ----------------------------------------------------------------------------------------------
# 정합성 검사 (데이터 없이)
# ----------------------------------------------------------------------------------------------


def check_spec(spec: TaskSpec) -> list[str]:
    """데이터 없이 할 수 있는 검사: 이름 규칙, 경로 문법, 변수 참조, 옵션 값, attention 설정."""
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
        if NAME_RE.match(it.var or "") and it.var not in RESERVED_VARIABLES and it.var not in iterate_vars:
            iterate_vars.append(it.var)
    item_vars = record_vars + tuple(_expand_vars(iterate_vars))
    target_vars = item_vars + ("target", "target_index", "target_no", "target_key")

    output_columns = [spec.output.reference_column]
    if spec.output.reason_column is not None:
        output_columns.append(spec.output.reason_column)
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
    if item.fields and len(targets) != 1:
        add(f"$.item.fields: exactly one field must have role \"target\" (found {len(targets)}: {', '.join(targets) or 'none'})")

    question = item.question
    if not question.text.strip():
        add("$.item.question.text: must not be empty")
    values = []
    for index, option in enumerate(question.options):
        where = f"$.item.question.options[{index}]"
        if not OPTION_VALUE_RE.match(option.value or ""):
            add(f"{where}.value: must match ^[A-Za-z0-9_ .-]+$")
        elif option.value in values:
            add(f"{where}.value: duplicate option value {option.value!r}")
        if not option.label.strip():
            add(f"{where}.label: must not be empty")
        values.append(option.value)
    if len(question.options) < 2:
        add("$.item.question.options: at least 2 options are required")
    if not SUFFIX_RE.match(question.answer_suffix or ""):
        add("$.item.question.answer_suffix: must match ^[A-Za-z0-9_]*$")

    hint = item.hint
    if hint is not None:
        _check_path(hint.label_path, "$.item.hint.label_path", target_vars, errors)
        if hint.reason_path is not None:
            _check_path(hint.reason_path, "$.item.hint.reason_path", target_vars, errors)
        if hint.map is not None:
            for key, value in hint.map.items():
                if value not in values:
                    add(f"$.item.hint.map.{key}: {value!r} is not an option value ({', '.join(values)})")
        if hint.missing is not None and hint.missing not in values:
            add(f"$.item.hint.missing: {hint.missing!r} is not an option value ({', '.join(values)})")

    hit = spec.hit
    if hit.items_per_hit < 1:
        add("$.hit.items_per_hit: must be at least 1")
    if hit.group_by not in GROUP_BY:
        add(f"$.hit.group_by: must be one of {', '.join(repr(g) for g in GROUP_BY)}")
    attention = hit.attention
    if attention is not None:
        where = "$.hit.attention"
        if attention.per_hit < 0:
            add(f"{where}.per_hit: must be 0 or more")
        if attention.position not in POSITIONS:
            add(f"{where}.position: must be one of {', '.join(repr(p) for p in POSITIONS)}")
        if attention.strategy not in STRATEGIES:
            add(f"{where}.strategy: must be one of {', '.join(repr(s) for s in STRATEGIES)}")
        if attention.expected_value not in values:
            add(f"{where}.expected_value: {attention.expected_value!r} is not an option value ({', '.join(values)})")
        if attention.max_targets is not None and attention.max_targets < 1:
            add(f"{where}.max_targets: must be null or at least 1")
        context_names = [name for name, f in item.fields.items() if f.role == "context"]
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
            if attention.instruction is None:
                add(f"{where}.instruction: required when strategy is \"instruction\"")
            elif not attention.instruction.text.strip():
                add(f"{where}.instruction.text: must not be empty")

    output = spec.output
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
    return errors


def _expand_vars(names: list[str]) -> list[str]:
    out = []
    for name in names:
        out.extend((name, f"{name}_index", f"{name}_no", f"{name}_key"))
    return out


def _check_path(path: str, where: str, allowed_vars: tuple[str, ...], errors: list[str]) -> None:
    if not isinstance(path, str) or not path:
        errors.append(f"{where}: path is required")
        return
    try:
        paths.check_syntax(path)
    except PathError as error:
        errors.append(f"{where}: invalid path: {error}")
        return
    for name in paths.variable_names(path):
        if name not in allowed_vars:
            errors.append(f"{where}: unknown variable {{{name}}} (available: {', '.join(allowed_vars) or 'none'})")


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


def map_hint(hint: HintSpec, raw: Any) -> str | None:
    """원시 라벨 값을 option value로 바꾼다. 없거나 map에 없으면 hint.missing."""
    if raw is MISSING or raw is None:
        return hint.missing
    text = str(raw).strip()
    if hint.map is None:
        return text
    return hint.map.get(text, hint.missing)


# ----------------------------------------------------------------------------------------------
# 실측 검증
# ----------------------------------------------------------------------------------------------


def validate_against_records(spec: TaskSpec, records: list[Any], max_records: int = VALIDATE_RECORDS) -> list[str]:
    """첫 레코드 몇 개(필터 통과분)로 경로가 풀리는지 검사한다. 오류 문자열 목록. 비어 있으면 통과."""
    errors = check_spec(spec)
    if errors:
        return errors
    if not records:
        return ["no records to validate against"]

    checked: list[tuple[int, Any]] = []
    for index, record in enumerate(records):
        if spec.source.filter is not None:
            try:
                if not filter_matches(spec.source.filter, record):
                    continue
            except PathError as error:
                return [f"$.source.filter.path: {error}"]
        checked.append((index, record))
        if len(checked) >= max_records:
            break
    if not checked:
        return ["$.source.filter: no record matches the filter"]

    seen: set[str] = set()

    def add(message: str) -> None:
        # 같은 문제를 레코드마다 되풀이하지 않는다: " in record …" 앞부분이 같으면 한 번만 적는다
        key = message.split(" in record ")[0]
        if key not in seen:
            seen.add(key)
            errors.append(message)

    target_field = spec.target_field
    hint = spec.item.hint
    items_total = 0
    items_with_targets = 0
    targets_total = 0
    labels_resolved = 0
    labels_mapped = 0
    reasons_resolved = 0
    target_errors = 0
    unmapped: list[str] = []

    for index, record in checked:
        if spec.source.record_id:
            value = paths.evaluate(spec.source.record_id, record)
            if value is MISSING:
                add(f"$.source.record_id: {spec.source.record_id!r} does not resolve in record #{index + 1}")
            elif not isinstance(value, (str, int)) or isinstance(value, bool):
                add(f"$.source.record_id: {spec.source.record_id!r} resolves to {type(value).__name__} in record #{index + 1}, expected a string")
        record_id = record_id_of(spec, record, index)
        base = record_variables(index, record_id)
        try:
            items = list(iter_item_variables(spec, record, base))
        except SpecError as error:
            for message in error.messages:
                add(message)
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
                    add(f"{where}: {f.path!r} does not resolve in record {record_id!r}")
                elif coerce_text(value) is None:
                    add(f"{where}: {f.path!r} resolves to {type(value).__name__} in record {record_id!r}, expected text or a list of texts")
            try:
                targets, keys = resolve_targets(target_field, record, variables)
            except SpecError as error:
                target_errors += 1
                for message in error.messages:
                    add(message)
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
            if hint is None:
                continue
            for position, (target, key) in enumerate(zip(targets, keys)):
                targets_total += 1
                tvars = target_variables(variables, target, position, key)
                try:
                    raw = paths.evaluate(hint.label_path, record, tvars)
                except PathError as error:
                    add(f"$.item.hint.label_path: {error}")
                    break
                if raw is not MISSING and raw is not None:
                    labels_resolved += 1
                    text = str(raw).strip()
                    known = text in hint.map if hint.map is not None else text in spec.option_values
                    if known:
                        labels_mapped += 1
                    elif text not in unmapped:
                        unmapped.append(text)
                if hint.reason_path is not None:
                    try:
                        reason = paths.evaluate(hint.reason_path, record, tvars)
                    except PathError as error:
                        add(f"$.item.hint.reason_path: {error}")
                        break
                    if reason is not MISSING and reason is not None:
                        reasons_resolved += 1

    count = len(checked)
    if items_total == 0:
        add(f"$.item.iterate: the first {count} record(s) produce no items")
    elif items_with_targets == 0 and target_errors == 0:
        add(f"$.item.fields.{target_field.name}.path: no item has targets in the first {count} record(s)")
    if hint is not None and targets_total > 0:
        if labels_resolved == 0:
            add(f"$.item.hint.label_path: {hint.label_path!r} never resolves for the targets of the first {count} record(s)")
        elif labels_mapped == 0:
            add(f"$.item.hint.map: no observed label maps to an option value (observed: {', '.join(repr(v) for v in unmapped[:8])})")
        if hint.reason_path is not None and reasons_resolved == 0:
            add(f"$.item.hint.reason_path: {hint.reason_path!r} never resolves for the targets of the first {count} record(s)")
    attention = spec.hit.attention
    if attention is not None and attention.strategy == "mismatch" and attention.per_hit > 0 and len(records) < 2:
        add("$.hit.attention.mismatch: needs at least 2 records to take fields from another record")
    return errors
