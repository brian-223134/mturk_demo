"""원본 데이터 자동 분석. 레코드들을 훑어 경로 패턴별 통계, 이상치, planner용 힌트를 만든다.

경로 패턴은 spec의 경로 언어와 같은 표기를 쓴다. dict의 키는 고정(fixed) 스키마면 이름 그대로 펼치고,
맵(map)이면 {key}로 접는다. 리스트 원소는 [*]로 접되, 길이가 언제나 같고 2~4개인 리스트(라벨과 이유의
쌍 같은 것)는 [0], [1]처럼 위치별로 펼친다.

dict 키 분류 (계약): 같은 패턴의 dict들에서 키 합집합이 24개 이하이고 각 dict가 합집합의 80% 이상을
가지면 fixed, 아니면 map. 여기에 한 가지를 더한다: 키가 두 개 이상이고 숫자를 {n}으로 바꾸면 모두 같은
꼴("Passage {n}")이 되는 dict는 map으로 본다. 레코드마다 passage 수가 같으면 계약 규칙만으로는
'Passage 1'…'Passage 8'이 고정 키가 되어 버려 라벨 경로가 여덟 갈래로 갈라지기 때문이다.

분류는 모든 레코드를 본 뒤에야 정할 수 있으므로 두 번 훑는다. 1차는 컨테이너(dict, 리스트)만 따라가며
원시 경로별 키 합집합·최소 키 수·리스트 길이를 모으고, 그것으로 패턴 트리를 만든다. 2차는 패턴 트리를
따라가며 값의 통계를 모은다. 28MB(레코드 400개, 깊이 6)를 수 초 안에 처리하기 위해 통계는 패턴 노드
객체에 직접 쌓고 경로 문자열은 노드를 만들 때 한 번만 만든다.

이상치 기준의 5%는 레코드가 적을 때 너무 엄격해서(6개 중 1개는 17%) "5% 또는 레코드 2개까지"로 푼다.
"""

from __future__ import annotations

import json
import re
import statistics
from collections import Counter
from pathlib import Path
from typing import Any

from agent import paths, source

FIXED_MAX_KEYS = 24
FIXED_COVERAGE = 0.8
POSITIONAL_MAX = 4
EXAMPLES_MAX = 3
EXAMPLE_CHARS = 120
VALUES_MAX_DISTINCT = 12
VALUES_MIN_COUNT = 20
ANOMALY_RATIO = 0.05
ANOMALY_MIN_RECORDS = 2
OUTLIER_FACTOR = 5
ANOMALY_IDS_MAX = 10
LONG_TEXT_CHARS = 200
SHORT_TEXT_MIN_CHARS = 15
LABEL_MAX_DISTINCT = 6

DIGITS_RE = re.compile(r"\d+")
ID_KEY_RE = re.compile(r"(^|_)(id|key|uid|name)$", re.IGNORECASE)


class _Node:
    """경로 패턴 하나. 자식 노드와 통계를 함께 가진다."""

    __slots__ = ("path", "depth", "dict_kind", "fixed_keys", "list_kind", "children", "map_child", "wild_child",
                 "rank", "present", "types", "type_records", "str_lens", "list_lens", "key_counts", "record_max",
                 "examples", "values", "key_patterns", "key_examples", "missing_records", "parent")

    def __init__(self, path: str, depth: int, parent: _Node | None) -> None:
        self.path = path
        self.depth = depth
        self.parent = parent
        self.dict_kind: str | None = None        # "fixed" | "map"
        self.fixed_keys: set[str] = set()
        self.list_kind: str | None = None        # "positional" | "elements"
        self.children: dict[Any, _Node] = {}     # 고정 키(str) 또는 위치(int) → 자식
        self.map_child: _Node | None = None
        self.wild_child: _Node | None = None
        self.rank = -1                            # 2차 훑기에서 처음 만난 순서
        self.present = 0
        self.types: Counter[str] = Counter()
        self.type_records: dict[str, list[int]] = {}
        self.str_lens: list[int] = []
        self.list_lens: list[int] = []
        self.key_counts: list[int] = []
        self.record_max: dict[str, dict[int, int]] = {}   # 값 타입 → {레코드 index: 그 레코드의 최대 크기}
        self.examples: list[Any] = []
        self.values: dict[Any, int] | None = {}
        self.key_patterns: Counter[str] = Counter()
        self.key_examples: list[str] = []
        self.missing_records: dict[str, list[int]] = {}

    def fixed_child(self, key: str) -> _Node:
        child = self.children.get(key)
        if child is None:
            child = _Node(self.path + paths.format_key(key), self.depth + 1, self)
            self.children[key] = child
        return child

    def positional_child(self, index: int) -> _Node:
        child = self.children.get(index)
        if child is None:
            child = _Node(f"{self.path}[{index}]", self.depth + 1, self)
            self.children[index] = child
        return child

    def get_map_child(self) -> _Node:
        if self.map_child is None:
            self.map_child = _Node(self.path + ".{key}", self.depth + 1, self)
        return self.map_child

    def get_wild_child(self) -> _Node:
        if self.wild_child is None:
            self.wild_child = _Node(self.path + "[*]", self.depth + 1, self)
        return self.wild_child

    def all_children(self) -> list[_Node]:
        nodes = list(self.children.values())
        if self.map_child is not None:
            nodes.append(self.map_child)
        if self.wild_child is not None:
            nodes.append(self.wild_child)
        return nodes


# ----------------------------------------------------------------------------------------------
# 1차: 컨테이너 모양 수집과 패턴 트리
# ----------------------------------------------------------------------------------------------


def _collect_shapes(records: list[Any]) -> tuple[dict[tuple, list], dict[tuple, list]]:
    """원시 경로별로 dict의 [키 합집합, 최소 키 수]와 리스트의 [최소 길이, 최대 길이]를 모은다.

    원시 경로의 세그먼트는 ("k", 키) 또는 ("i", 위치). 원소가 4개 이하인 리스트만 위치를 남기고
    그보다 길면 ("i", None)으로 접는다."""
    dict_shapes: dict[tuple, list] = {}
    list_shapes: dict[tuple, list] = {}

    def visit(value: Any, raw: tuple) -> None:
        if isinstance(value, dict):
            shape = dict_shapes.get(raw)
            if shape is None:
                dict_shapes[raw] = [set(value), len(value)]
            else:
                shape[0].update(value)
                if len(value) < shape[1]:
                    shape[1] = len(value)
            for key, child in value.items():
                if isinstance(child, (dict, list)):
                    visit(child, raw + (("k", key),))
        elif isinstance(value, list):
            n = len(value)
            shape = list_shapes.get(raw)
            if shape is None:
                list_shapes[raw] = [n, n]
            else:
                if n < shape[0]:
                    shape[0] = n
                if n > shape[1]:
                    shape[1] = n
            small = n <= POSITIONAL_MAX
            for index, child in enumerate(value):
                if isinstance(child, (dict, list)):
                    visit(child, raw + (("i", index if small else None),))

    for record in records:
        visit(record, ())
    return dict_shapes, list_shapes


def _classify_dict(union: set, min_keys: int, root: bool) -> str:
    if root:
        return "fixed"
    if len(union) >= 2 and all(isinstance(key, str) for key in union):
        patterns = {DIGITS_RE.sub("{n}", key) for key in union}
        if len(patterns) == 1 and "{n}" in next(iter(patterns)):
            return "map"
    if len(union) <= FIXED_MAX_KEYS and min_keys >= FIXED_COVERAGE * len(union):
        return "fixed"
    return "map"


def _build_tree(dict_shapes: dict[tuple, list], list_shapes: dict[tuple, list]) -> _Node:
    """원시 경로를 깊이 순서로 패턴에 배정하고, 패턴마다 dict/list 분류를 정한다."""
    root = _Node("$", 0, None)
    nodes: dict[tuple, _Node] = {(): root}
    pattern_of: dict[tuple, tuple] = {(): ()}

    def resolve(raw: tuple) -> tuple:
        known = pattern_of.get(raw)
        if known is not None:
            return known
        parent = resolve(raw[:-1])
        parent_node = nodes[parent]
        tag, value = raw[-1]
        if tag == "k":
            if parent_node.dict_kind == "fixed":
                pattern = parent + (("k", value),)
                node = nodes.get(pattern)
                if node is None:
                    node = parent_node.fixed_child(value)
            else:
                pattern = parent + (("m",),)
                node = parent_node.get_map_child()
        else:
            if parent_node.list_kind == "positional" and value is not None:
                pattern = parent + (("i", value),)
                node = parent_node.positional_child(value)
            else:
                pattern = parent + (("w",),)
                node = parent_node.get_wild_child()
        nodes[pattern] = node
        pattern_of[raw] = pattern
        return pattern

    by_depth: dict[int, list[tuple]] = {}
    for raw in list(dict_shapes) + list(list_shapes):
        by_depth.setdefault(len(raw), []).append(raw)
    for depth in sorted(by_depth):
        merged_dicts: dict[tuple, list] = {}
        merged_lists: dict[tuple, list] = {}
        for raw in by_depth[depth]:
            pattern = resolve(raw)
            shape = dict_shapes.get(raw)
            if shape is not None:
                merged = merged_dicts.get(pattern)
                if merged is None:
                    merged_dicts[pattern] = [set(shape[0]), shape[1]]
                else:
                    merged[0].update(shape[0])
                    merged[1] = min(merged[1], shape[1])
            shape = list_shapes.get(raw)
            if shape is not None:
                merged = merged_lists.get(pattern)
                if merged is None:
                    merged_lists[pattern] = list(shape)
                else:
                    merged[0] = min(merged[0], shape[0])
                    merged[1] = max(merged[1], shape[1])
        for pattern, (union, min_keys) in merged_dicts.items():
            node = nodes[pattern]
            node.dict_kind = _classify_dict(union, min_keys, root=pattern == ())
            if node.dict_kind == "fixed":
                node.fixed_keys = set(union)
        for pattern, (low, high) in merged_lists.items():
            node = nodes[pattern]
            node.list_kind = "positional" if low == high and 2 <= low <= POSITIONAL_MAX else "elements"
    return root


# ----------------------------------------------------------------------------------------------
# 2차: 통계 수집
# ----------------------------------------------------------------------------------------------


class _Walker:
    def __init__(self) -> None:
        self.counter = 0

    def walk(self, value: Any, node: _Node, record_index: int) -> None:
        if node.present == 0:
            node.rank = self.counter
            self.counter += 1
        node.present += 1
        if isinstance(value, str):
            kind = "str"
            n = len(value)
            node.str_lens.append(n)
            self._record_size(node, "str", record_index, n)
            self._example(node, value)
            self._value(node, value)
        elif isinstance(value, dict):
            kind = "dict"
            n = len(value)
            node.key_counts.append(n)
            self._record_size(node, "dict", record_index, n)
            if node.dict_kind == "map":
                child = node.get_map_child()
                for key, item in value.items():
                    if isinstance(key, str):
                        node.key_patterns[DIGITS_RE.sub("{n}", key)] += 1
                        if len(node.key_examples) < EXAMPLES_MAX and key not in node.key_examples:
                            node.key_examples.append(key)
                    self.walk(item, child, record_index)
            else:
                for key, item in value.items():
                    self.walk(item, node.fixed_child(key), record_index)
                if n < len(node.fixed_keys):
                    for key in node.fixed_keys:
                        if key not in value:
                            self._note(node.missing_records.setdefault(key, []), record_index)
        elif isinstance(value, list):
            kind = "list"
            n = len(value)
            node.list_lens.append(n)
            self._record_size(node, "list", record_index, n)
            if node.list_kind == "positional":
                for index, item in enumerate(value):
                    self.walk(item, node.positional_child(index), record_index)
            else:
                child = node.get_wild_child()
                for item in value:
                    self.walk(item, child, record_index)
        elif value is None:
            kind = "null"
        elif isinstance(value, bool):
            kind = "bool"
            self._example(node, value)
            self._value(node, value)
        elif isinstance(value, int):
            kind = "int"
            self._example(node, value)
            self._value(node, value)
        elif isinstance(value, float):
            kind = "float"
            self._example(node, value)
        else:
            kind = type(value).__name__
        node.types[kind] += 1
        records = node.type_records.get(kind)
        if records is None:
            node.type_records[kind] = [record_index]
        else:
            self._note(records, record_index)

    @staticmethod
    def _note(records: list[int], record_index: int) -> None:
        if len(records) < ANOMALY_IDS_MAX and (not records or records[-1] != record_index):
            records.append(record_index)

    @staticmethod
    def _record_size(node: _Node, kind: str, record_index: int, size: int) -> None:
        sizes = node.record_max.get(kind)
        if sizes is None:
            node.record_max[kind] = {record_index: size}
            return
        previous = sizes.get(record_index)
        if previous is None or size > previous:
            sizes[record_index] = size

    @staticmethod
    def _example(node: _Node, value: Any) -> None:
        if len(node.examples) < EXAMPLES_MAX:
            shown = value[:EXAMPLE_CHARS] if isinstance(value, str) else value
            if shown not in node.examples:
                node.examples.append(shown)

    @staticmethod
    def _value(node: _Node, value: Any) -> None:
        values = node.values
        if values is None:
            return
        count = values.get(value)
        if count is not None:
            values[value] = count + 1
        elif len(values) < VALUES_MAX_DISTINCT:
            values[value] = 1
        else:
            node.values = None


# ----------------------------------------------------------------------------------------------
# 결과 조립
# ----------------------------------------------------------------------------------------------


def _ordered_nodes(root: _Node) -> list[_Node]:
    """2차 훑기에서 처음 만난 순서(레코드 안의 등장 순서)로 노드를 편다."""
    out: list[_Node] = []

    def visit(node: _Node) -> None:
        if node.present == 0:
            return
        out.append(node)
        for child in sorted(node.all_children(), key=lambda n: n.rank):
            visit(child)

    visit(root)
    return out


def _size_stats(values: list[int]) -> dict[str, int | float]:
    median = statistics.median(values)
    if isinstance(median, float) and median.is_integer():
        median = int(median)
    return {"min": min(values), "median": median, "max": max(values)}


def _path_entry(node: _Node) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "path": node.path,
        "types": dict(sorted(node.types.items(), key=lambda kv: (-kv[1], kv[0]))),
        "present": node.present,
    }
    if node.str_lens:
        entry["str_len"] = _size_stats(node.str_lens)
    if node.list_lens:
        entry["list_len"] = _size_stats(node.list_lens)
    if node.key_counts:
        keys: dict[str, Any] = {"kind": node.dict_kind, "count": _size_stats(node.key_counts)}
        if node.dict_kind == "map":
            pattern = _dominant_pattern(node.key_patterns)
            if pattern:
                keys["pattern"] = pattern
            keys["examples"] = list(node.key_examples)
        else:
            keys["names"] = sorted(node.fixed_keys, key=lambda k: node.children[k].rank if k in node.children else 1 << 30)
        entry["keys"] = keys
    if node.examples:
        entry["examples"] = list(node.examples)
    countable = node.types["str"] + node.types["int"] + node.types["bool"]
    if node.values is not None and node.values and countable >= VALUES_MIN_COUNT:
        entry["values"] = {str(value): count for value, count in
                           sorted(node.values.items(), key=lambda kv: (-kv[1], str(kv[0])))}
    return entry


def _anomaly_limit(total: int) -> int:
    return max(ANOMALY_MIN_RECORDS, int(total * ANOMALY_RATIO))


def _anomalies(nodes: list[_Node], record_ids: list[str], record_count: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for node in nodes:
        if len(node.types) >= 2:
            majority = node.types.most_common(1)[0][0]
            limit = _anomaly_limit(node.present)
            for kind, count in node.types.most_common():
                if kind == majority or count > limit:
                    continue
                out.append({"path": node.path, "kind": "type_mismatch", "majority": majority, "found": kind,
                            "count": count, "record_ids": [record_ids[i] for i in node.type_records.get(kind, [])]})
        if node.dict_kind == "fixed" and node.missing_records:
            expected = node.types["dict"]
            limit = _anomaly_limit(expected)
            for key in sorted(node.missing_records, key=lambda k: node.children[k].rank if k in node.children else 1 << 30):
                child = node.children.get(key)
                if child is None:
                    continue
                missing = expected - child.present
                if 0 < missing <= limit:
                    out.append({"path": child.path, "kind": "missing", "count": missing,
                                "record_ids": [record_ids[i] for i in node.missing_records[key]]})
        outlier = _size_outlier(node, record_ids)
        if outlier is not None:
            out.append(outlier)
    return out


def _size_outlier(node: _Node, record_ids: list[str]) -> dict[str, Any] | None:
    """다수 타입의 크기(문자열 길이·리스트 길이·키 수)가 다른 레코드들의 최대치의 5배 이상인 레코드."""
    majority = node.types.most_common(1)[0][0]
    per_record = node.record_max.get(majority)
    if not per_record:
        return None
    sizes = sorted(per_record.items(), key=lambda kv: -kv[1])
    n = len(sizes)
    if n < 4:
        return None
    limit = min(_anomaly_limit(n), n - 3)
    for k in range(1, limit + 1):
        typical_max = sizes[k][1]
        if typical_max > 0 and sizes[k - 1][1] >= OUTLIER_FACTOR * typical_max:
            stat = {"dict": "keys", "list": "list_len"}.get(majority, "str_len")
            return {"path": node.path, "kind": "size_outlier", "stat": stat, "value": sizes[0][1],
                    "typical_max": typical_max,
                    "record_ids": [record_ids[index] for index, _ in sizes[:k][:ANOMALY_IDS_MAX]]}
    return None


def _guess_record_id(root: _Node, records: list[Any]) -> tuple[str | None, list[str]]:
    """문자열 값이 전부 유일한 최상위 키를 찾는다. 이름에 id가 들어간 키를 우선한다."""
    candidates = []
    for key, child in sorted(root.children.items(), key=lambda kv: kv[1].rank):
        if not isinstance(key, str) or child.present != len(records) or child.types.get("str") != len(records):
            continue
        values = [record.get(key) for record in records]
        if len(set(values)) == len(values):
            candidates.append((0 if ID_KEY_RE.search(key) else 1, key, values))
    if not candidates:
        return None, [f"r{i + 1}" for i in range(len(records))]
    candidates.sort(key=lambda c: c[0])
    _, key, values = candidates[0]
    return "$" + paths.format_key(key), [str(v) for v in values]


def _dominant_pattern(patterns: Counter[str]) -> str | None:
    """키의 숫자 부분을 {n}으로 바꾼 패턴 가운데 절반 이상을 차지하는 것. 숫자가 없는 키(질문 본문 같은 자유 텍스트)는 패턴이 아니다."""
    if not patterns:
        return None
    pattern, count = patterns.most_common(1)[0]
    if "{n}" not in pattern or count * 2 < sum(patterns.values()):
        return None
    return pattern


def _map_key_patterns(node: _Node) -> list[str]:
    """경로의 조상 중 map인 dict들의 키 패턴 (겉에서 안쪽 순서)."""
    patterns = []
    current = node
    while current is not None:
        if current.dict_kind == "map" and current.map_child is not None:
            pattern = _dominant_pattern(current.key_patterns)
            if pattern:
                patterns.append(pattern)
        current = current.parent
    return list(reversed(patterns))


def _container_note(node: _Node) -> str:
    """리스트 원소나 맵 값이면 어떤 컨테이너를 돌면 되는지 덧붙인다."""
    parent = node.parent
    if parent is None:
        return ""
    if node is parent.wild_child and parent.list_lens:
        return f" in a list (median {_size_stats(parent.list_lens)['median']} per record); iterate over {parent.path}"
    if node is parent.map_child and parent.key_counts:
        pattern = _dominant_pattern(parent.key_patterns) or "{key}"
        return f" in a map keyed '{pattern}' (median {_size_stats(parent.key_counts)['median']} per record); iterate over {parent.path}"
    return ""


def _hints(nodes: list[_Node], record_id_path: str | None, anomalies: list[dict[str, Any]]) -> list[str]:
    hints: list[str] = []
    if record_id_path:
        hints.append(f"{record_id_path} looks like a record id (unique string).")
    for node in nodes:
        if node.types.most_common(1)[0][0] != "str" or not node.str_lens:
            continue
        median = _size_stats(node.str_lens)["median"]
        parent = node.parent
        in_container = parent is not None and (node is parent.wild_child or node is parent.map_child)
        if node.values is not None and 2 <= len(node.values) <= LABEL_MAX_DISTINCT and node.present >= VALUES_MIN_COUNT:
            shown = ", ".join(f"{value} {count}" for value, count in
                              sorted(node.values.items(), key=lambda kv: -kv[1]))
            text = f"{node.path} takes {len(node.values)} values ({shown}): candidate LLM label for hints."
            patterns = _map_key_patterns(node)
            if patterns:
                text += " Map keys along this path: " + ", ".join(f"'{p}'" for p in patterns) + "."
            hints.append(text)
        elif median >= LONG_TEXT_CHARS:
            hints.append(f"{node.path} holds long texts (median {median} chars){_container_note(node)}: candidate context field.")
        elif in_container and median >= SHORT_TEXT_MIN_CHARS:
            hints.append(f"{node.path} holds short sentences{_container_note(node)}: candidate target list.")
    for anomaly in anomalies:
        ids = ", ".join(anomaly["record_ids"][:3])
        if anomaly["kind"] == "type_mismatch":
            hints.append(f"{anomaly['path']} is {anomaly['found']} in {anomaly['count']} record(s) ({ids}) but "
                         f"{anomaly['majority']} elsewhere; a spec using it should expect the {anomaly['majority']} form.")
        elif anomaly["kind"] == "missing":
            hints.append(f"{anomaly['path']} is missing in {anomaly['count']} record(s) ({ids}).")
        else:
            hints.append(f"{anomaly['path']} has an unusually large {anomaly['stat']} ({anomaly['value']} vs typical "
                         f"max {anomaly['typical_max']}) in {len(anomaly['record_ids'])} record(s) ({ids}).")
    return hints


def profile_records(records: list[Any], record_id_path: str | None = None) -> dict:
    """레코드 리스트를 분석한 profile dict. source 항목은 레코드 수만 넣는다 (run_profile이 채운다)."""
    dict_shapes, list_shapes = _collect_shapes(records)
    root = _build_tree(dict_shapes, list_shapes)
    walker = _Walker()
    for index, record in enumerate(records):
        walker.walk(record, root, index)
    nodes = _ordered_nodes(root)

    record_id: dict[str, Any] | None
    if record_id_path:
        raw_ids = [paths.evaluate(record_id_path, record) for record in records]
        usable = all(isinstance(v, (str, int)) and not isinstance(v, bool) for v in raw_ids)
        ids = [str(v) if usable else f"r{i + 1}" for i, v in enumerate(raw_ids)]
        record_id = {"path": record_id_path, "unique": usable and len(set(ids)) == len(ids)}
    else:
        guessed, ids = _guess_record_id(root, records)
        record_id = {"path": guessed, "unique": True} if guessed else None

    anomalies = _anomalies(nodes, ids, len(records))
    return {
        "source": {"records": len(records)},
        "record_id": record_id,
        "paths": [_path_entry(node) for node in nodes],
        "anomalies": anomalies,
        "hints": _hints(nodes, record_id["path"] if record_id else None, anomalies),
    }


# ----------------------------------------------------------------------------------------------
# 출력
# ----------------------------------------------------------------------------------------------


def _cell(text: Any, limit: int = 60) -> str:
    shown = str(text).replace("\n", " ").replace("|", "\\|")
    return shown if len(shown) <= limit else shown[: limit - 1] + "…"


def _size_text(entry: dict[str, Any]) -> str:
    parts = []
    for key, label in (("str_len", "chars"), ("list_len", "items"), ("keys", "keys")):
        if key in entry:
            stats = entry[key]["count"] if key == "keys" else entry[key]
            text = f"{stats['min']}/{stats['median']}/{stats['max']} {label}"
            if key == "keys":
                text += f" ({entry['keys']['kind']}"
                if entry["keys"].get("pattern"):
                    text += f", '{entry['keys']['pattern']}'"
                text += ")"
            parts.append(text)
    return "; ".join(parts)


def profile_to_markdown(profile: dict) -> str:
    """사람이 읽는 profile.md."""
    src = profile.get("source", {})
    lines = [f"# Data profile: {src.get('path', '(records)')}", ""]
    meta = [f"records: {src.get('records')}"]
    if src.get("format"):
        meta.append(f"format: {src['format']}")
    if src.get("bytes") is not None:
        meta.append(f"size: {src['bytes']:,} bytes")
    lines.append("- " + ", ".join(meta))
    record_id = profile.get("record_id")
    if record_id:
        lines.append(f"- record id: `{record_id['path']}` ({'unique' if record_id.get('unique') else 'not unique'})")
    else:
        lines.append("- record id: none found (records are numbered r1, r2, …)")
    lines += ["", "## Paths", "", "| path | types | present | size (min/median/max) | examples or values |",
              "| --- | --- | --- | --- | --- |"]
    for entry in profile.get("paths", []):
        types = ", ".join(f"{k} {v}" for k, v in entry["types"].items())
        if "values" in entry:
            sample = "values: " + ", ".join(f"{_cell(k, 20)} {v}" for k, v in entry["values"].items())
        elif "examples" in entry:
            sample = "; ".join(_cell(e) for e in entry["examples"])
        elif entry.get("keys", {}).get("examples"):
            sample = "keys: " + ", ".join(_cell(k, 30) for k in entry["keys"]["examples"])
        else:
            sample = ""
        lines.append(f"| `{_cell(entry['path'], 200)}` | {types} | {entry['present']} | {_size_text(entry)} | {sample} |")
    lines += ["", "## Anomalies", ""]
    anomalies = profile.get("anomalies", [])
    if not anomalies:
        lines.append("- none")
    for anomaly in anomalies:
        ids = ", ".join(anomaly.get("record_ids", []))
        if anomaly["kind"] == "type_mismatch":
            detail = f"majority {anomaly['majority']}, found {anomaly['found']} in {anomaly['count']} record(s)"
        elif anomaly["kind"] == "missing":
            detail = f"missing in {anomaly['count']} record(s)"
        else:
            detail = f"{anomaly['stat']} {anomaly['value']} vs typical max {anomaly['typical_max']}"
        lines.append(f"- `{anomaly['path']}`: {anomaly['kind']} — {detail} ({ids})")
    lines += ["", "## Hints", ""]
    hints = profile.get("hints", [])
    if not hints:
        lines.append("- none")
    lines += [f"- {hint}" for hint in hints]
    return "\n".join(lines) + "\n"


def _path_depth(path: str) -> int:
    try:
        return len(paths.parse(path.replace(".{key}", ".__key__"))) - 1
    except paths.PathError:
        return path.count(".") + path.count("[")


def profile_for_prompt(profile: dict, max_chars: int = 12000) -> dict:
    """프롬프트에 넣을 크기로 줄인 profile. 예시를 줄이고, 그래도 크면 깊은 경로부터 잘라 낸다."""
    small = json.loads(json.dumps(profile, ensure_ascii=False))
    small.pop("source", None)

    def shrink_examples(count: int, chars: int) -> None:
        for entry in small["paths"]:
            if "examples" in entry:
                entry["examples"] = [e[:chars] if isinstance(e, str) else e for e in entry["examples"][:count]]
                if not entry["examples"]:
                    del entry["examples"]
            if entry.get("keys", {}).get("examples"):
                entry["keys"]["examples"] = entry["keys"]["examples"][:count]
            if entry.get("keys", {}).get("names") and len(entry["keys"]["names"]) > 12:
                entry["keys"]["names"] = entry["keys"]["names"][:12]
        for anomaly in small["anomalies"]:
            anomaly["record_ids"] = anomaly["record_ids"][:3]

    def size() -> int:
        return len(json.dumps(small, ensure_ascii=False))

    shrink_examples(2, 80)
    if size() <= max_chars:
        return small
    shrink_examples(1, 60)
    depths = [_path_depth(entry["path"]) for entry in small["paths"]]
    max_depth = max(depths) if depths else 0
    dropped = 0
    # 깊은 경로부터 잘라 내되, 값 분포가 있는 경로(라벨 후보)는 깊어도 남긴다
    while size() > max_chars and max_depth > 1:
        max_depth -= 1
        pairs = [(entry, depth) for entry, depth in zip(small["paths"], depths)
                 if depth <= max_depth or "values" in entry]
        dropped += len(small["paths"]) - len(pairs)
        small["paths"] = [entry for entry, _ in pairs]
        depths = [depth for _, depth in pairs]
        small["truncated"] = {"paths_dropped": dropped, "max_depth": max_depth,
                              "note": "paths deeper than max_depth were dropped unless they carry a values histogram"}
    if size() > max_chars:
        shrink_examples(0, 0)
        small["hints"] = small["hints"][:12]
    return small


def run_profile(raw_path: Path, out_dir: Path, format: str | None = None) -> dict:
    """원본을 읽어 profile.json과 profile.md를 out_dir에 저장하고 profile을 돌려준다."""
    raw_path = Path(raw_path)
    out_dir = Path(out_dir)
    detected, records = source.load_records(raw_path, format)
    profile = profile_records(records)
    profile["source"] = {"path": raw_path.name, "format": detected, "records": len(records),
                         "bytes": raw_path.stat().st_size}
    out_dir.mkdir(parents=True, exist_ok=True)
    with (out_dir / "profile.json").open("w", encoding="utf-8") as handle:
        json.dump(profile, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    (out_dir / "profile.md").write_text(profile_to_markdown(profile), encoding="utf-8")
    return profile
