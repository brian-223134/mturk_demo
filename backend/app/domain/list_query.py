"""목록 API 의 ListQuery({page, pageSize, sort, filters}) 처리. prototype/src/api/mock/listQuery.ts 와 routes.ts 의
decodeArgs 를 그대로 옮겼다.

query string 에서 읽는 규칙 (routes.ts 의 decodeArgs)
    page=<n>  pageSize=<n>          없으면 1 과 25. 정수가 아니거나 범위 밖이면 400
    sort=<필드>:<asc|desc>          마지막 ':' 에서 나눈다. 방향이 desc 가 아니면 asc. 'stats.total' 처럼 점 경로도 된다
    filters=<JSON 객체>             JSON 이 아니면 400 "Malformed query string (filters must be JSON)."

필터 규칙 (listQuery.ts 의 applyListQuery)
    값이 null, "", [] 이면 필터가 없는 것으로 본다
    custom_filters 에 있는 키는 그 함수가 판정한다 (item, value) → bool
    값이 배열이면 "그중 하나와 === 일치", 아니면 "=== 일치". 필드는 점 경로다
정렬 규칙
    null 과 undefined(없는 필드)는 방향과 무관하게 맨 뒤. number 끼리는 수로, boolean 끼리는 false < true, 그 밖에는
    String() 으로 바꿔 localeCompare 로. 안정 정렬이라 같은 값끼리는 원래 순서를 지킨다
"""

from __future__ import annotations

import json
import math
from typing import Any, Callable, Mapping

from app.domain.js import is_js_integer, is_js_number, js_equal, js_number_of, js_number_to_string, js_string, locale_key
from app.errors import ApiError, invalid

MAX_PAGE_SIZE = 1000
DEFAULT_PAGE = 1
DEFAULT_PAGE_SIZE = 25

CustomFilter = Callable[[Any, Any], bool]


def value_at(item: Any, path: str) -> Any:
    """'stats.rejectRate' 같은 점 경로의 값. 도중에 객체가 아니면 None (undefined)."""
    current = item
    for key in path.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def parse_list_query(params: Mapping[str, str]) -> dict:
    """query string → ListQuery. decodeArgs 와 같이 page, pageSize 는 Number() 로 읽는다 (검증은 apply_list_query 가 한다)."""
    sort_text = params.get("sort")
    separator = sort_text.rfind(":") if sort_text else -1
    sort = None
    if sort_text and separator > 0:
        sort = {"field": sort_text[:separator], "order": "desc" if sort_text[separator + 1:] == "desc" else "asc"}
    filters_text = params.get("filters")
    filters = None
    if filters_text:
        try:
            filters = json.loads(filters_text)
        except ValueError:
            raise invalid("Malformed query string (filters must be JSON).") from None
    return {
        "page": js_number_of(params["page"]) if "page" in params else DEFAULT_PAGE,
        "pageSize": js_number_of(params["pageSize"]) if "pageSize" in params else DEFAULT_PAGE_SIZE,
        "sort": sort,
        "filters": filters,
    }


def _is_empty_filter(value: Any) -> bool:
    return value is None or value == "" or (isinstance(value, list) and len(value) == 0)


def _compare(a: Any, b: Any) -> float:
    if is_js_number(a) and is_js_number(b):
        return a - b
    if isinstance(a, bool) and isinstance(b, bool):
        return int(a) - int(b)
    ka, kb = locale_key(js_string(a)), locale_key(js_string(b))
    return -1 if ka < kb else 1 if ka > kb else 0


def _got(value: Any) -> str:
    return js_number_to_string(value) if is_js_number(value) else js_string(value)


def apply_list_query(items: list, query: Any, custom_filters: dict[str, CustomFilter] | None = None) -> dict:
    """{items, total}. 필터 → 정렬 → 페이지."""
    if not isinstance(query, dict):
        raise ApiError("INVALID_REQUEST", "A list query ({ page, pageSize }) is required.")
    page = query.get("page")
    page_size = query.get("pageSize")
    if not is_js_integer(page) or page < 1:
        raise invalid(f"page must be an integer ≥ 1 (got {_got(page)})")
    if not is_js_integer(page_size) or page_size < 1 or page_size > MAX_PAGE_SIZE:
        raise invalid(f"pageSize must be between 1 and {MAX_PAGE_SIZE} (got {_got(page_size)})")
    page, page_size = int(page), int(page_size)

    result = list(items)
    filters = query.get("filters") or {}
    if not isinstance(filters, dict):
        filters = {}
    custom = custom_filters or {}
    for field, expected in filters.items():
        if _is_empty_filter(expected):
            continue
        if field in custom:
            test = custom[field]
            result = [item for item in result if test(item, expected)]
        elif isinstance(expected, list):
            result = [item for item in result if any(js_equal(value_at(item, field), e) for e in expected)]
        else:
            result = [item for item in result if js_equal(value_at(item, field), expected)]

    sort = query.get("sort")
    if isinstance(sort, dict) and isinstance(sort.get("field"), str):
        direction = -1 if sort.get("order") == "desc" else 1
        field = sort["field"]

        def sort_key(item: Any) -> tuple:
            value = value_at(item, field)
            return (1,) if value is None else (0, _Ordered(value, direction))

        result.sort(key=sort_key)

    start = (page - 1) * page_size
    return {"items": result[start:start + page_size], "total": len(result)}


class _Ordered:
    """정렬 방향을 넣은 비교 래퍼. 값이 섞인 타입이어도 listQuery.ts 의 compare 와 같은 순서를 낸다."""

    __slots__ = ("value", "direction")

    def __init__(self, value: Any, direction: int):
        self.value = value
        self.direction = direction

    def __lt__(self, other: "_Ordered") -> bool:
        delta = _compare(self.value, other.value)
        if isinstance(delta, float) and math.isnan(delta):
            return False
        return self.direction * delta < 0

    def __eq__(self, other: object) -> bool:
        return isinstance(other, _Ordered) and _compare(self.value, other.value) == 0
