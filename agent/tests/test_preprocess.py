"""preprocess 모듈: 항목·HIT 개수, 결정성, attention 삽입, 답 이름, JSON 셀, 샘플, 전략과 group_by."""

import copy
import csv
import json
import random
import tempfile
import unittest
from pathlib import Path

from agent import preprocess, source, spec

EXAMPLE_DIR = Path(__file__).resolve().parent.parent / "examples" / "groundedness"


def load_example():
    parsed = spec.load_spec(EXAMPLE_DIR / "task_spec.json")
    _, records = source.load_records(EXAMPLE_DIR / "raw.json")
    return parsed, records


def variant(base: spec.TaskSpec, mutate) -> spec.TaskSpec:
    """spec dict를 고쳐 다시 파싱한다."""
    data = copy.deepcopy(spec.spec_to_dict(base))
    mutate(data)
    return spec.parse_spec(data)


class BuildItemsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spec, cls.records = load_example()

    def test_counts(self):
        items, stats = preprocess.build_items(self.spec, self.records)
        self.assertEqual(len(items), 24)  # 레코드 6개 × passage 4개
        self.assertEqual(stats["records"], {"total": 6, "filtered": 6, "sampled": 6, "used": 6})
        self.assertEqual(stats["items"], 24)
        self.assertEqual(stats["skipped_no_targets"], 0)
        first = items[0]
        self.assertEqual((first.record_index, first.record_id, first.item_id, first.is_attention), (0, "r001", "r001#passage=0", False))
        self.assertEqual(set(first.fields), {"question", "passage", "facts"})
        self.assertEqual(first.fields["facts"], first.targets)
        self.assertEqual(len(first.targets), 2)
        self.assertEqual(first.hints, ["not_grounded", "not_grounded"])
        self.assertTrue(all(isinstance(reason, str) and reason for reason in first.reasons))
        self.assertIsNone(first.expected_value)
        # hint가 같은 대상을 가리킨다: 두 번째 passage의 라벨은 Yes/Yes
        self.assertEqual(items[1].hints, ["grounded", "grounded"])

    def test_hint_missing_becomes_none(self):
        no_yes = variant(self.spec, lambda d: d["item"]["hint"]["map"].pop("Yes"))
        items, _ = preprocess.build_items(no_yes, self.records)
        self.assertEqual(items[1].hints, [None, None])
        self.assertEqual(items[0].hints, ["not_grounded", "not_grounded"])

    def test_skip_if_no_targets(self):
        records = copy.deepcopy(self.records)
        records[2]["facts"]["model_a"] = {}
        items, stats = preprocess.build_items(self.spec, records)
        self.assertEqual(len(items), 20)
        self.assertEqual(stats["skipped_no_targets"], 4)
        self.assertNotIn(2, {item.record_index for item in items})
        strict = variant(self.spec, lambda d: d["item"].__setitem__("skip_if_no_targets", False))
        with self.assertRaisesRegex(spec.SpecError, "no targets in record 'r003'"):
            preprocess.build_items(strict, records)

    def test_missing_context_field_is_an_error(self):
        records = copy.deepcopy(self.records)
        del records[1]["question"]
        with self.assertRaisesRegex(spec.SpecError, r"\$\.item\.fields\.question\.path: .* does not resolve in record 'r002'"):
            preprocess.build_items(self.spec, records)

    def test_sampling_with_seed_keeps_order(self):
        sampled = variant(self.spec, lambda d: d["source"].__setitem__("sample", {"n": 3, "seed": 1}))
        items, stats = preprocess.build_items(sampled, self.records)
        used = []
        for item in items:
            if item.record_id not in used:
                used.append(item.record_id)
        expected = [self.records[i]["id"] for i in sorted(random.Random(1).sample(range(6), 3))]
        self.assertEqual(used, expected)
        self.assertEqual(stats["records"], {"total": 6, "filtered": 6, "sampled": 3, "used": 3})
        # record_index는 쓰는 목록 안의 위치다
        self.assertEqual(sorted({item.record_index for item in items}), [0, 1, 2])
        again, _ = preprocess.build_items(sampled, self.records)
        self.assertEqual(again, items)

    def test_filter_then_limit(self):
        def mutate(d):
            d["source"]["filter"] = {"path": "$.facts.model_a['Fact 2']", "exists": True}
            d["source"]["limit"] = 2
        filtered = variant(self.spec, mutate)
        items, stats = preprocess.build_items(filtered, self.records)
        self.assertEqual(stats["records"], {"total": 6, "filtered": 4, "sampled": 4, "used": 2})
        self.assertEqual(sorted({item.record_id for item in items}), ["r001", "r003"])


class GroupHitsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spec, cls.records = load_example()
        cls.items, _ = preprocess.build_items(cls.spec, cls.records)
        cls.hits = preprocess.group_hits(cls.spec, cls.items)

    def test_hit_shape(self):
        self.assertEqual(len(self.hits), 6)
        for hit in self.hits:
            self.assertEqual(len(hit), 5)
            self.assertEqual(sum(item.is_attention for item in hit), 1)
            self.assertEqual(len({item.record_id for item in hit if not item.is_attention}), 1)

    def test_attention_is_a_swapped_copy_of_the_first_item(self):
        by_record = {}
        for item in self.items:
            by_record.setdefault(item.record_index, []).append(item)
        for hit in self.hits:
            general = [item for item in hit if not item.is_attention]
            base = general[0]
            attention = next(item for item in hit if item.is_attention)
            self.assertEqual((attention.record_id, attention.item_id, attention.expected_value), ("attention", "attention", "not_grounded"))
            self.assertEqual(attention.record_index, base.record_index)
            other = by_record[(base.record_index + 3) % 6][0]
            self.assertEqual(attention.fields["question"], other.fields["question"])
            self.assertEqual(attention.fields["passage"], other.fields["passage"])
            self.assertNotEqual(attention.fields["question"], base.fields["question"])
            self.assertEqual(attention.targets, base.targets[:2])
            self.assertEqual(attention.fields["facts"], attention.targets)
            self.assertEqual(attention.hints, ["not_grounded"] * len(attention.targets))
            self.assertEqual(attention.reasons, [None] * len(attention.targets))

    def test_random_position_is_seeded(self):
        positions = [next(i for i, item in enumerate(hit) if item.is_attention) for hit in self.hits]
        expected = [random.Random(42 + hit_index).randint(0, 4) for hit_index in range(6)]
        self.assertEqual(positions, expected)
        again = preprocess.group_hits(self.spec, self.items)
        self.assertEqual(again, self.hits)

    def test_first_and_last_positions(self):
        for position, index in (("first", 0), ("last", 4)):
            variant_spec = variant(self.spec, lambda d, p=position: d["hit"]["attention"].__setitem__("position", p))
            hits = preprocess.group_hits(variant_spec, self.items)
            self.assertTrue(all(hit[index].is_attention for hit in hits))

    def test_per_hit_two_uses_growing_distance(self):
        two = variant(self.spec, lambda d: d["hit"]["attention"].update({"per_hit": 2, "position": "first"}))
        hits = preprocess.group_hits(two, self.items)
        by_record = {}
        for item in self.items:
            by_record.setdefault(item.record_index, []).append(item)
        for hit in hits:
            self.assertEqual(len(hit), 6)
            self.assertTrue(hit[0].is_attention and hit[1].is_attention)
            base = hit[2]
            first_other = (base.record_index + 3) % 6
            second_other = (base.record_index + 6) % 6
            if second_other == base.record_index:
                second_other = (base.record_index + 1) % 6
            self.assertEqual(hit[0].fields["passage"], by_record[first_other][0].fields["passage"])
            self.assertEqual(hit[1].fields["passage"], by_record[second_other][0].fields["passage"])

    def test_no_attention(self):
        plain = variant(self.spec, lambda d: d["hit"].__setitem__("attention", None))
        hits = preprocess.group_hits(plain, self.items)
        self.assertEqual([len(hit) for hit in hits], [4] * 6)
        self.assertFalse(any(item.is_attention for hit in hits for item in hit))

    def test_instruction_strategy(self):
        def mutate(d):
            d["hit"]["attention"].update({"strategy": "instruction", "mismatch": None, "position": "last",
                                          "instruction": {"text": "This is an attention check. Please choose \"Not supported\"."}})
        instruction = variant(self.spec, mutate)
        hits = preprocess.group_hits(instruction, self.items)
        for hit in hits:
            attention = hit[-1]
            self.assertTrue(attention.is_attention)
            self.assertEqual(attention.targets, ["This is an attention check. Please choose \"Not supported\"."])
            self.assertEqual(attention.fields["facts"], attention.targets)
            self.assertEqual(attention.fields["question"], hit[0].fields["question"])
            self.assertEqual(attention.fields["passage"], hit[0].fields["passage"])
            self.assertEqual(attention.hints, ["not_grounded"])

    def test_group_by_sequential(self):
        sequential = variant(self.spec, lambda d: d["hit"].update({"items_per_hit": 5, "group_by": "sequential"}))
        hits = preprocess.group_hits(sequential, self.items)
        self.assertEqual([len(hit) for hit in hits], [6, 6, 6, 6, 5])
        general = [item for hit in hits for item in hit if not item.is_attention]
        self.assertEqual(general, self.items)
        self.assertEqual(len({item.record_id for item in hits[0] if not item.is_attention}), 2)

    def test_mismatch_needs_two_records(self):
        items = [item for item in self.items if item.record_index == 0]
        with self.assertRaisesRegex(spec.SpecError, "at least 2 records"):
            preprocess.group_hits(self.spec, items)


class RowsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spec, cls.records = load_example()
        cls.items, _ = preprocess.build_items(cls.spec, cls.records)
        cls.hits = preprocess.group_hits(cls.spec, cls.items)
        cls.columns, cls.rows = preprocess.hit_rows(cls.spec, cls.hits)

    def test_answer_name(self):
        self.assertEqual(preprocess.answer_name(False, 0, 1, ""), "general_0_1")
        self.assertEqual(preprocess.answer_name(True, 3, 1, ""), "attention_3_1")
        self.assertEqual(preprocess.answer_name(False, 10, 12, "_coverage"), "general_10_12_coverage")

    def test_json_cell(self):
        text = "a<b\u2028c\u2029d</script><!--"
        cell = preprocess.json_cell({"k": [text, 1, True, None]})
        self.assertNotIn("<", cell)
        self.assertNotIn("\u2028", cell)
        self.assertNotIn("\u2029", cell)
        self.assertNotIn(" ", cell.replace(text.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"), ""))
        self.assertEqual(json.loads(cell), {"k": [text, 1, True, None]})
        self.assertEqual(preprocess.json_cell("한글"), '"한글"')

    def test_columns_and_cells(self):
        self.assertEqual(self.columns, ["hit_id", "record_ids", "item_ids", "attention", "question", "passage", "facts", "llm_label", "llm_reason"])
        self.assertEqual(len(self.rows), 6)
        row = self.rows[0]
        self.assertEqual(set(row), set(self.columns))
        self.assertEqual(json.loads(row["hit_id"]), "hit-0001")
        self.assertEqual(json.loads(self.rows[-1]["hit_id"]), "hit-0006")
        flags = json.loads(row["attention"])
        self.assertEqual(sum(flags), 1)
        record_ids = json.loads(row["record_ids"])
        item_ids = json.loads(row["item_ids"])
        for flag, record_id, item_id in zip(flags, record_ids, item_ids):
            if flag:
                self.assertEqual((record_id, item_id), ("attention", "attention"))
            else:
                self.assertEqual(record_id, "r001")
                self.assertTrue(item_id.startswith("r001#passage="))
        facts = json.loads(row["facts"])
        self.assertEqual(len(facts), 5)
        self.assertTrue(all(isinstance(entry, list) and entry for entry in facts))
        self.assertEqual(len(json.loads(row["passage"])), 5)
        self.assertEqual(len(json.loads(row["question"])), 5)

    def test_reference_keys_match_simulated_names(self):
        for hit, row in zip(self.hits, self.rows):
            names = [name for item_names in preprocess.answer_names(self.spec, hit) for name in item_names]
            reference = json.loads(row["llm_label"])
            reasons = json.loads(row["llm_reason"])
            self.assertEqual(list(reference), names)
            attention_names = [name for name in names if name.startswith("attention_")]
            base = next(item for item in hit if not item.is_attention)
            self.assertEqual(len(attention_names), min(2, len(base.targets)))  # max_targets = 2
            for name in attention_names:
                self.assertEqual(reference[name], "not_grounded")
                self.assertNotIn(name, reasons)
            self.assertEqual(set(reasons), set(names) - set(attention_names))
            self.assertTrue(set(reference.values()) <= {"grounded", "not_grounded"})

    def test_reference_omits_missing_hints(self):
        no_yes = variant(self.spec, lambda d: d["item"]["hint"]["map"].pop("Yes"))
        items, _ = preprocess.build_items(no_yes, self.records)
        hits = preprocess.group_hits(no_yes, items)
        _, rows = preprocess.hit_rows(no_yes, hits)
        for hit, row in zip(hits, rows):
            reference = json.loads(row["llm_label"])
            expected = {}
            for item_names, item in zip(preprocess.answer_names(no_yes, hit), hit):
                for name, hint in zip(item_names, item.hints):
                    if hint is not None:
                        expected[name] = hint
            self.assertEqual(reference, expected)
        self.assertTrue(any(len(json.loads(row["llm_label"])) < 10 for row in rows))

    def test_row_bytes_counts_the_csv_line(self):
        size = preprocess.row_bytes(self.columns, self.rows[0])
        self.assertGreater(size, sum(len(cell.encode("utf-8")) for cell in self.rows[0].values()))


class RunPreprocessTest(unittest.TestCase):
    def test_writes_files_deterministically(self):
        parsed = spec.load_spec(EXAMPLE_DIR / "task_spec.json")
        outputs = []
        for _ in range(2):
            with tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp)
                summary = preprocess.run_preprocess(parsed, EXAMPLE_DIR / "raw.json", out)
                files = {name: (out / name).read_bytes() for name in ("items.jsonl", "hits.csv", "summary.json", "settings.json")}
                outputs.append((summary, files))
        self.assertEqual(outputs[0], outputs[1])
        summary, files = outputs[0]
        self.assertEqual((summary["records"]["used"], summary["items"], summary["hits"], summary["attention_items"]), (6, 24, 6, 6))
        self.assertEqual(summary["targets"], 58)
        self.assertEqual(summary["hints_missing"], 0)
        self.assertEqual(sum(summary["reference_values"].values()), 58)
        self.assertEqual(summary["rows_over_64kb"], 0)
        self.assertEqual(summary["columns"][:4], ["hit_id", "record_ids", "item_ids", "attention"])
        self.assertLessEqual(summary["row_bytes"]["min"], summary["row_bytes"]["median"])
        self.assertLessEqual(summary["row_bytes"]["median"], summary["row_bytes"]["max"])

        self.assertFalse(files["hits.csv"].startswith(b"\xef\xbb\xbf"))
        self.assertNotIn(b"\r\n", files["hits.csv"])
        rows = list(csv.DictReader(files["hits.csv"].decode("utf-8").splitlines()))
        self.assertEqual(len(rows), 6)
        self.assertEqual(list(rows[0]), summary["columns"])

        lines = [json.loads(line) for line in files["items.jsonl"].decode("utf-8").splitlines()]
        self.assertEqual(len(lines), 30)
        self.assertEqual(lines[0]["hit_id"], "hit-0001")
        self.assertEqual(lines[0]["item_index"], 0)
        self.assertEqual(len(lines[0]["answer_names"]), len(lines[0]["targets"]))
        self.assertEqual(sum(line["is_attention"] for line in lines), 6)

        settings = json.loads(files["settings.json"])
        self.assertEqual(settings["Title"], parsed.task.title)
        self.assertEqual(settings["Keywords"], "reading, fact checking, english")
        self.assertEqual(settings["attentionRule"], {"namePrefix": "attention_", "expectedValue": "not_grounded", "minCorrectRatio": 1})
        self.assertEqual(settings["reference"], {"source": "column", "column": "llm_label"})
        self.assertEqual(settings["referenceColumn"], "llm_label")
        self.assertEqual(settings["answerNames"]["general"], "general_{i}_{j}")
        self.assertEqual(settings["answerNames"]["attention"], "attention_{i}_{j}")
        self.assertEqual((settings["itemsPerHit"], settings["attentionPerHit"]), (4, 1))

    def test_settings_without_attention(self):
        parsed = spec.load_spec(EXAMPLE_DIR / "task_spec.json")
        plain = variant(parsed, lambda d: d["hit"].__setitem__("attention", None))
        settings = preprocess.build_settings(plain)
        self.assertIsNone(settings["attentionRule"])
        self.assertEqual(settings["attentionPerHit"], 0)


if __name__ == "__main__":
    unittest.main()
