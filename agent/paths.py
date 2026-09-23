"""spec의 경로 언어. 레코드 안의 값을 가리키는 짧은 경로 문자열을 파싱하고 평가한다.

문법 (영어 설명은 spec_reference.md에 있다):

    시작        $              레코드 루트
                {var}          변수 값을 루트로 쓴다 (예: {passage}, {passage}.text)
    세그먼트    .name          키. 이름은 [A-Za-z_][A-Za-z0-9_-]*
                ['key']        따옴표 키 (' 또는 ", 백슬래시 이스케이프). 공백이나 기호가 든 키에 쓴다
                [0], [-1]      리스트 인덱스 (음수는 뒤에서부터)
                [*], .*        와일드카드. 리스트면 원소 전부, dict면 값 전부

경로 문자열 안의 {name}은 evaluate 전에 substitute로 문자열 치환한다 (['Fact {target_no}']). 첫머리의
{var} 루트만은 치환하지 않고 변수 값 자체를 루트로 쓴다. 값이 없으면 예외 대신 MISSING을 돌려주고,
와일드카드 안에서는 없는 원소만 건너뛴다.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_-]*")
VAR_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")
INDEX_RE = re.compile(r"-?\d+")


class Missing:
    """값이 없음을 나타내는 sentinel. 인스턴스는 MISSING 하나뿐이고 bool 값은 False다."""

    __slots__ = ()
    _instance: Missing | None = None

    def __new__(cls) -> Missing:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __bool__(self) -> bool:
        return False

    def __repr__(self) -> str:
        return "MISSING"

    def __reduce__(self) -> str:
        return "MISSING"


MISSING = Missing()


class PathError(ValueError):
    """경로 문법이 틀리거나 경로가 쓰는 변수가 없을 때."""


@dataclass(frozen=True)
class Segment:
    """경로의 한 조각. kind는 root(`$`), var(`{name}` 루트), key, index, wild 중 하나다."""

    kind: str
    value: Any = None


def substitute(path: str, variables: Mapping[str, Any]) -> str:
    """경로 안의 {name}을 str(variables[name])로 바꾼다. 한 번만 치환하며 첫머리의 {var} 루트는 그대로 둔다."""
    start = 0
    head = VAR_RE.match(path)
    if head is not None and head.start() == 0:
        start = head.end()

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        try:
            value = variables[name]
        except KeyError:
            raise PathError(f"unknown variable {{{name}}} in path {path!r}") from None
        return str(value)

    return path[:start] + VAR_RE.sub(replace, path[start:])


def variable_names(path: str) -> list[str]:
    """경로가 쓰는 변수 이름들 (루트 {var} 포함, 등장 순서, 중복 제거)."""
    names: list[str] = []
    for name in VAR_RE.findall(path):
        if name not in names:
            names.append(name)
    return names


def parse(path: str) -> list[Segment]:
    """경로 문자열을 세그먼트 목록으로 바꾼다. 문법이 틀리면 PathError."""
    if not isinstance(path, str) or not path:
        raise PathError("path must be a non-empty string")
    segments: list[Segment] = []
    n = len(path)
    if path[0] == "$":
        segments.append(Segment("root"))
        pos = 1
    elif path[0] == "{":
        head = VAR_RE.match(path)
        if head is None:
            raise PathError(f"{path!r}: expected {{var}} at the start")
        segments.append(Segment("var", head.group(1)))
        pos = head.end()
    else:
        raise PathError(f"{path!r}: path must start with '$' or '{{var}}'")

    while pos < n:
        char = path[pos]
        if char == ".":
            pos += 1
            if pos < n and path[pos] == "*":
                segments.append(Segment("wild"))
                pos += 1
                continue
            match = NAME_RE.match(path, pos)
            if match is None:
                raise PathError(f"{path!r}: expected a name after '.' at position {pos}")
            segments.append(Segment("key", match.group()))
            pos = match.end()
        elif char == "[":
            pos += 1
            if pos >= n:
                raise PathError(f"{path!r}: unterminated '[' at position {pos - 1}")
            inner = path[pos]
            if inner == "*":
                segments.append(Segment("wild"))
                pos += 1
            elif inner in "'\"":
                key, pos = _read_quoted(path, pos)
                segments.append(Segment("key", key))
            else:
                match = INDEX_RE.match(path, pos)
                if match is None:
                    raise PathError(f"{path!r}: expected an index, a quoted key or * at position {pos}")
                segments.append(Segment("index", int(match.group())))
                pos = match.end()
            if pos >= n or path[pos] != "]":
                raise PathError(f"{path!r}: expected ']' at position {pos}")
            pos += 1
        else:
            raise PathError(f"{path!r}: unexpected {char!r} at position {pos}")
    return segments


def _read_quoted(path: str, pos: int) -> tuple[str, int]:
    """따옴표로 감싼 키를 읽는다. pos는 여는 따옴표 위치, 돌려주는 위치는 닫는 따옴표 다음이다."""
    quote = path[pos]
    pos += 1
    chars: list[str] = []
    n = len(path)
    while pos < n:
        char = path[pos]
        if char == "\\":
            if pos + 1 >= n:
                break
            chars.append(path[pos + 1])
            pos += 2
            continue
        if char == quote:
            return "".join(chars), pos + 1
        chars.append(char)
        pos += 1
    raise PathError(f"{path!r}: unterminated quoted key")


def format_key(key: str) -> str:
    """dict 키를 경로 세그먼트 표기로 바꾼다. 이름 문법에 맞으면 .name, 아니면 ['key']."""
    if NAME_RE.fullmatch(key):
        return "." + key
    escaped = key.replace("\\", "\\\\").replace("'", "\\'")
    return f"['{escaped}']"


def format_path(segments: list[Segment]) -> str:
    """세그먼트 목록을 경로 문자열로 되돌린다 (parse의 역)."""
    parts: list[str] = []
    for segment in segments:
        if segment.kind == "root":
            parts.append("$")
        elif segment.kind == "var":
            parts.append("{" + segment.value + "}")
        elif segment.kind == "key":
            parts.append(format_key(segment.value))
        elif segment.kind == "index":
            parts.append(f"[{segment.value}]")
        elif segment.kind == "wild":
            parts.append("[*]")
        else:
            raise PathError(f"unknown segment kind {segment.kind!r}")
    return "".join(parts)


def has_wildcard(path: str) -> bool:
    """경로에 와일드카드가 있는지 (변수는 임시값으로 치환해서 판단한다)."""
    return any(segment.kind == "wild" for segment in parse(substitute(path, _AnyValue())))


class _AnyValue(Mapping):
    """문법 검사용 변수 표. 어떤 이름이든 "1"을 돌려준다."""

    def __getitem__(self, name: str) -> str:
        return "1"

    def __iter__(self):
        return iter(())

    def __len__(self) -> int:
        return 0


def check_syntax(path: str) -> None:
    """변수를 임시값으로 채운 뒤 파싱해 문법만 검사한다. 틀리면 PathError."""
    parse(substitute(path, _AnyValue()))


def evaluate(path: str, root: Any, variables: Mapping[str, Any] | None = None) -> Any:
    """경로를 평가한다. 와일드카드가 없으면 값 하나, 있으면 리스트. 값이 없으면 MISSING."""
    if variables is not None:
        path = substitute(path, variables)
    segments = parse(path)
    head = segments[0]
    if head.kind == "var":
        if variables is None or head.value not in variables:
            raise PathError(f"unknown variable {{{head.value}}} in path {path!r}")
        current: Any = variables[head.value]
    else:
        current = root

    values: list[Any] = [current]
    spread = False
    for segment in segments[1:]:
        next_values: list[Any] = []
        if segment.kind == "wild":
            for value in values:
                if isinstance(value, list):
                    next_values.extend(value)
                elif isinstance(value, dict):
                    next_values.extend(value.values())
                elif not spread:
                    return MISSING
            spread = True
        else:
            for value in values:
                stepped = _step(value, segment)
                if stepped is MISSING:
                    if not spread:
                        return MISSING
                    continue
                next_values.append(stepped)
        values = next_values
    return values if spread else values[0]


def _step(value: Any, segment: Segment) -> Any:
    """키나 인덱스 한 단계를 내려간다. 타입이 맞지 않거나 없으면 MISSING."""
    if segment.kind == "key":
        if isinstance(value, dict) and segment.value in value:
            return value[segment.value]
        return MISSING
    if segment.kind == "index":
        if isinstance(value, list) and -len(value) <= segment.value < len(value):
            return value[segment.value]
        return MISSING
    raise PathError(f"cannot step with segment kind {segment.kind!r}")
