"""JavaScript 와 같은 값 동작. 프로토타입(TypeScript)의 응답과 바이트까지 같게 내려면 JS 의 number, String(),
===, 문자열 길이(UTF-16), toFixed, localeCompare 의 규칙을 그대로 따라야 한다. 그 규칙을 한곳에 모았다.

    is_js_integer(3.0) is True           Number.isInteger
    js_number_of("120") == 120           Number(value)  (읽을 수 없으면 NaN)
    js_string(2.0) == "2"                String(value)
    js_equal(1, True) is False           ===  (bool 과 number 는 다른 타입)
    js_truthy({}) is True                if (value)
    js_len("a😀") == 3                    "a😀".length  (UTF-16 code unit)
    to_fixed(500.125, 2) == "500.13"     toFixed 는 정확한 값에서 0.5 를 올린다 (Python 의 format 은 짝수로 간다)
    locale_key("a") < locale_key("B")    localeCompare (기본 로케일: 대소문자를 무시한 뒤, 소문자가 먼저)
    natural_key("q_2") < natural_key("q_10")   localeCompare(…, {numeric: true})
"""

from __future__ import annotations

import math
import re
import unicodedata
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from app.domain.cost import js_number  # noqa: F401  (다른 domain 모듈이 여기서 함께 가져다 쓴다)

_HEX_RE = re.compile(r"^0[xX][0-9a-fA-F]+$")
_NUMBER_RE = re.compile(r"^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$")
_DIGIT_RUN_RE = re.compile(r"(\d+)")


def is_js_number(value: object) -> bool:
    """typeof value === 'number' (bool 은 number 가 아니다)."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def is_js_integer(value: object) -> bool:
    """Number.isInteger: 유한한 number 이고 정수 값이면 True (3.0 도 정수다)."""
    return is_js_number(value) and math.isfinite(value) and float(value).is_integer()


def is_finite_number(value: object) -> bool:
    """Number.isFinite."""
    return is_js_number(value) and math.isfinite(value)


def js_number_of(value: object) -> float | int:
    """Number(value). 문자열은 앞뒤 공백을 뺀 전체가 숫자여야 하고, 빈 문자열과 null 은 0, 읽을 수 없으면 NaN."""
    if isinstance(value, bool):
        return 1 if value else 0
    if is_js_number(value):
        return value
    if value is None:
        return 0
    if isinstance(value, str):
        text = value.strip()
        if text == "":
            return 0
        if _HEX_RE.match(text):
            return int(text, 16)
        if text in ("Infinity", "+Infinity"):
            return math.inf
        if text == "-Infinity":
            return -math.inf
        if _NUMBER_RE.match(text):
            number = float(text)
            return int(number) if number.is_integer() and abs(number) < 2**53 else number
        return math.nan
    if isinstance(value, list):
        if len(value) == 0:
            return 0
        if len(value) == 1:
            return js_number_of(js_string(value[0]))
        return math.nan
    return math.nan


def js_number_to_string(number: float | int) -> str:
    """String(number): 정수 값은 지수 없이, 그 밖에는 가장 짧은 표기. 1e21 이상은 지수 표기다."""
    if isinstance(number, bool):
        return "true" if number else "false"
    if isinstance(number, int):
        return str(number)
    if math.isnan(number):
        return "NaN"
    if math.isinf(number):
        return "Infinity" if number > 0 else "-Infinity"
    if number.is_integer() and abs(number) < 1e21:
        return str(int(number))
    text = repr(number)
    if "e" in text:
        mantissa, exponent = text.split("e")
        if mantissa.endswith(".0"):
            mantissa = mantissa[:-2]
        sign = "-" if exponent.startswith("-") else "+"
        digits = exponent.lstrip("+-").lstrip("0") or "0"
        return f"{mantissa}e{sign}{digits}"
    return text


def js_string(value: object) -> str:
    """String(value). 객체와 배열은 JSON 으로 보이는 대로 (JS 의 [object Object] 대신) 적는다."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return js_number_to_string(value)
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return ",".join(js_string(v) for v in value)
    return "[object Object]"


def js_truthy(value: object) -> bool:
    """if (value): null, false, 0, NaN, "" 만 거짓이다 (빈 배열과 빈 객체는 참)."""
    if value is None or value is False:
        return False
    if is_js_number(value):
        return not (value == 0 or (isinstance(value, float) and math.isnan(value)))
    if isinstance(value, str):
        return value != ""
    return True


def js_equal(a: object, b: object) -> bool:
    """===. bool 과 number 는 다른 타입이고, number 끼리는 값으로(1 === 1.0), 객체와 배열은 같은 객체일 때만 같다."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if is_js_number(a) and is_js_number(b):
        return a == b
    if isinstance(a, (dict, list)) or isinstance(b, (dict, list)):
        return a is b
    return type(a) is type(b) and a == b


def _is_bmp(text: str) -> bool:
    return all(ord(ch) < 0x10000 for ch in text)


def js_len(text: str) -> int:
    """.length (UTF-16 code unit 수)."""
    return len(text) if _is_bmp(text) else len(text.encode("utf-16-le")) // 2


def js_slice(text: str, end: int) -> str:
    """.slice(0, end) 를 UTF-16 단위로. 짝을 자르게 되면 그 앞까지만 (JS 는 홀로 남은 surrogate 를 두지만 JSON 으로 낼 수 없다)."""
    if _is_bmp(text):
        return text[:end]
    units = text.encode("utf-16-le")[: end * 2]
    return units.decode("utf-16-le", errors="ignore")


def to_fixed(number: float | int, digits: int) -> str:
    """Number.prototype.toFixed: 이진 값 그대로의 십진 전개에서 반올림하되 정확히 반이면 올린다."""
    quantum = Decimal(1).scaleb(-digits)
    return str(Decimal(number).quantize(quantum, rounding=ROUND_HALF_UP))


def _strip_accents(text: str) -> str:
    return "".join(ch for ch in unicodedata.normalize("NFD", text) if not unicodedata.combining(ch))


def locale_key(text: str) -> tuple:
    """String.prototype.localeCompare 의 기본 로케일(ICU root)을 흉내 낸 정렬 키.

    1차: 악센트와 대소문자를 뺀 글자, 2차: 악센트, 3차: 대소문자(소문자가 먼저). 콘솔이 정렬하는 문자열(상태, ID, ISO 시각)은
    모두 ASCII 영숫자라 이 근사로 ICU 와 같은 순서가 나온다.
    """
    base = _strip_accents(text)
    return (base.casefold(), text.casefold() != base.casefold(), tuple(ch.isupper() for ch in base))


def natural_key(text: str) -> tuple:
    """localeCompare(…, undefined, {numeric: true}): 숫자 구간은 수로 비교한다 (general_0_1 < general_10_1)."""
    parts = _DIGIT_RUN_RE.split(text)
    key: list[tuple] = []
    for index, part in enumerate(parts):
        if index % 2 == 1:
            key.append((0, int(part), ()))
        elif part:
            key.append((1, 0, locale_key(part)))
    return tuple(key)


def normalize_numbers(value: Any) -> Any:
    """JSON.stringify 처럼 정수 값의 실수(1.0)를 정수(1)로 바꾼다. 문서를 저장하거나 응답으로 내기 전에 거친다."""
    if isinstance(value, float):
        return int(value) if value.is_integer() and math.isfinite(value) else value
    if isinstance(value, list):
        return [normalize_numbers(v) for v in value]
    if isinstance(value, dict):
        return {k: normalize_numbers(v) for k, v in value.items()}
    return value


def slug(text: str) -> str:
    """text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')."""
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
