"""spec을 원본 레코드에 적용해 HIT 단위 CSV를 만든다.

    build_items(spec, records)     레코드 → 항목(Item) 목록. 필터·샘플·limit을 적용하고 iterate를 돌며 필드와 hint를 푼다
    group_hits(spec, items)        항목들을 HIT로 자르고 attention 항목을 끼워 넣는다
    answer_name(...)               답 이름 규칙 ("general_{i}_{j}{suffix}" / "attention_{i}_{j}{suffix}")
    hit_rows(spec, hits)           HIT → CSV 컬럼 목록과 행(모든 셀은 json_cell로 만든 JSON 문자열)
    json_cell(value)               <script> 안에 그대로 넣어도 안전한 JSON
    run_preprocess(spec, raw_path, out_dir)
                                   items.jsonl, hits.csv, summary.json, settings.json을 저장하고 summary를 돌려준다

경로를 푸는 규칙(record_id, 변수, 필드, target, hint)은 spec.py의 도우미를 그대로 써서 validate_against_records와
같은 결과가 나오게 한다. 같은 입력과 spec이면 출력은 항상 같다 (샘플과 attention 위치는 seed로 정한다).

record_index는 필터·샘플·limit을 거친 뒤 실제로 쓰는 레코드 목록 안의 위치다 (0부터). attention의 mismatch가
(record_index + distance) mod N으로 다른 레코드를 고를 때 N은 이 목록의 길이다.
"""

from __future__ import annotations

import csv
import io
import json
import random
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from agent import paths, source
from agent.paths import MISSING, PathError
from agent.spec import (
    SpecError,
    TaskSpec,
    field_value,
    filter_matches,
    iter_item_variables,
    map_hint,
    record_id_of,
    record_variables,
    resolve_targets,
    target_variables,
)

ATTENTION_ID = "attention"
ATTENTION_PREFIX = "attention_"
GENERAL_PREFIX = "general_"
ROW_BYTES_LIMIT = 64 * 1024

ITEMS_FILE = "items.jsonl"
HITS_FILE = "hits.csv"
SUMMARY_FILE = "summary.json"
SETTINGS_FILE = "settings.json"


@dataclass
class Item:
    """탭 하나. fields는 필드 이름 → 값(context는 str 또는 list[str], target은 list[str])."""

    record_index: int
    record_id: str
    item_id: str
    is_attention: bool
    fields: dict[str, Any] = field(default_factory=dict)
    targets: list[str] = field(default_factory=list)
    hints: list[str | None] = field(default_factory=list)
    reasons: list[str | None] = field(default_factory=list)
    expected_value: str | None = None


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
    """레코드들을 항목으로 푼다. (항목 목록, 통계) — 통계는 records(total/filtered/sampled/used), items, skipped_no_targets."""
    selected, record_stats = select_records(spec, records)
    target_field = spec.target_field
    hint = spec.item.hint
    items: list[Item] = []
    skipped = 0

    for record_index, (_, record) in enumerate(selected):
        record_id = record_id_of(spec, record, record_index)
        base = record_variables(record_index, record_id)
        try:
            for variables in iter_item_variables(spec, record, base):
                targets, keys = resolve_targets(target_field, record, variables)
                if not targets:
                    if spec.item.skip_if_no_targets:
                        skipped += 1
                        continue
                    raise SpecError([f"$.item.fields.{target_field.name}.path: no targets in record {record_id!r} "
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
                hints: list[str | None] = []
                reasons: list[str | None] = []
                for position, (target, key) in enumerate(zip(targets, keys)):
                    if hint is None:
                        hints.append(None)
                        reasons.append(None)
                        continue
                    tvars = target_variables(variables, target, position, key)
                    hints.append(map_hint(hint, paths.evaluate(hint.label_path, record, tvars)))
                    reason = None
                    if hint.reason_path is not None:
                        raw_reason = paths.evaluate(hint.reason_path, record, tvars)
                        if raw_reason is not MISSING and raw_reason is not None:
                            reason = raw_reason if isinstance(raw_reason, str) else json.dumps(raw_reason, ensure_ascii=False)
                    reasons.append(reason)
                items.append(Item(
                    record_index=record_index,
                    record_id=record_id,
                    item_id=_item_id(spec, record_id, variables),
                    is_attention=False,
                    fields=fields,
                    targets=list(targets),
                    hints=hints,
                    reasons=reasons,
                    expected_value=None,
                ))
        except PathError as error:
            raise SpecError([f"$.item: {error} (record {record_id!r})"]) from None

    stats = {"records": record_stats, "items": len(items), "skipped_no_targets": skipped}
    return items, stats


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
        extras = [_attention_item(spec, base, items, positions, k) for k in range(attention.per_hit)]
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


def _attention_item(spec: TaskSpec, base: Item, items: list[Item], by_record: dict[int, list[Item]], k: int) -> Item:
    """HIT의 첫 항목(base)을 복사해 attention 항목을 만든다. k는 HIT 안에서 몇 번째 attention인지 (0부터)."""
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
    fields[target_field.name] = list(targets)
    return Item(
        record_index=base.record_index,
        record_id=ATTENTION_ID,
        item_id=ATTENTION_ID,
        is_attention=True,
        fields=fields,
        targets=targets,
        hints=[attention.expected_value] * len(targets),
        reasons=[None] * len(targets),
        expected_value=attention.expected_value,
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


def answer_name(is_attention: bool, item_index: int, target_no: int, suffix: str) -> str:
    """답(라디오 그룹) 이름. item_index는 HIT 안의 항목 index(0부터, attention 포함), target_no는 1부터."""
    return f"{ATTENTION_PREFIX if is_attention else GENERAL_PREFIX}{item_index}_{target_no}{suffix}"


def answer_names(spec: TaskSpec, hit: list[Item]) -> list[list[str]]:
    """HIT의 항목마다 target 순서대로 답 이름 목록."""
    suffix = spec.item.question.answer_suffix
    return [[answer_name(item.is_attention, i, j + 1, suffix) for j in range(len(item.targets))] for i, item in enumerate(hit)]


def hit_id(hit_index: int) -> str:
    return f"hit-{hit_index + 1:04d}"


def csv_columns(spec: TaskSpec) -> list[str]:
    """hits.csv의 컬럼 순서: hit_id, record_ids, item_ids, attention, 필드들(spec 순서), reference, reason."""
    columns = ["hit_id", "record_ids", "item_ids", "attention", *spec.item.fields]
    columns.append(spec.output.reference_column)
    if spec.output.reason_column is not None:
        columns.append(spec.output.reason_column)
    return columns


def json_cell(value: Any) -> str:
    """CSV 셀용 JSON. `<`는 \\u003c로, U+2028/U+2029는 \\u2028/\\u2029로 써서 <script> 안에 그대로 넣어도 안전하다."""
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return text.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def hit_rows(spec: TaskSpec, hits: list[list[Item]]) -> tuple[list[str], list[dict[str, str]]]:
    """HIT들을 CSV 행으로 만든다. 모든 셀은 json_cell을 거친 문자열이다."""
    columns = csv_columns(spec)
    rows: list[dict[str, str]] = []
    for hit_index, hit in enumerate(hits):
        names = answer_names(spec, hit)
        reference: dict[str, str] = {}
        reasons: dict[str, str] = {}
        for item, item_names in zip(hit, names):
            for name, hint, reason in zip(item_names, item.hints, item.reasons):
                if hint is not None:
                    reference[name] = hint
                if reason is not None:
                    reasons[name] = reason
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
    reference_values: Counter[str] = Counter()
    hints_missing = 0
    targets = 0
    attention_items = 0
    for hit in hits:
        for item in hit:
            targets += len(item.targets)
            if item.is_attention:
                attention_items += 1
            for hint in item.hints:
                if hint is None:
                    hints_missing += 1
                else:
                    reference_values[hint] += 1
    sizes = [row_bytes(columns, row) for row in rows]
    return {
        "task_id": spec.task.id,
        "source_format": source_format,
        "records": item_stats["records"],
        "items": item_stats["items"],
        "skipped_no_targets": item_stats["skipped_no_targets"],
        "hits": len(hits),
        "items_per_hit": spec.hit.items_per_hit,
        "attention_items": attention_items,
        "targets": targets,
        "reference_values": dict(sorted(reference_values.items())),
        "hints_missing": hints_missing,
        "columns": columns,
        "row_bytes": bytes_summary(sizes),
        "rows_over_64kb": sum(1 for size in sizes if size > ROW_BYTES_LIMIT),
    }


def build_settings(spec: TaskSpec) -> dict:
    """콘솔 Create의 Settings에 넣을 값. Keywords는 콘솔과 MTurk가 쓰는 쉼표 구분 문자열이다."""
    attention = spec.hit.attention
    suffix = spec.item.question.answer_suffix
    rule = None
    if attention is not None and attention.per_hit > 0:
        rule = {"namePrefix": ATTENTION_PREFIX, "expectedValue": attention.expected_value, "minCorrectRatio": 1}
    return {
        "Title": spec.task.title,
        "Description": spec.task.description,
        "Keywords": ", ".join(spec.task.keywords),
        "attentionRule": rule,
        "reference": {"source": "column", "column": spec.output.reference_column},
        "referenceColumn": spec.output.reference_column,
        "reasonColumn": spec.output.reason_column,
        "answerNames": {
            "pattern": "general_{i}_{j}{suffix}",
            "suffix": suffix,
            "general": f"{GENERAL_PREFIX}{{i}}_{{j}}{suffix}",
            "attention": f"{ATTENTION_PREFIX}{{i}}_{{j}}{suffix}",
        },
        "itemsPerHit": spec.hit.items_per_hit,
        "attentionPerHit": attention.per_hit if attention is not None else 0,
        "optionValues": spec.option_values,
    }


def item_records(spec: TaskSpec, hits: list[list[Item]]) -> list[dict]:
    """items.jsonl의 줄들: Item dict + hit_id, item_index, answer_names."""
    out = []
    for hit_index, hit in enumerate(hits):
        names = answer_names(spec, hit)
        for item_index, item in enumerate(hit):
            data = asdict(item)
            data["hit_id"] = hit_id(hit_index)
            data["item_index"] = item_index
            data["answer_names"] = names[item_index]
            out.append(data)
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
    "Item", "build_items", "group_hits", "answer_name", "answer_names", "hit_rows", "json_cell", "run_preprocess",
    "select_records", "csv_columns", "row_bytes", "build_settings", "hit_id",
]
