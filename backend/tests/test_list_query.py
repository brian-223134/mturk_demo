"""app/domain/list_query.py: ListQuery 의 필터, 정렬, 페이지 처리와 query string 읽기가 프로토타입(listQuery.ts, routes.ts 의
decodeArgs)과 같은지 확인한다.

    필터  값이 배열이면 "그중 하나와 일치", 아니면 "같음". 빈 값(null, "", [])은 필터가 없는 것. custom 필터는 함수가 판정한다
    정렬  null 과 없는 필드는 방향과 무관하게 맨 뒤. number 는 수로, boolean 은 false < true, 문자열은 localeCompare. 안정 정렬
    검증  page 는 정수 ≥ 1, pageSize 는 1 ~ 1000. 아니면 400 INVALID_REQUEST 이고 문구에 받은 값이 들어간다
"""

from __future__ import annotations

import pytest

from app.domain.list_query import apply_list_query, parse_list_query, value_at
from app.errors import ApiError

ITEMS = [
    {"id": "a", "n": 3, "flag": True, "stats": {"rate": 0.5, "total": 3}, "name": "beta"},
    {"id": "b", "n": 1, "flag": False, "stats": {"rate": None, "total": 1}, "name": "Alpha"},
    {"id": "c", "n": 2, "flag": True, "stats": {"total": 2}, "name": "alpha"},
    {"id": "d", "n": 2, "flag": False, "stats": {"rate": 0.25, "total": 2}, "name": "gamma"},
]


def ids(result: dict) -> list[str]:
    return [item["id"] for item in result["items"]]


def test_value_at_dotted_path() -> None:
    assert value_at(ITEMS[0], "stats.rate") == 0.5
    assert value_at(ITEMS[0], "id") == "a"
    assert value_at(ITEMS[2], "stats.rate") is None          # 없는 필드는 undefined
    assert value_at(ITEMS[0], "id.x") is None                # 객체가 아닌 값의 아래는 undefined
    assert value_at(None, "a") is None


def test_pagination_and_total() -> None:
    result = apply_list_query(ITEMS, {"page": 2, "pageSize": 3})
    assert ids(result) == ["d"] and result["total"] == 4
    assert ids(apply_list_query(ITEMS, {"page": 3, "pageSize": 3})) == []
    assert apply_list_query(ITEMS, {"page": 1, "pageSize": 1000})["total"] == 4


def test_filters_equality_membership_empty_and_custom() -> None:
    assert ids(apply_list_query(ITEMS, {"page": 1, "pageSize": 10, "filters": {"n": 2}})) == ["c", "d"]
    assert ids(apply_list_query(ITEMS, {"page": 1, "pageSize": 10, "filters": {"n": [1, 3]}})) == ["a", "b"]
    assert ids(apply_list_query(ITEMS, {"page": 1, "pageSize": 10, "filters": {"stats.total": 2, "flag": True}})) == ["c"]
    assert ids(apply_list_query(ITEMS, {"page": 1, "pageSize": 10, "filters": {"n": None, "id": "", "flag": []}})) == ["a", "b", "c", "d"]
    assert ids(apply_list_query(ITEMS, {"page": 1, "pageSize": 10, "filters": {"flag": 1}})) == []        # 1 === true 는 거짓
    assert ids(apply_list_query(ITEMS, {"page": 1, "pageSize": 10, "filters": {"n": 2.0}})) == ["c", "d"]  # 2 === 2.0
    assert ids(apply_list_query(ITEMS, {"page": 1, "pageSize": 10, "filters": {"stats.rate": None}})) == ["a", "b", "c", "d"]
    custom = {"minTotal": lambda item, value: item["stats"]["total"] >= value}
    assert ids(apply_list_query(ITEMS, {"page": 1, "pageSize": 10, "filters": {"minTotal": 2}}, custom)) == ["a", "c", "d"]
    assert ids(apply_list_query(ITEMS, {"page": 1, "pageSize": 10, "filters": {"minTotal": ""}}, custom)) == ["a", "b", "c", "d"]


def test_sort_numbers_booleans_strings_and_missing_last() -> None:
    assert ids(apply_list_query(ITEMS, {"page": 1, "pageSize": 10, "sort": {"field": "n", "order": "asc"}})) == ["b", "c", "d", "a"]   # 안정: c 가 d 앞
    assert ids(apply_list_query(ITEMS, {"page": 1, "pageSize": 10, "sort": {"field": "n", "order": "desc"}})) == ["a", "c", "d", "b"]
    assert ids(apply_list_query(ITEMS, {"page": 1, "pageSize": 10, "sort": {"field": "flag", "order": "asc"}})) == ["b", "d", "a", "c"]
    assert ids(apply_list_query(ITEMS, {"page": 1, "pageSize": 10, "sort": {"field": "stats.rate", "order": "asc"}})) == ["d", "a", "b", "c"]
    assert ids(apply_list_query(ITEMS, {"page": 1, "pageSize": 10, "sort": {"field": "stats.rate", "order": "desc"}})) == ["a", "d", "b", "c"]
    # localeCompare: 대소문자를 무시한 뒤 소문자가 먼저 (Alpha 와 alpha 는 alpha 가 먼저, 둘 다 beta 앞)
    assert ids(apply_list_query(ITEMS, {"page": 1, "pageSize": 10, "sort": {"field": "name", "order": "asc"}})) == ["c", "b", "a", "d"]
    assert ids(apply_list_query(ITEMS, {"page": 1, "pageSize": 10, "sort": {"field": "nope", "order": "asc"}})) == ["a", "b", "c", "d"]


def test_invalid_queries() -> None:
    with pytest.raises(ApiError) as error:
        apply_list_query(ITEMS, {"page": 0, "pageSize": 10})
    assert error.value.code == "INVALID_REQUEST" and error.value.message == "page must be an integer ≥ 1 (got 0)"
    with pytest.raises(ApiError) as error:
        apply_list_query(ITEMS, {"page": 1, "pageSize": 1001})
    assert error.value.message == "pageSize must be between 1 and 1000 (got 1001)"
    with pytest.raises(ApiError) as error:
        apply_list_query(ITEMS, {"page": 1.5, "pageSize": 10})
    assert error.value.message == "page must be an integer ≥ 1 (got 1.5)"
    with pytest.raises(ApiError) as error:
        apply_list_query(ITEMS, {"page": float("nan"), "pageSize": 10})
    assert error.value.message == "page must be an integer ≥ 1 (got NaN)"
    with pytest.raises(ApiError) as error:
        apply_list_query(ITEMS, None)
    assert error.value.message == "A list query ({ page, pageSize }) is required."
    assert apply_list_query(ITEMS, {"page": 1.0, "pageSize": 10})["total"] == 4      # 1.0 은 정수다


def test_parse_list_query_from_query_string() -> None:
    """decodeArgs: 기본 page 1, pageSize 25. sort 는 마지막 ':' 에서 나누고 desc 가 아니면 asc. filters 는 JSON."""
    assert parse_list_query({}) == {"page": 1, "pageSize": 25, "sort": None, "filters": None}
    assert parse_list_query({"page": "2", "pageSize": "50", "sort": "stats.total:desc", "filters": '{"blocked": true}'}) == {
        "page": 2, "pageSize": 50, "sort": {"field": "stats.total", "order": "desc"}, "filters": {"blocked": True}}
    assert parse_list_query({"sort": "name:up"})["sort"] == {"field": "name", "order": "asc"}
    assert parse_list_query({"sort": "name"})["sort"] is None
    assert parse_list_query({"sort": ":desc"})["sort"] is None
    assert parse_list_query({"page": "abc"})["page"] != parse_list_query({"page": "abc"})["page"]     # NaN
    with pytest.raises(ApiError) as error:
        parse_list_query({"filters": "{broken"})
    assert error.value.message == "Malformed query string (filters must be JSON)."
