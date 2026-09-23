"""원본 데이터 로더. JSON 배열, JSON 객체(값들이 레코드), JSONL, CSV를 레코드(dict) 리스트로 읽는다.

    .json   파싱 결과가 리스트면 json_array (레코드 = 원소). dict이고 값이 모두 dict면 json_object_values
            (레코드 = 값, 각 레코드의 맨 앞에 키를 "_key"로 넣는다). 그 밖의 dict는 레코드 하나로 본다.
    .jsonl  줄마다 JSON 하나.
    .csv    csv.DictReader. 셀은 json.loads → 실패하면 ast.literal_eval(Python repr) → 실패하면 문자열 그대로.
            그래서 이전 MTurk용 입력 CSV(셀이 Python 리터럴)도 구조로 읽힌다.

레코드가 dict가 아니면 {"_value": …}로 감싼다. 확장자를 모르면 내용 첫 글자로 추정한다.
"""

from __future__ import annotations

import ast
import csv
import json
import sys
from pathlib import Path
from typing import Any

csv.field_size_limit(sys.maxsize)

FORMATS = ("json_array", "json_object_values", "jsonl", "csv")


class SourceError(ValueError):
    """원본 파일을 읽거나 형식을 정할 수 없을 때."""


def detect_format(path: Path) -> str:
    """파일 형식을 정한다. .json은 내용을 파싱해야 배열인지 객체인지 알 수 있다."""
    path = Path(path)
    if not path.is_file():
        raise SourceError(f"{path}: file not found")
    suffix = path.suffix.lower()
    if suffix in (".jsonl", ".ndjson"):
        return "jsonl"
    if suffix == ".csv":
        return "csv"
    if suffix == ".json":
        return _json_format(_read_json(path))
    return _sniff(path)


def load_records(path: Path, format: str | None = None) -> tuple[str, list[Any]]:
    """레코드들을 읽는다. format이 None이면 detect_format으로 정한다. (형식, 레코드 리스트)를 돌려준다."""
    path = Path(path)
    if not path.is_file():
        raise SourceError(f"{path}: file not found")
    if format is not None and format not in FORMATS:
        raise SourceError(f"unknown source format {format!r} (expected one of {', '.join(FORMATS)})")

    if format is None:
        suffix = path.suffix.lower()
        if suffix == ".json":
            data = _read_json(path)
            format = _json_format(data)
            records = _records_from_json(data, format, path)
            return format, _finish(records, path)
        format = detect_format(path)

    if format == "jsonl":
        records = _read_jsonl(path)
    elif format == "csv":
        records = _read_csv(path)
    else:
        records = _records_from_json(_read_json(path), format, path)
    return format, _finish(records, path)


def decode_cell(text: str | None) -> Any:
    """CSV 셀 하나를 값으로 바꾼다. JSON → Python 리터럴 → 문자열 순서로 시도한다."""
    if text is None:
        return ""
    stripped = text.strip()
    if not stripped:
        return text
    try:
        return json.loads(stripped)
    except ValueError:
        pass
    try:
        return ast.literal_eval(stripped)
    except (ValueError, SyntaxError, TypeError, MemoryError, RecursionError):
        return text


def _read_json(path: Path) -> Any:
    try:
        with path.open(encoding="utf-8-sig") as handle:
            return json.load(handle)
    except ValueError as error:
        raise SourceError(f"{path.name}: invalid JSON: {error}") from None


def _json_format(data: Any) -> str:
    if isinstance(data, list):
        return "json_array"
    if isinstance(data, dict) and data and all(isinstance(value, dict) for value in data.values()):
        return "json_object_values"
    if isinstance(data, dict):
        return "json_array"
    raise SourceError("JSON file must contain an array or an object")


def _records_from_json(data: Any, format: str, path: Path) -> list[Any]:
    if format == "json_array":
        if isinstance(data, list):
            return list(data)
        if isinstance(data, dict):
            return [data]
        raise SourceError(f"{path.name}: expected a JSON array")
    if format == "json_object_values":
        if not isinstance(data, dict) or not all(isinstance(value, dict) for value in data.values()):
            raise SourceError(f"{path.name}: expected a JSON object whose values are objects")
        records = []
        for key, value in data.items():
            record = {"_key": key}
            record.update((k, v) for k, v in value.items() if k != "_key")
            records.append(record)
        return records
    raise SourceError(f"{path.name}: format {format!r} does not apply to a JSON file")


def _read_jsonl(path: Path) -> list[Any]:
    records = []
    with path.open(encoding="utf-8-sig") as handle:
        for number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                records.append(json.loads(line))
            except ValueError as error:
                raise SourceError(f"{path.name}: line {number}: invalid JSON: {error}") from None
    return records


def _read_csv(path: Path) -> list[Any]:
    records = []
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise SourceError(f"{path.name}: CSV has no header row")
        for row in reader:
            record = {}
            for key, value in row.items():
                if key is None:
                    continue
                record[key] = decode_cell(value)
            records.append(record)
    return records


def _sniff(path: Path) -> str:
    """확장자로 알 수 없을 때 내용을 보고 형식을 정한다."""
    with path.open(encoding="utf-8-sig") as handle:
        head = handle.read(4096)
    text = head.lstrip()
    if text.startswith("["):
        return "json_array"
    if text.startswith("{"):
        try:
            return _json_format(_read_json(path))
        except SourceError:
            return "jsonl"
    first_line = head.splitlines()[0] if head.splitlines() else ""
    if "," in first_line:
        return "csv"
    raise SourceError(f"{path.name}: cannot detect the format; pass it explicitly")


def _finish(records: list[Any], path: Path) -> list[Any]:
    """dict가 아닌 레코드를 감싸고, 비어 있으면 오류."""
    if not records:
        raise SourceError(f"{path.name}: no records")
    return [record if isinstance(record, dict) else {"_value": record} for record in records]
