"""preprocess 모듈: 항목·HIT 개수, 결정성, attention 삽입, 답 이름, JSON 셀, 샘플, 전략과 group_by, 문항 여러 개, v1 호환."""

import copy
import csv
import json
import random
import re
import tempfile
import unittest
from pathlib import Path

from agent import preprocess, source, spec

EXAMPLE_DIR = Path(__file__).resolve().parent.parent / "examples" / "groundedness"
COVERAGE_DIR = EXAMPLE_DIR.parent / "coverage"


def load_example():
    parsed = spec.load_spec(EXAMPLE_DIR / "task_spec.json")
    _, records = source.load_records(EXAMPLE_DIR / "raw.json")
    return parsed, records


def variant(base: spec.TaskSpec, mutate) -> spec.TaskSpec:
    """spec dict를 고쳐 다시 파싱한다."""
    data = copy.deepcopy(spec.spec_to_dict(base))
    mutate(data)
    return spec.parse_spec(data)


def legacy_example() -> spec.TaskSpec:
    """예시 spec을 v1(옛 형식) 모양으로 바꿔 읽는다."""
    data = copy.deepcopy(spec.spec_to_dict(spec.load_spec(EXAMPLE_DIR / "task_spec.json")))
    question = data["item"].pop("questions")[0]
    data["spec_version"] = 1
    data["item"]["iterate"] = [{k: v for k, v in it.items() if k != "group_size"} for it in data["item"]["iterate"]]
    data["item"]["question"] = {"text": question["text"], "options": question["options"], "answer_suffix": ""}
    data["item"]["hint"] = {k: v for k, v in question["hint"].items() if k != "contains"}
    attention = data["hit"]["attention"]
    attention["expected_value"] = attention.pop("expected")["support"]
    del data["output"]["attention_column"]
    return spec.parse_spec(data)


def references(item):
    return [answer.reference for answer in item.answers]


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
        self.assertEqual([(a.question, a.target_no) for a in first.answers], [("support", 1), ("support", 2)])
        self.assertEqual(references(first), ["not_grounded", "not_grounded"])
        self.assertTrue(all(isinstance(a.reason, str) and a.reason for a in first.answers))
        self.assertTrue(all(a.expected is None for a in first.answers))
        # hint가 같은 대상을 가리킨다: 두 번째 passage의 라벨은 Yes/Yes
        self.assertEqual(references(items[1]), ["grounded", "grounded"])

    def test_hint_missing_becomes_none(self):
        no_yes = variant(self.spec, lambda d: d["item"]["questions"][0]["hint"]["map"].pop("Yes"))
        items, _ = preprocess.build_items(no_yes, self.records)
        self.assertEqual(references(items[1]), [None, None])
        self.assertEqual(references(items[0]), ["not_grounded", "not_grounded"])

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

    def test_unusable_records_are_skipped(self):
        records = copy.deepcopy(self.records)
        del records[1]["question"]
        records[4]["facts"]["model_a"] = "one statement instead of a map"
        items, stats = preprocess.build_items(self.spec, records)
        self.assertEqual(len(items), 16)
        self.assertNotIn("r002", {item.record_id for item in items})
        self.assertEqual(stats["skipped_records"], {"count": 2, "examples": [
            {"record_id": "r002", "reason": "$.item.fields.question.path: '$.question' does not resolve in record 'r002'"},
            {"record_id": "r005", "reason": "$.item.fields.facts.path: '$.facts.model_a[*]' resolves to str in record 'r005', "
                                            "expected a list of strings"},
        ]})
        hits = preprocess.group_hits(self.spec, items)
        self.assertEqual(len(hits), 4)
        # 쓰는 레코드의 절반을 넘게 건너뛰면 spec이 데이터와 맞지 않는 것이다
        for index in (0, 2):
            del records[index]["question"]
        with self.assertRaisesRegex(spec.SpecError, r"\$\.item: 4 of 6 records could not be used, so the spec does not fit "
                                                    r"the data \(e\.g\. record 'r001': \$\.item\.fields\.question\.path"):
            preprocess.build_items(self.spec, records)

    def test_summary_and_validation_report_skipped_records(self):
        records = copy.deepcopy(self.records)
        del records[1]["question"]
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            raw = out / "raw.json"
            raw.write_text(json.dumps(records), encoding="utf-8")
            (out / "task_spec.json").write_text((EXAMPLE_DIR / "task_spec.json").read_text(encoding="utf-8"), encoding="utf-8")
            summary = preprocess.run_preprocess(self.spec, raw, out)
            self.assertEqual(summary["skipped_records"]["count"], 1)
            self.assertEqual(summary["skipped_records"]["examples"][0]["record_id"], "r002")
            from agent import render, validate
            render.run_render(self.spec, out)
            result = validate.validate_bundle(out)
            self.assertTrue(result["ok"], result["errors"])
            self.assertEqual(result["warnings"], ["summary.json: 1 record(s) were skipped because their data does not fit the "
                                                  "spec (e.g. record 'r002': $.item.fields.question.path: '$.question' does "
                                                  "not resolve in record 'r002')"])
            self.assertEqual(result["stats"]["skipped_records"], 1)

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
            self.assertEqual((attention.record_id, attention.item_id), ("attention", "attention"))
            self.assertEqual(attention.record_index, base.record_index)
            other = by_record[(base.record_index + 3) % 6][0]
            self.assertEqual(attention.fields["question"], other.fields["question"])
            self.assertEqual(attention.fields["passage"], other.fields["passage"])
            self.assertNotEqual(attention.fields["question"], base.fields["question"])
            self.assertEqual(attention.targets, base.targets[:2])
            self.assertEqual(attention.fields["facts"], attention.targets)
            self.assertEqual([a.expected for a in attention.answers], ["not_grounded"] * len(attention.targets))
            self.assertEqual([(a.reference, a.reason) for a in attention.answers], [(None, None)] * len(attention.targets))

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
            self.assertEqual([a.expected for a in attention.answers], ["not_grounded"])

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
        self.assertEqual(preprocess.answer_name(0, 1, ""), "general_0_1")
        self.assertEqual(preprocess.answer_name(3, 1, "_support"), "general_3_1_support")
        self.assertEqual(preprocess.answer_name(10, 12, "_coverage"), "general_10_12_coverage")
        self.assertEqual(preprocess.answer_name(2, None, "_better"), "general_2_better")

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
        self.assertEqual(self.columns, ["hit_id", "record_ids", "item_ids", "attention", "question", "passage", "facts", "llm_label",
                                        "llm_reason", "attention_expected"])
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
            per_item = preprocess.answer_names(self.spec, hit)
            names = [name for item_names in per_item for name in item_names]
            self.assertTrue(all(name.startswith("general_") and name.endswith("_support") for name in names))
            attention_names = [name for item, item_names in zip(hit, per_item) if item.is_attention for name in item_names]
            reference = json.loads(row["llm_label"])
            reasons = json.loads(row["llm_reason"])
            expected = json.loads(row["attention_expected"])
            # reference에는 일반 항목의 답만, attention 컬럼에는 attention 항목의 기대 값만 있다
            self.assertEqual(list(reference), [name for name in names if name not in attention_names])
            base = next(item for item in hit if not item.is_attention)
            self.assertEqual(len(attention_names), min(2, len(base.targets)))  # max_targets = 2
            self.assertEqual(expected, {name: "not_grounded" for name in attention_names})
            self.assertEqual(set(reasons), set(reference))
            self.assertTrue(set(reference.values()) <= {"grounded", "not_grounded"})

    def test_reference_omits_missing_hints(self):
        no_yes = variant(self.spec, lambda d: d["item"]["questions"][0]["hint"]["map"].pop("Yes"))
        items, _ = preprocess.build_items(no_yes, self.records)
        hits = preprocess.group_hits(no_yes, items)
        _, rows = preprocess.hit_rows(no_yes, hits)
        for hit, row in zip(hits, rows):
            reference = json.loads(row["llm_label"])
            expected = {}
            for item_names, item in zip(preprocess.answer_names(no_yes, hit), hit):
                for name, answer in zip(item_names, item.answers):
                    if answer.reference is not None and not item.is_attention:
                        expected[name] = answer.reference
            self.assertEqual(reference, expected)
        self.assertTrue(any(len(json.loads(row["llm_label"])) < 8 for row in rows))

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
        self.assertEqual((summary["answers"], summary["attention_answers"]), (58, 10))
        self.assertEqual(summary["hints_missing"], 0)
        self.assertEqual(sum(summary["reference_values"].values()), 48)  # attention 답은 reference에 없다
        self.assertEqual(summary["questions"], [{"id": "support", "type": "choice", "scope": "target", "answers": 48,
                                                 "references": 48, "reference_values": summary["reference_values"]}])
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
        self.assertEqual([answer["name"] for answer in lines[0]["answers"]], lines[0]["answer_names"])
        self.assertEqual(set(lines[0]["answers"][0]), {"name", "question", "target_no", "reference", "reason", "expected"})
        self.assertEqual(sum(line["is_attention"] for line in lines), 6)
        self.assertTrue(all(name.startswith("general_") for line in lines for name in line["answer_names"]))

        settings = json.loads(files["settings.json"])
        self.assertEqual(settings["Title"], parsed.task.title)
        self.assertEqual(settings["Keywords"], "reading, fact checking, english")
        self.assertEqual(settings["attentionRule"], {"column": "attention_expected", "minCorrectRatio": 1})
        self.assertEqual(settings["reference"], {"source": "column", "column": "llm_label"})
        self.assertEqual(settings["referenceColumn"], "llm_label")
        self.assertEqual(settings["reasonColumn"], "llm_reason")
        self.assertEqual(settings["freeTextSuffixes"], [])
        self.assertEqual(settings["questions"], [{"id": "support", "type": "choice", "scope": "target", "values": ["grounded", "not_grounded"]}])
        self.assertEqual(settings["answerNames"], {"target": "general_{i}_{j}_{qid}", "item": "general_{i}_{qid}"})
        self.assertEqual((settings["itemsPerHit"], settings["attentionPerHit"]), (4, 1))
        self.assertEqual(settings["optionValues"], ["grounded", "not_grounded"])
        self.assertEqual(list(settings), ["Title", "Description", "Keywords", "attentionRule", "reference", "referenceColumn",
                                          "reasonColumn", "freeTextSuffixes", "questions", "answerNames", "itemsPerHit",
                                          "attentionPerHit", "optionValues"])

    def test_settings_without_attention(self):
        parsed = spec.load_spec(EXAMPLE_DIR / "task_spec.json")
        plain = variant(parsed, lambda d: d["hit"].__setitem__("attention", None))
        settings = preprocess.build_settings(plain)
        self.assertIsNone(settings["attentionRule"])
        self.assertEqual(settings["attentionPerHit"], 0)
        self.assertNotIn("attention_expected", preprocess.csv_columns(plain))
        zero = variant(parsed, lambda d: d["hit"]["attention"].__setitem__("per_hit", 0))
        self.assertIsNone(preprocess.build_settings(zero)["attentionRule"])
        self.assertNotIn("attention_expected", preprocess.csv_columns(zero))


class LegacySpecTest(unittest.TestCase):
    """spec_version 1: 답 이름은 예전처럼 general_{i}_{j}{answer_suffix}, attention 탭도 general_, 기대 값은 attention 컬럼."""

    def test_legacy_rows(self):
        legacy = legacy_example()
        self.assertTrue(legacy.legacy)
        _, records = source.load_records(EXAMPLE_DIR / "raw.json")
        items, _ = preprocess.build_items(legacy, records)
        hits = preprocess.group_hits(legacy, items)
        columns, rows = preprocess.hit_rows(legacy, hits)
        self.assertEqual(columns[-1], "attention_expected")
        names = preprocess.answer_names(legacy, hits[0])
        self.assertTrue(all(re.fullmatch(r"general_\d+_\d+", name) for item_names in names for name in item_names))
        flags = json.loads(rows[0]["attention"])
        attention_index = flags.index(1)
        expected = json.loads(rows[0]["attention_expected"])
        self.assertEqual(expected, {name: "not_grounded" for name in names[attention_index]})
        self.assertFalse(set(expected) & set(json.loads(rows[0]["llm_label"])))
        settings = preprocess.build_settings(legacy)
        self.assertEqual(settings["answerNames"], {"target": "general_{i}_{j}", "item": "general_{i}_{qid}"})
        self.assertEqual(settings["attentionRule"], {"column": "attention_expected", "minCorrectRatio": 1})
        self.assertEqual(settings["questions"][0]["id"], "answer")
        # 같은 데이터면 v2 spec과 reference 값은 같고 이름만 접미어가 다르다
        v2 = spec.load_spec(EXAMPLE_DIR / "task_spec.json")
        _, v2_rows = preprocess.hit_rows(v2, preprocess.group_hits(v2, preprocess.build_items(v2, records)[0]))
        for old, new in zip(rows, v2_rows):
            self.assertEqual({k + "_support": v for k, v in json.loads(old["llm_label"]).items()}, json.loads(new["llm_label"]))


class MultiQuestionTest(unittest.TestCase):
    """합성 coverage 예시: multi_select(contains hint) + item choice + required_when text."""

    @classmethod
    def setUpClass(cls):
        cls.spec = spec.load_spec(COVERAGE_DIR / "task_spec.json")
        _, cls.records = source.load_records(COVERAGE_DIR / "raw.json")
        cls.items, cls.stats = preprocess.build_items(cls.spec, cls.records)
        cls.hits = preprocess.group_hits(cls.spec, cls.items)
        cls.columns, cls.rows = preprocess.hit_rows(cls.spec, cls.hits)

    def test_answers_per_item(self):
        first = self.items[0]  # q01, Sub-question 1, 문장 3개
        self.assertEqual(first.item_id, "q01#sub=Sub-question 1")
        self.assertEqual([(a.question, a.target_no) for a in first.answers],
                         [("relevant", 1), ("relevant", 2), ("relevant", 3), ("coverage", None), ("missing", None)])
        self.assertEqual(references(first), ["relevant", "relevant", "not_relevant", "covered", None])
        self.assertEqual(references(self.items[1]), ["not_relevant"] * 3 + ["not_covered", None])

    def test_reference_matches_raw_labels(self):
        for hit, row in zip(self.hits, self.rows):
            reference = json.loads(row["llm_label"])
            expected_names = json.loads(row["attention_expected"])
            per_item = preprocess.answer_names(self.spec, hit)
            for index, (item, names) in enumerate(zip(hit, per_item)):
                if item.is_attention:
                    self.assertEqual({n: expected_names[n] for n in names if n in expected_names},
                                     {n: ("not_covered" if n.endswith("_coverage") else "not_relevant")
                                      for n in names if not n.endswith("_missing")})
                    continue
                record = next(r for r in self.records if r["id"] == item.record_id)
                sub_key = item.item_id.split("#sub=")[1]
                selected = record["labels"]["system_a"]["relevance"][sub_key]["selected"]
                for target_no, key in enumerate(record["answer"]["system_a"], 1):
                    self.assertEqual(reference[f"general_{index}_{target_no}_relevant"],
                                     "relevant" if key in selected else "not_relevant")
                coverage = record["labels"]["system_a"]["coverage"][sub_key]
                self.assertEqual(reference[f"general_{index}_coverage"], {"Covered": "covered", "Not covered": "not_covered"}[coverage])
                self.assertNotIn(f"general_{index}_missing", reference)
            self.assertFalse(set(reference) & set(expected_names))

    def test_settings_and_summary(self):
        settings = preprocess.build_settings(self.spec)
        self.assertEqual(settings["freeTextSuffixes"], ["_missing"])
        self.assertEqual(settings["questions"], [
            {"id": "relevant", "type": "multi_select", "scope": "target", "values": ["relevant", "not_relevant"]},
            {"id": "coverage", "type": "choice", "scope": "item", "values": ["covered", "not_covered"]},
            {"id": "missing", "type": "text", "scope": "item", "values": []},
        ])
        self.assertEqual(settings["optionValues"], ["relevant", "not_relevant", "covered", "not_covered"])
        self.assertIsNone(settings["reasonColumn"])
        summary = preprocess.build_summary(self.spec, self.stats, self.hits, self.columns, self.rows, "json_array")
        by_id = {entry["id"]: entry for entry in summary["questions"]}
        self.assertEqual(by_id["missing"]["references"], 0)
        self.assertEqual(by_id["coverage"]["answers"], self.stats["items"])
        self.assertEqual(summary["hints_missing"], 0)  # text 답은 세지 않는다
        self.assertEqual(summary["attention_items"], len(self.hits))
        self.assertEqual(summary["attention_answers"], sum(len(json.loads(row["attention_expected"])) for row in self.rows))

    def test_no_target_field_and_groups(self):
        def mutate(d):
            d["item"]["iterate"] = [{"var": "pair", "path": "$.answer.system_a", "limit": None, "group_size": 2}]
            d["item"]["fields"] = {"question": {"path": "$.question", "label": "Question", "role": "context", "style": "text"},
                                   "a": {"path": "{pair}[0]", "label": "A", "role": "context", "style": "text"},
                                   "b": {"path": "{pair}[1]", "label": "B", "role": "context", "style": "text"}}
            d["item"]["questions"] = [{"id": "better", "text": "Which is better?", "type": "choice", "scope": "item",
                                       "options": [{"value": "a", "label": "A"}, {"value": "b", "label": "B"}]}]
            d["hit"]["attention"]["expected"] = {"better": "b"}
            d["hit"]["attention"]["mismatch"]["swap_fields"] = ["question"]
        pairs = variant(self.spec, mutate)
        items, _ = preprocess.build_items(pairs, self.records)
        # 문장 수 3, 4, 3, 3, 3 → 2개씩 묶으면 레코드마다 1, 2, 1, 1, 1개
        self.assertEqual(len(items), 6)
        self.assertEqual(items[0].targets, [])
        self.assertEqual(items[0].item_id, "q01#pair=Statement 1")
        self.assertEqual([(a.question, a.target_no, a.reference) for a in items[0].answers], [("better", None, None)])
        hits = preprocess.group_hits(pairs, items)
        columns, rows = preprocess.hit_rows(pairs, hits)
        self.assertEqual(columns, ["hit_id", "record_ids", "item_ids", "attention", "question", "a", "b", "llm_label", "attention_expected"])
        flags = json.loads(rows[0]["attention"])
        self.assertEqual(json.loads(rows[0]["attention_expected"]), {f"general_{flags.index(1)}_better": "b"})
        self.assertEqual(json.loads(rows[0]["llm_label"]), {})


if __name__ == "__main__":
    unittest.main()
