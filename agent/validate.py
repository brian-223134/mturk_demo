"""출력 묶음(task_spec.json, template.html, hits.csv) 검증 → validation.json.

    extract_placeholders(html)   템플릿의 `${이름}` 목록 (콘솔과 같은 정규식, 등장 순서, 중복 없음)
    substitute_row(html, row)    콘솔·MTurk와 같은 치환 (escape 없이, 행에 없는 이름은 그대로)
    validate_bundle(out_dir)     {"ok", "errors", "warnings", "stats"}를 돌려주고 validation.json으로 저장한다
    run_validate(out_dir)        validate_bundle + 짧은 보고를 stdout에 찍는다

errors는 게시할 수 없는 문제(placeholder와 컬럼 불일치, JSON이 아닌 셀, 항목 수 불일치, reference·attention 값 오류 …),
warnings는 참고(64KB를 넘는 행, preprocess가 건너뛴 레코드(summary.json의 skipped_records) …)다. 답 이름 시뮬레이션은
spec.answer_slots와 preprocess.answer_name을 그대로 써서 템플릿의 이름 규칙, CSV의 reference 키, attention 컬럼의 키가
서로 맞는지 확인한다.

placeholder는 정확히 hit_id와 spec의 필드들이다 (attention 표시는 CSV에만 있다). reference 컬럼에는 일반 항목의 답만,
attention 컬럼에는 기대 값이 있는 attention 항목의 답만 있어야 하고, 자유 서술(text) 답은 reference에 들어가지 않는다.
자유 서술 답의 접미어로 끝나는 다른 답 이름이 있으면 콘솔이 둘을 가르지 못하므로 오류다.
"""

from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path
from typing import Any

csv.field_size_limit(sys.maxsize)

from agent.preprocess import (ATTENTION_ID, GENERAL_PREFIX, ROW_BYTES_LIMIT, answer_name, csv_columns, has_attention_column,
                              row_bytes)
from agent.spec import QuestionSpec, SpecError, TaskSpec, answer_slots, load_spec

PLACEHOLDER_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")
SPEC_FILE = "task_spec.json"
TEMPLATE_FILE = "template.html"
HITS_FILE = "hits.csv"
SUMMARY_FILE = "summary.json"
VALIDATION_FILE = "validation.json"
REQUIRED_MARKERS = ("crowd-form", "input_answers", "summary-tabs", "TASK_ANSWER_SCHEMA")
OLD_ATTENTION_PREFIX = "attention_"   # 옛 attention 답 이름 접두어. 템플릿에 남아 있으면 attention 탭이 드러난다
MAX_REPORTED = 20


def extract_placeholders(html: str) -> list[str]:
    names: list[str] = []
    for match in PLACEHOLDER_RE.finditer(html):
        if match.group(1) not in names:
            names.append(match.group(1))
    return names


def substitute_row(html: str, row: dict[str, str]) -> str:
    """`${이름}`을 행의 셀 문자열로 바꾼다 (escape 없음). 행에 없는 이름은 그대로 둔다."""
    return PLACEHOLDER_RE.sub(lambda match: row[match.group(1)] if match.group(1) in row else match.group(0), html)


class _Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.stats: dict[str, Any] = {}
        self._counts: dict[str, int] = {}

    def error(self, message: str, key: str | None = None) -> None:
        self._add(self.errors, message, key)

    def warning(self, message: str, key: str | None = None) -> None:
        self._add(self.warnings, message, key)

    def _add(self, bucket: list[str], message: str, key: str | None) -> None:
        # 같은 종류의 문제는 MAX_REPORTED개까지만 적고 나머지는 개수로 남긴다
        if key is None:
            bucket.append(message)
            return
        count = self._counts.get(key, 0) + 1
        self._counts[key] = count
        if count <= MAX_REPORTED:
            bucket.append(message)
        elif count == MAX_REPORTED + 1:
            bucket.append(f"{key}: more of the same (only the first {MAX_REPORTED} are listed)")

    def result(self) -> dict:
        return {"ok": not self.errors, "errors": self.errors, "warnings": self.warnings, "stats": self.stats}


def validate_bundle(out_dir: Path) -> dict:
    """out_dir의 묶음을 검사하고 결과를 validation.json에 저장한다."""
    out_dir = Path(out_dir)
    report = _Report()
    result = _validate(out_dir, report)
    with (out_dir / VALIDATION_FILE).open("w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return result


def _validate(out_dir: Path, report: _Report) -> dict:
    spec_path = out_dir / SPEC_FILE
    template_path = out_dir / TEMPLATE_FILE
    hits_path = out_dir / HITS_FILE
    for path in (spec_path, template_path, hits_path):
        if not path.is_file():
            report.error(f"{path.name}: file not found")
    spec: TaskSpec | None = None
    if spec_path.is_file():
        try:
            spec = load_spec(spec_path)
        except SpecError as error:
            for message in error.messages:
                report.error(f"{SPEC_FILE}: {message}")
    if spec is None or not template_path.is_file() or not hits_path.is_file():
        return report.result()

    template = template_path.read_text(encoding="utf-8")
    placeholders = extract_placeholders(template)
    expected_placeholders = ["hit_id", *spec.item.fields]
    report.stats["placeholders"] = placeholders
    if set(placeholders) != set(expected_placeholders):
        report.error(f"{TEMPLATE_FILE}: placeholders {sorted(placeholders)} differ from the expected "
                     f"{sorted(expected_placeholders)} (hit_id and the spec fields)")
    for marker in REQUIRED_MARKERS:
        if marker not in template:
            report.error(f"{TEMPLATE_FILE}: {marker!r} not found")
    if OLD_ATTENTION_PREFIX in template:
        report.error(f"{TEMPLATE_FILE}: contains {OLD_ATTENTION_PREFIX!r}; attention tabs must not be recognisable in the page")

    columns, rows = _read_csv(hits_path, report)
    if columns is None:
        return report.result()
    report.stats["columns"] = columns
    report.stats["rows"] = len(rows)
    missing = [name for name in placeholders if name not in columns]
    if missing:
        report.error(f"{HITS_FILE}: placeholder column(s) missing: {', '.join(missing)}")
    report.stats["unused_columns"] = [column for column in columns if column not in placeholders]
    expected_columns = csv_columns(spec)
    if columns != expected_columns:
        absent = [column for column in expected_columns if column not in columns]
        if absent:
            report.error(f"{HITS_FILE}: expected column(s) missing: {', '.join(absent)}")
        elif [column for column in columns if column in expected_columns] != expected_columns:
            report.warning(f"{HITS_FILE}: column order differs from the spec order {expected_columns}")
    if not rows:
        report.error(f"{HITS_FILE}: no data rows")
        return report.result()

    _check_rows(spec, columns, rows, report)
    _check_render(template, rows[0], report)
    _check_summary(out_dir / SUMMARY_FILE, report)
    return report.result()


def _check_summary(path: Path, report: _Report) -> None:
    """preprocess가 건너뛴 레코드가 있으면 경고한다 (summary.json의 skipped_records). 파일이 없으면 넘어간다."""
    try:
        summary = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    skipped = summary.get("skipped_records") if isinstance(summary, dict) else None
    count = skipped.get("count", 0) if isinstance(skipped, dict) else 0
    report.stats["skipped_records"] = count if isinstance(count, int) else 0
    if not isinstance(count, int) or count < 1:
        return
    examples = [entry for entry in skipped.get("examples", []) if isinstance(entry, dict)]
    example = f" (e.g. record {examples[0].get('record_id')!r}: {examples[0].get('reason')})" if examples else ""
    report.warning(f"{SUMMARY_FILE}: {count} record(s) were skipped because their data does not fit the spec{example}")


def _read_csv(path: Path, report: _Report) -> tuple[list[str] | None, list[dict[str, str]]]:
    with path.open("rb") as handle:
        head = handle.read(3)
    if head == b"\xef\xbb\xbf":
        report.warning(f"{HITS_FILE}: starts with a UTF-8 BOM; MTurk and the console strip it, but write the file without one")
    with path.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle)
        try:
            columns = next(reader)
        except StopIteration:
            report.error(f"{HITS_FILE}: empty file")
            return None, []
        rows: list[dict[str, str]] = []
        for number, values in enumerate(reader, start=2):
            if len(values) != len(columns):
                report.error(f"{HITS_FILE} line {number}: {len(values)} cells for {len(columns)} columns", key="cell count")
                continue
            rows.append(dict(zip(columns, values)))
    if len(set(columns)) != len(columns):
        report.error(f"{HITS_FILE}: duplicate column names")
    return columns, rows


def _value_word(question: QuestionSpec) -> str:
    return "a scale value" if question.type == "likert" else "an option value"


def _check_rows(spec: TaskSpec, columns: list[str], rows: list[dict[str, str]], report: _Report) -> None:
    attention = spec.hit.attention
    per_hit = attention.per_hit if attention is not None else 0
    expected_by_question = dict(attention.expected) if attention is not None else {}
    text_suffixes = spec.free_text_suffixes
    target = spec.target_field.name if spec.target_field is not None else None
    reference_column = spec.output.reference_column
    reason_column = spec.output.reason_column
    attention_column = spec.output.attention_column if has_attention_column(spec) else None
    field_names = [name for name in spec.item.fields if name in columns]
    # 없는 컬럼은 _validate가 이미 오류로 적었다. 있는 컬럼만 행 단위로 검사한다
    have_ids = all(name in columns for name in ("record_ids", "item_ids", "attention"))
    have_target = target is None or target in columns

    sizes: list[int] = []
    over_limit: list[str] = []
    hit_ids: set[str] = set()
    items_total = 0
    attention_total = 0
    targets_total = 0
    answers_total = 0
    attention_answers = 0
    reference_values: dict[str, int] = {}
    hints_missing = 0
    row_ok = 0

    for number, row in enumerate(rows, start=2):
        where = f"{HITS_FILE} line {number}"
        size = row_bytes(columns, row)
        sizes.append(size)
        cells: dict[str, Any] = {}
        broken = False
        for column in columns:
            try:
                cells[column] = json.loads(row[column])
            except ValueError as error:
                report.error(f"{where}: column {column!r} is not JSON ({error})", key="not JSON")
                broken = True
        if broken:
            continue
        hit_id = cells.get("hit_id")
        if not isinstance(hit_id, str) or not hit_id:
            report.error(f"{where}: hit_id must be a non-empty JSON string", key="hit_id")
        elif hit_id in hit_ids:
            report.error(f"{where}: duplicate hit_id {hit_id!r}", key="duplicate hit_id")
        else:
            hit_ids.add(hit_id)
        if size > ROW_BYTES_LIMIT:
            over_limit.append(str(hit_id))
        if not (have_ids and have_target):
            continue

        lists = {name: cells[name] for name in ("record_ids", "item_ids", "attention", *field_names)}
        bad = [name for name, value in lists.items() if not isinstance(value, list)]
        if bad:
            report.error(f"{where}: column(s) {', '.join(bad)} must be JSON lists (one entry per item)", key="not a list")
            continue
        lengths = {name: len(value) for name, value in lists.items()}
        count = lengths.get("attention", 0)
        if len(set(lengths.values())) != 1:
            report.error(f"{where}: item counts differ between columns: {lengths}", key="item count")
            continue
        if count == 0:
            report.error(f"{where}: no items", key="no items")
            continue
        flags = cells["attention"]
        if any(flag not in (0, 1) for flag in flags):
            report.error(f"{where}: attention must contain only 0 and 1", key="attention flags")
            continue
        if sum(flags) != per_hit:
            report.error(f"{where}: {sum(flags)} attention item(s), spec says {per_hit}", key="attention count")
        general = count - sum(flags)
        if general < 1 or general > spec.hit.items_per_hit:
            report.error(f"{where}: {general} non-attention item(s), items_per_hit is {spec.hit.items_per_hit}", key="items per hit")
        for index, flag in enumerate(flags):
            expected_id = ATTENTION_ID if flag == 1 else None
            if flag == 1 and (cells["record_ids"][index] != expected_id or cells["item_ids"][index] != expected_id):
                report.error(f"{where}: item {index} is an attention item but record_ids/item_ids are not {ATTENTION_ID!r}", key="attention ids")
            if flag == 0 and (cells["record_ids"][index] == ATTENTION_ID or cells["item_ids"][index] == ATTENTION_ID):
                report.error(f"{where}: item {index} is marked {ATTENTION_ID!r} but attention is 0", key="attention ids")

        # 답 이름 시뮬레이션: 템플릿과 같은 규칙(answer_slots + answer_name)으로 이 행의 답 이름을 만든다
        names: list[str] = []
        question_of: dict[str, QuestionSpec] = {}
        attention_names: set[str] = set()
        expected_names: dict[str, str] = {}
        row_targets = 0
        target_ok = True
        for index in range(count):
            n_targets = 0
            if target is not None:
                targets = cells[target][index]
                if not isinstance(targets, list) or not targets or not all(isinstance(t, str) for t in targets):
                    report.error(f"{where}: {target}[{index}] must be a non-empty list of strings", key="targets")
                    target_ok = False
                    continue
                n_targets = len(targets)
            row_targets += n_targets
            for question, target_no in answer_slots(spec, n_targets):
                name = answer_name(index, target_no, question.suffix)
                names.append(name)
                question_of[name] = question
                if flags[index] == 1:
                    attention_names.add(name)
                    if question.id in expected_by_question:
                        expected_names[name] = expected_by_question[question.id]
        if not target_ok:
            continue
        for index in range(count):
            for name in ("record_ids", "item_ids"):
                if not isinstance(cells[name][index], str):
                    report.error(f"{where}: {name}[{index}] must be a string", key="id type")
        for name in field_names:
            if name == target:
                continue
            for index, value in enumerate(cells[name]):
                if not (isinstance(value, str) or (isinstance(value, list) and all(isinstance(v, str) for v in value))):
                    report.error(f"{where}: {name}[{index}] must be a string or a list of strings", key="context type")
                    break
        if len(set(names)) != len(names):
            report.error(f"{where}: duplicate answer names", key="answer names")
        if any(not name.startswith(GENERAL_PREFIX) for name in names):
            report.error(f"{where}: every answer name must start with {GENERAL_PREFIX!r}", key="answer names")
        for name in names:
            if question_of[name].type == "text":
                continue
            clash = next((suffix for suffix in text_suffixes if name.endswith(suffix)), None)
            if clash is not None:
                report.error(f"{where}: answer name {name!r} ends with the free-text suffix {clash!r}", key="free-text suffix")

        reference = cells.get(reference_column)
        if not isinstance(reference, dict):
            report.error(f"{where}: {reference_column} must be a JSON object {{answer name: option value}}", key="reference type")
        else:
            unknown = [key for key in reference if key not in question_of]
            if unknown:
                report.error(f"{where}: {reference_column} has key(s) that are not answer names: {', '.join(unknown[:5])}", key="reference keys")
            leaked = [key for key in reference if key in attention_names]
            if leaked:
                report.error(f"{where}: {reference_column} has attention answer(s) {', '.join(leaked[:5])}; expected values "
                             f"belong in the attention column", key="attention in reference")
            for key, value in reference.items():
                question = question_of.get(key)
                if question is None or key in attention_names:
                    continue
                if question.type == "text":
                    report.error(f"{where}: {reference_column}[{key!r}] is a free-text answer (text has no reference)", key="reference text")
                elif not isinstance(value, str) or value not in question.values:
                    report.error(f"{where}: {reference_column}[{key!r}] = {value!r} is not {_value_word(question)} of "
                                 f"question {question.id!r}", key="reference value")
                else:
                    reference_values[value] = reference_values.get(value, 0) + 1
            hints_missing += sum(1 for name in names
                                 if name not in attention_names and question_of[name].type != "text" and name not in reference)
        if reason_column is not None:
            reasons = cells.get(reason_column)
            if not isinstance(reasons, dict):
                report.error(f"{where}: {reason_column} must be a JSON object {{answer name: reason}}", key="reason type")
            else:
                unknown = [key for key in reasons if key not in question_of or key in attention_names]
                if unknown:
                    report.error(f"{where}: {reason_column} has key(s) that are not answer names of normal items: "
                                 f"{', '.join(unknown[:5])}", key="reason keys")
        if attention_column is not None:
            expected = cells.get(attention_column)
            if not isinstance(expected, dict):
                report.error(f"{where}: {attention_column} must be a JSON object {{answer name: expected value}}", key="attention type")
            else:
                for name, value in expected_names.items():
                    if name not in expected:
                        report.error(f"{where}: {attention_column} lacks the attention answer {name}", key="attention expected")
                    elif expected[name] != value:
                        report.error(f"{where}: {attention_column}[{name!r}] = {expected[name]!r}, expected {value!r}", key="attention expected")
                    else:
                        attention_answers += 1
                extra = [key for key in expected if key not in expected_names]
                if extra:
                    report.error(f"{where}: {attention_column} has key(s) that are not attention answers with an expected "
                                 f"value: {', '.join(extra[:5])}", key="attention keys")

        row_ok += 1
        items_total += count
        attention_total += sum(flags)
        targets_total += row_targets
        answers_total += len(names)

    if over_limit:
        report.warning(f"{HITS_FILE}: {len(over_limit)} row(s) exceed {ROW_BYTES_LIMIT // 1024} KB (MTurk rejects them): "
                       f"{', '.join(over_limit[:10])}{' …' if len(over_limit) > 10 else ''}")
    ordered = sorted(sizes)
    middle = len(ordered) // 2
    report.stats.update({
        "rows_ok": row_ok,
        "items": items_total,
        "attention_items": attention_total,
        "targets": targets_total,
        "answers": answers_total,
        "attention_answers": attention_answers,
        "reference_values": dict(sorted(reference_values.items())),
        "hints_missing": hints_missing,
        "free_text_suffixes": list(text_suffixes),
        "row_bytes": {
            "min": ordered[0] if ordered else 0,
            "median": (ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) // 2) if ordered else 0,
            "max": ordered[-1] if ordered else 0,
        },
        "rows_over_64kb": len(over_limit),
    })


def _check_render(template: str, row: dict[str, str], report: _Report) -> None:
    """첫 행으로 렌더해 본다: placeholder가 남지 않고, 데이터가 </script를 끼워 넣지 않고, 필수 요소가 있다."""
    rendered = substitute_row(template, row)
    leftover = extract_placeholders(rendered)
    if leftover:
        report.error(f"first row rendered: placeholder(s) left unsubstituted: {', '.join(leftover)}")
    marker = "</script"
    if rendered.lower().count(marker) != template.lower().count(marker):
        report.error("first row rendered: the data introduces '</script' (cells must escape '<' as \\u003c)")
    for name in REQUIRED_MARKERS:
        if name not in rendered:
            report.error(f"first row rendered: {name!r} not found")
    report.stats["rendered_bytes"] = len(rendered.encode("utf-8"))


def run_validate(out_dir: Path) -> dict:
    """검증하고 짧은 보고를 stdout에 찍는다."""
    result = validate_bundle(out_dir)
    stats = result["stats"]
    print(f"validate {Path(out_dir)}: {'ok' if result['ok'] else 'FAILED'}")
    if "rows" in stats:
        print(f"  rows {stats.get('rows')}, items {stats.get('items', 0)}, attention items {stats.get('attention_items', 0)}, "
              f"targets {stats.get('targets', 0)}, answers {stats.get('answers', 0)}, hints missing {stats.get('hints_missing', 0)}")
    if "row_bytes" in stats:
        size = stats["row_bytes"]
        print(f"  row bytes min {size['min']}, median {size['median']}, max {size['max']}; over 64KB: {stats.get('rows_over_64kb', 0)}")
    if "placeholders" in stats:
        print(f"  placeholders: {', '.join(stats['placeholders'])}")
    for message in result["errors"]:
        print(f"  error: {message}")
    for message in result["warnings"]:
        print(f"  warning: {message}")
    return result


__all__ = ["PLACEHOLDER_RE", "extract_placeholders", "substitute_row", "validate_bundle", "run_validate"]
