"""원본 데이터 로더. JSON 파일을 레코드(dict) 리스트로 읽는다.

    파싱 결과가 리스트면 json_array (레코드 = 원소). dict이고 값이 모두 dict면 json_object_values
    (레코드 = 값, 각 레코드의 맨 앞에 키를 "_key"로 넣는다). 그 밖의 dict는 레코드 하나로 본다.

레코드가 dict가 아니면 {"_value": …}로 감싼다. 데이터는 JSON으로 통일했으므로 JSONL과 CSV는 이유를 알리며 거절한다.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

FORMATS = ("json_array", "json_object_values")
NOT_JSON_SUFFIXES = (".jsonl", ".ndjson", ".csv", ".tsv")


class SourceError(ValueError):
    """원본 파일을 읽거나 형식을 정할 수 없을 때."""


def _check_file(path: Path) -> None:
    if not path.is_file():
        raise SourceError(f"{path}: file not found")
    if path.suffix.lower() in NOT_JSON_SUFFIXES:
        raise SourceError(f"{path.name}: raw data must be a JSON file (an array of records or an object of records); convert it to .json first")


def detect_format(path: Path) -> str:
    """파일 형식을 정한다. 내용을 파싱해야 배열인지 객체인지 알 수 있다."""
    path = Path(path)
    _check_file(path)
    return _json_format(_read_json(path))


def load_records(path: Path, format: str | None = None) -> tuple[str, list[Any]]:
    """레코드들을 읽는다. format이 None이면 내용으로 정한다. (형식, 레코드 리스트)를 돌려준다."""
    path = Path(path)
    _check_file(path)
    if format is not None and format not in FORMATS:
        raise SourceError(f"unknown source format {format!r} (expected one of {', '.join(FORMATS)})")
    data = _read_json(path)
    format = format or _json_format(data)
    return format, _finish(_records_from_json(data, format, path), path)


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
    if isinstance(data, dict) and all(isinstance(value, dict) for value in data.values()):
        records = []
        for key, value in data.items():
            record = {"_key": key}
            record.update((k, v) for k, v in value.items() if k != "_key")
            records.append(record)
        return records
    raise SourceError(f"{path.name}: expected a JSON object whose values are objects")


def _finish(records: list[Any], path: Path) -> list[Any]:
    """dict가 아닌 레코드를 감싸고, 비어 있으면 오류."""
    if not records:
        raise SourceError(f"{path.name}: no records")
    return [record if isinstance(record, dict) else {"_value": record} for record in records]
