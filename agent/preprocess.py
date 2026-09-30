"""spec을 원본 레코드에 적용해 HIT 단위 CSV를 만든다.

    build_items(spec, records)     레코드 → 항목(Item) 목록. 필터·샘플·limit을 적용하고 iterate를 돌며 필드, target,
                                   문항마다의 답 칸(Answer: 대조 기준과 이유)을 푼다. 경로가 풀리지 않거나 형이 맞지 않는
                                   레코드는 건너뛰고 통계의 skipped_records에 적는다 (쓰는 레코드의 절반을 넘으면 SpecError)
    group_hits(spec, items)        항목들을 HIT로 자르고 attention 항목을 끼워 넣는다
    answer_name(...)               답 이름 규칙 ("general_{i}_{j}{suffix}" / 항목 문항은 "general_{i}{suffix}")
    hit_rows(spec, hits)           HIT → CSV 컬럼 목록과 행(모든 셀은 json_cell로 만든 JSON 문자열)
    json_cell(value)               <script> 안에 그대로 넣어도 안전한 JSON
    build_settings(spec)           콘솔 Create의 Settings 값 (settings.json)
    run_preprocess(spec, raw_path, out_dir)
                                   items.jsonl, hits.csv, summary.json, settings.json을 저장하고 summary를 돌려준다

경로를 푸는 규칙(record_id, 변수, 필드, target, hint)은 spec.py의 도우미를 그대로 써서 validate_against_records와
같은 결과가 나오게 한다. 같은 입력과 spec이면 출력은 항상 같다 (샘플과 attention 위치는 seed로 정한다).

답 이름은 attention 항목도 "general_"로 시작한다 (worker 화면과 페이지 소스에서 attention 탭을 가려낼 수 없어야 한다).
attention 항목의 기대 값은 reference 컬럼이 아니라 attention 컬럼(output.attention_column)에 {답 이름: 기대 값}으로 쓴다.
탭 안의 답 순서는 spec.answer_slots(화면 순서)다.

record_index는 필터·샘플·limit을 거친 뒤 실제로 쓰는 레코드 목록 안의 위치다 (0부터). attention의 mismatch가
(record_index + distance) mod N으로 다른 레코드를 고를 때 N은 이 목록의 길이다.
"""

from __future__ import annotations

import csv
import io
import json
import random
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from agent import paths, source
from agent.paths import MISSING, PathError
from agent.spec import (
    SpecError,
    TaskSpec,
    answer_slots,
    field_value,
    filter_matches,
    hint_label,
    hint_reason,
    iter_item_variables,
    map_hint,
    record_id_of,
    record_variables,
    resolve_targets,
    target_variables,
)

ATTENTION_ID = "attention"
GENERAL_PREFIX = "general_"
ROW_BYTES_LIMIT = 64 * 1024
SKIPPED_EXAMPLES = 10

ITEMS_FILE = "items.jsonl"
HITS_FILE = "hits.csv"
SUMMARY_FILE = "summary.json"
SETTINGS_FILE = "settings.json"


@dataclass
class Answer:
    """탭 안의 답 칸 하나: 문항 × target (item 문항이면 target_no가 None).

    reference·reason은 일반 항목의 대조 기준과 이유, expected는 attention 항목의 기대 값이다 (없으면 None)."""

    question: str
    target_no: int | None = None
    reference: str | None = None
    reason: str | None = None
    expected: str | None = None


@dataclass
class Item:
    """탭 하나. fields는 필드 이름 → 값(context는 str 또는 list[str], target은 list[str]).

    answers는 spec.answer_slots 순서(화면 순서)의 답 칸들이다."""

    record_index: int
    record_id: str
    item_id: str
    is_attention: bool
    fields: dict[str, Any] = field(default_factory=dict)
    targets: list[str] = field(default_factory=list)
    answers: list[Answer] = field(default_factory=list)


# ----------------------------------------------------------------------------------------------
# 레코드 → 항목
# ----------------------------------------------------------------------------------------------


def select_records(spec: TaskSpec, records: list[Any]) -> tuple[list[tuple[int, Any]], dict]:
    """필터 → 샘플 → limit. (원래 index, 레코드) 목록과 개수 통계를 돌려준다. 샘플은 원래 순서를 지킨다."""
    total = len(records)
    selected: list[tuple[int, Any]] = []
    for index, record in enumerate(records):
        if spec.source.filter is not None:
            try:
                if not filter_matches(spec.source.filter, record):
                    continue
            except PathError as error:
                raise SpecError([f"$.source.filter.path: {error}"]) from None
        selected.append((index, record))
    filtered = len(selected)
    sampled = filtered
    if spec.source.sample is not None:
        n = min(spec.source.sample.n, len(selected))
        chosen = random.Random(spec.source.sample.seed).sample(range(len(selected)), n)
        selected = [selected[position] for position in sorted(chosen)]
        sampled = len(selected)
    if spec.source.limit is not None:
        selected = selected[: spec.source.limit]
    stats = {"total": total, "filtered": filtered, "sampled": sampled, "used": len(selected)}
    return selected, stats


def build_items(spec: TaskSpec, records: list[Any]) -> tuple[list[Item], dict]:
    """레코드들을 항목으로 푼다. (항목 목록, 통계) — 통계는 records(total/filtered/sampled/used), items, skipped_no_targets,
    skipped_records({"count", "examples": [{"record_id", "reason"}, … 최대 SKIPPED_EXAMPLES개]}).

    iterate·필드·target·hint가 풀리지 않거나 형이 맞지 않는 레코드는 통째로 건너뛴다 (validate_against_records는 첫 몇
    레코드만 보므로 뒤쪽의 이상한 레코드 하나가 전체를 막지 않게 한다). 건너뛴 레코드가 쓰는 레코드의 절반을 넘으면 spec이
    데이터와 맞지 않는 것으로 보고 SpecError를 낸다. skip_if_no_targets가 false인데 target이 비면 그대로 SpecError다."""
    selected, record_stats = select_records(spec, records)
    items: list[Item] = []
    skipped = 0
    skipped_records: list[dict] = []

    for record_index, (_, record) in enumerate(selected):
        record_id = record_id_of(spec, record, record_index)
        try:
            record_items, record_skipped = _record_items(spec, record, record_index, record_id)
        except _NoTargets as error:
            raise SpecError(error.messages) from None
        except SpecError as error:
            skipped_records.append({"record_id": record_id, "reason": error.messages[0]})
            continue
        except PathError as error:
            skipped_records.append({"record_id": record_id, "reason": f"$.item: {error}"})
            continue
        items.extend(record_items)
        skipped += record_skipped

    used = record_stats["used"]
    if skipped_records and len(skipped_records) * 2 > used:
        examples = "; ".join(f"record {entry['record_id']!r}: {entry['reason']}" for entry in skipped_records[:3])
        raise SpecError([f"$.item: {len(skipped_records)} of {used} records could not be used, so the spec does not fit the "
                         f"data (e.g. {examples})"])
    stats = {"records": record_stats, "items": len(items), "skipped_no_targets": skipped,
             "skipped_records": {"count": len(skipped_records), "examples": skipped_records[:SKIPPED_EXAMPLES]}}
    return items, stats


class _NoTargets(SpecError):
    """skip_if_no_targets가 false인데 target이 빈 경우. 레코드를 건너뛰지 않고 그대로 오류로 올린다."""


def _record_items(spec: TaskSpec, record: Any, record_index: int, record_id: str) -> tuple[list[Item], int]:
    """레코드 하나의 항목들과 target이 비어 건너뛴 항목 수. 풀리지 않으면 SpecError/PathError."""
    target_field = spec.target_field
    base = record_variables(record_index, record_id)
    items: list[Item] = []
    skipped = 0
    for variables in iter_item_variables(spec, record, base):
        targets: list[str] = []
        keys: list[str | int] = []
        if target_field is not None:
            targets, keys = resolve_targets(target_field, record, variables)
            if not targets:
                if spec.item.skip_if_no_targets:
                    skipped += 1
                    continue
                raise _NoTargets([f"$.item.fields.{target_field.name}.path: no targets in record {record_id!r} "
                                  "and skip_if_no_targets is false"])
        fields: dict[str, Any] = {}
        for f in spec.item.fields.values():
            if f.role == "target":
                fields[f.name] = list(targets)
                continue
            value = field_value(f, record, variables)
            if value is None:
                raw = paths.evaluate(f.path, record, variables)
                what = "does not resolve" if raw is MISSING else f"resolves to {type(raw).__name__}"
                raise SpecError([f"$.item.fields.{f.name}.path: {f.path!r} {what} in record {record_id!r}"])
            fields[f.name] = value
        answers: list[Answer] = []
        for question, target_no in answer_slots(spec, len(targets)):
            answer = Answer(question=question.id, target_no=target_no)
            hint = question.hint
            if hint is not None and question.type != "text":
                scope_vars = variables
                if target_no is not None:
                    scope_vars = target_variables(variables, targets[target_no - 1], target_no - 1, keys[target_no - 1])
                answer.reference = map_hint(hint, hint_label(hint, record, scope_vars))
                answer.reason = hint_reason(hint, record, scope_vars)
            answers.append(answer)
        items.append(Item(
            record_index=record_index,
            record_id=record_id,
            item_id=_item_id(spec, record_id, variables),
            is_attention=False,
            fields=fields,
            targets=list(targets),
            answers=answers,
        ))
    return items, skipped


def _item_id(spec: TaskSpec, record_id: str, variables: dict[str, Any]) -> str:
    parts = [record_id]
    for it in spec.item.iterate:
        parts.append(f"#{it.var}={variables[f'{it.var}_key']}")
    return "".join(parts)


# ----------------------------------------------------------------------------------------------
# 항목 → HIT (attention 삽입)
# ----------------------------------------------------------------------------------------------


def group_hits(spec: TaskSpec, items: list[Item]) -> list[list[Item]]:
    """항목들을 HIT로 자른다. group_by가 record면 레코드마다, sequential이면 전체를 순서대로 items_per_hit씩.

    attention이 설정돼 있으면 HIT마다 per_hit개를 만들어 position에 따라 끼워 넣는다."""
    size = spec.hit.items_per_hit
    hits: list[list[Item]] = []
    if spec.hit.group_by == "record":
        by_record: dict[int, list[Item]] = {}
        for item in items:
            by_record.setdefault(item.record_index, []).append(item)
        for record_items in by_record.values():
            hits.extend(record_items[start:start + size] for start in range(0, len(record_items), size))
    else:
        hits.extend(items[start:start + size] for start in range(0, len(items), size))

    attention = spec.hit.attention
    if attention is None or attention.per_hit < 1:
        return hits
    positions = _record_positions(items)
    for hit_index, hit in enumerate(hits):
        base = hit[0]
        extras = [_attention_item(spec, base, positions, k) for k in range(attention.per_hit)]
        rng = random.Random(attention.seed + hit_index)
        for k, extra in enumerate(extras):
            if attention.position == "first":
                hit.insert(k, extra)
            elif attention.position == "last":
                hit.append(extra)
            else:
                hit.insert(rng.randint(0, len(hit)), extra)
    return hits


def _record_positions(items: list[Item]) -> dict[int, list[Item]]:
    """record_index → 그 레코드의 (attention이 아닌) 항목들, iterate 순서."""
    by_record: dict[int, list[Item]] = {}
    for item in items:
        if not item.is_attention:
            by_record.setdefault(item.record_index, []).append(item)
    return by_record


def _attention_item(spec: TaskSpec, base: Item, by_record: dict[int, list[Item]], k: int) -> Item:
    """HIT의 첫 항목(base)을 복사해 attention 항목을 만든다. k는 HIT 안에서 몇 번째 attention인지 (0부터).

    답 칸은 일반 항목과 같은 규칙으로 만들고, spec이 기대 값을 준 문항의 칸에만 expected를 넣는다."""
    attention = spec.hit.attention
    assert attention is not None
    target_field = spec.target_field
    fields = dict(base.fields)
    if attention.strategy == "instruction":
        assert attention.instruction is not None
        targets = [attention.instruction.text]
    else:
        assert attention.mismatch is not None
        other = _other_item(base, by_record, attention.mismatch.distance * (k + 1))
        for name in attention.mismatch.swap_fields:
            fields[name] = other.fields[name]
        targets = list(base.targets)
        if attention.max_targets is not None:
            targets = targets[: attention.max_targets]
    if target_field is not None:
        fields[target_field.name] = list(targets)
    answers = [Answer(question=question.id, target_no=target_no, expected=attention.expected.get(question.id))
               for question, target_no in answer_slots(spec, len(targets))]
    return Item(
        record_index=base.record_index,
        record_id=ATTENTION_ID,
        item_id=ATTENTION_ID,
        is_attention=True,
        fields=fields,
        targets=targets,
        answers=answers,
    )


def _other_item(base: Item, by_record: dict[int, list[Item]], distance: int) -> Item:
    """base와 같은 iterate 위치의 항목을 다른 레코드에서 고른다.

    레코드는 (record_index + distance) mod N (같은 레코드면 +1). 그 레코드에 항목이 없으면 항목이 있는 다음 레코드,
    그 위치가 없으면 그 레코드의 첫 항목."""
    if len(by_record) < 2:
        raise SpecError(["$.hit.attention.mismatch: needs at least 2 records with items to take fields from another record"])
    n = max(by_record) + 1  # 쓰는 레코드 수 (항목이 없는 레코드도 index를 차지한다)
    own = by_record[base.record_index]
    position = next((i for i, item in enumerate(own) if item is base), 0)
    other = (base.record_index + distance) % n
    if other == base.record_index:
        other = (other + 1) % n
    while other not in by_record:
        other = (other + 1) % n
    candidates = by_record[other]
    return candidates[position] if position < len(candidates) else candidates[0]


# ----------------------------------------------------------------------------------------------
# HIT → CSV 행
# ----------------------------------------------------------------------------------------------


def answer_name(item_index: int, target_no: int | None, suffix: str) -> str:
    """답 이름. item_index는 HIT 안의 항목 index(0부터, attention 포함), target_no는 1부터 (item 문항이면 None).

    suffix는 문항의 접미어(v2는 "_" + 문항 id, v1은 옛 answer_suffix)다."""
    if target_no is None:
        return f"{GENERAL_PREFIX}{item_index}{suffix}"
    return f"{GENERAL_PREFIX}{item_index}_{target_no}{suffix}"


def answer_names(spec: TaskSpec, hit: list[Item]) -> list[list[str]]:
    """HIT의 항목마다 답 칸 순서대로 답 이름 목록."""
    suffixes = {q.id: q.suffix for q in spec.item.questions}
    return [[answer_name(i, answer.target_no, suffixes[answer.question]) for answer in item.answers]
            for i, item in enumerate(hit)]


def hit_id(hit_index: int) -> str:
    return f"hit-{hit_index + 1:04d}"


def has_attention_column(spec: TaskSpec) -> bool:
    """attention 컬럼은 attention이 있고 per_hit가 1 이상일 때만 만든다."""
    attention = spec.hit.attention
    return attention is not None and attention.per_hit >= 1


def csv_columns(spec: TaskSpec) -> list[str]:
    """hits.csv의 컬럼 순서: hit_id, record_ids, item_ids, attention, 필드들(spec 순서), reference, [reason], [attention 기대 값]."""
    columns = ["hit_id", "record_ids", "item_ids", "attention", *spec.item.fields]
    columns.append(spec.output.reference_column)
    if spec.output.reason_column is not None:
        columns.append(spec.output.reason_column)
    if has_attention_column(spec):
        columns.append(spec.output.attention_column)
    return columns


def json_cell(value: Any) -> str:
    """CSV 셀용 JSON. `<`는 \\u003c로, U+2028/U+2029는 \\u2028/\\u2029로 써서 <script> 안에 그대로 넣어도 안전하다."""
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return text.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def hit_rows(spec: TaskSpec, hits: list[list[Item]]) -> tuple[list[str], list[dict[str, str]]]:
    """HIT들을 CSV 행으로 만든다. 모든 셀은 json_cell을 거친 문자열이다.

    reference·reason 컬럼에는 일반 항목의 답만, attention 컬럼에는 attention 항목의 기대 값만 들어간다."""
    columns = csv_columns(spec)
    rows: list[dict[str, str]] = []
    for hit_index, hit in enumerate(hits):
        names = answer_names(spec, hit)
        reference: dict[str, str] = {}
        reasons: dict[str, str] = {}
        expected: dict[str, str] = {}
        for item, item_names in zip(hit, names):
            for name, answer in zip(item_names, item.answers):
                if item.is_attention:
                    if answer.expected is not None:
                        expected[name] = answer.expected
                    continue
                if answer.reference is not None:
                    reference[name] = answer.reference
                if answer.reason is not None:
                    reasons[name] = answer.reason
        values: dict[str, Any] = {
            "hit_id": hit_id(hit_index),
            "record_ids": [item.record_id for item in hit],
            "item_ids": [item.item_id for item in hit],
            "attention": [1 if item.is_attention else 0 for item in hit],
        }
        for name in spec.item.fields:
            values[name] = [item.fields[name] for item in hit]
        values[spec.output.reference_column] = reference
        if spec.output.reason_column is not None:
            values[spec.output.reason_column] = reasons
        if has_attention_column(spec):
            values[spec.output.attention_column] = expected
        rows.append({column: json_cell(values[column]) for column in columns})
    return columns, rows


def row_bytes(columns: list[str], row: dict[str, str]) -> int:
    """CSV 한 줄의 UTF-8 바이트 수 (MTurk의 64KB 제한과 비교한다)."""
    buffer = io.StringIO()
    csv.writer(buffer, lineterminator="\n").writerow([row.get(column, "") for column in columns])
    return len(buffer.getvalue().encode("utf-8"))


def write_csv(path: Path, columns: list[str], rows: list[dict[str, str]]) -> None:
    with Path(path).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(columns)
        for row in rows:
            writer.writerow([row.get(column, "") for column in columns])


# ----------------------------------------------------------------------------------------------
# 요약과 설정
# ----------------------------------------------------------------------------------------------


def bytes_summary(sizes: list[int]) -> dict:
    if not sizes:
        return {"min": 0, "median": 0, "max": 0}
    ordered = sorted(sizes)
    middle = len(ordered) // 2
    median = ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) // 2
    return {"min": ordered[0], "median": median, "max": ordered[-1]}


def build_summary(spec: TaskSpec, item_stats: dict, hits: list[list[Item]], columns: list[str],
                  rows: list[dict[str, str]], source_format: str | None) -> dict:
    """summary.json. targets·answers는 attention 항목을 포함하고, reference_values·hints_missing은 일반 항목의
    (text가 아닌) 답만 센다. questions에 문항별 답 수와 대조 기준 분포가 있다."""
    text_ids = {q.id for q in spec.item.questions if q.type == "text"}
    per_question = {q.id: {"id": q.id, "type": q.type, "scope": q.scope, "answers": 0, "references": 0,
                           "reference_values": Counter()} for q in spec.item.questions}
    reference_values: Counter[str] = Counter()
    hints_missing = 0
    targets = 0
    answers = 0
    attention_items = 0
    attention_answers = 0
    for hit in hits:
        for item in hit:
            targets += len(item.targets)
            answers += len(item.answers)
            if item.is_attention:
                attention_items += 1
                attention_answers += sum(1 for answer in item.answers if answer.expected is not None)
                continue
            for answer in item.answers:
                entry = per_question[answer.question]
                entry["answers"] += 1
                if answer.question in text_ids:
                    continue
                if answer.reference is None:
                    hints_missing += 1
                else:
                    reference_values[answer.reference] += 1
                    entry["references"] += 1
                    entry["reference_values"][answer.reference] += 1
    sizes = [row_bytes(columns, row) for row in rows]
    questions = []
    for entry in per_question.values():
        questions.append({**entry, "reference_values": dict(sorted(entry["reference_values"].items()))})
    return {
        "task_id": spec.task.id,
        "source_format": source_format,
        "records": item_stats["records"],
        "items": item_stats["items"],
        "skipped_no_targets": item_stats["skipped_no_targets"],
        "skipped_records": item_stats.get("skipped_records", {"count": 0, "examples": []}),
        "hits": len(hits),
        "items_per_hit": spec.hit.items_per_hit,
        "attention_items": attention_items,
        "targets": targets,
        "answers": answers,
        "attention_answers": attention_answers,
        "reference_values": dict(sorted(reference_values.items())),
        "hints_missing": hints_missing,
        "questions": questions,
        "columns": columns,
        "row_bytes": bytes_summary(sizes),
        "rows_over_64kb": sum(1 for size in sizes if size > ROW_BYTES_LIMIT),
    }


def answer_patterns(spec: TaskSpec) -> dict[str, str]:
    """답 이름 규칙. v2는 {qid}가 문항 id, v1은 target 규칙에 옛 접미어를 그대로 넣는다."""
    if spec.legacy:
        suffix = spec.item.questions[0].suffix if spec.item.questions else ""
        return {"target": f"{GENERAL_PREFIX}{{i}}_{{j}}{suffix}", "item": f"{GENERAL_PREFIX}{{i}}_{{qid}}"}
    return {"target": f"{GENERAL_PREFIX}{{i}}_{{j}}_{{qid}}", "item": f"{GENERAL_PREFIX}{{i}}_{{qid}}"}


def build_settings(spec: TaskSpec) -> dict:
    """콘솔 Create의 Settings에 넣을 값. Keywords는 콘솔과 MTurk가 쓰는 쉼표 구분 문자열이다.

    attentionRule은 attention 컬럼 방식({"column", "minCorrectRatio"})이고 attention이 없으면 null이다."""
    attention = spec.hit.attention
    rule = None
    if has_attention_column(spec):
        rule = {"column": spec.output.attention_column, "minCorrectRatio": 1}
    return {
        "Title": spec.task.title,
        "Description": spec.task.description,
        "Keywords": ", ".join(spec.task.keywords),
        "attentionRule": rule,
        "reference": {"source": "column", "column": spec.output.reference_column},
        "referenceColumn": spec.output.reference_column,
        "reasonColumn": spec.output.reason_column,
        "freeTextSuffixes": spec.free_text_suffixes,
        "questions": [{"id": q.id, "type": q.type, "scope": q.scope, "values": q.values} for q in spec.item.questions],
        "answerNames": answer_patterns(spec),
        "itemsPerHit": spec.hit.items_per_hit,
        "attentionPerHit": attention.per_hit if attention is not None else 0,
        "optionValues": spec.option_values,
    }


def item_records(spec: TaskSpec, hits: list[list[Item]]) -> list[dict]:
    """items.jsonl의 줄들: 항목의 필드·target과 답 칸들(이름, 문항, target 번호, 대조 기준, 이유, 기대 값)."""
    out = []
    for hit_index, hit in enumerate(hits):
        names = answer_names(spec, hit)
        for item_index, item in enumerate(hit):
            out.append({
                "hit_id": hit_id(hit_index),
                "item_index": item_index,
                "record_index": item.record_index,
                "record_id": item.record_id,
                "item_id": item.item_id,
                "is_attention": item.is_attention,
                "fields": item.fields,
                "targets": item.targets,
                "answer_names": names[item_index],
                "answers": [{"name": name, "question": answer.question, "target_no": answer.target_no,
                             "reference": answer.reference, "reason": answer.reason, "expected": answer.expected}
                            for name, answer in zip(names[item_index], item.answers)],
            })
    return out


def run_preprocess(spec: TaskSpec, raw_path: Path, out_dir: Path) -> dict:
    """원본을 읽어 items.jsonl, hits.csv, summary.json, settings.json을 out_dir에 저장하고 summary를 돌려준다."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    source_format, records = source.load_records(Path(raw_path), spec.source.format)
    items, item_stats = build_items(spec, records)
    if not items:
        raise SpecError(["$.item: no items were produced from the records"])
    hits = group_hits(spec, items)
    columns, rows = hit_rows(spec, hits)

    write_csv(out_dir / HITS_FILE, columns, rows)
    with (out_dir / ITEMS_FILE).open("w", encoding="utf-8") as handle:
        for data in item_records(spec, hits):
            handle.write(json.dumps(data, ensure_ascii=False) + "\n")
    summary = build_summary(spec, item_stats, hits, columns, rows, source_format)
    with (out_dir / SUMMARY_FILE).open("w", encoding="utf-8") as handle:
        json.dump(summary, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    with (out_dir / SETTINGS_FILE).open("w", encoding="utf-8") as handle:
        json.dump(build_settings(spec), handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return summary


__all__ = [
    "Answer", "Item", "build_items", "group_hits", "answer_name", "answer_names", "hit_rows", "json_cell",
    "run_preprocess", "select_records", "csv_columns", "has_attention_column", "row_bytes", "build_settings",
    "build_summary", "hit_id", "answer_patterns",
]
