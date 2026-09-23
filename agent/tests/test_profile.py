"""profile 모듈: 예시 데이터의 경로 패턴, 이상치, 값 분포, 마크다운, 프롬프트용 축약."""

import json
import tempfile
import unittest
from pathlib import Path

from agent import profile, source

EXAMPLE_DIR = Path(__file__).resolve().parent.parent / "examples" / "groundedness"
LABEL_PATH = "$.labels.retriever_a.model_a.passage_fact_support.{key}.{key}[0]"


def entries(prof):
    return {entry["path"]: entry for entry in prof["paths"]}


class ExampleProfileTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _, cls.records = source.load_records(EXAMPLE_DIR / "raw.json")
        cls.profile = profile.profile_records(cls.records)
        cls.by_path = entries(cls.profile)

    def test_top_level_structure(self):
        self.assertEqual(list(self.profile), ["source", "record_id", "paths", "anomalies", "hints"])
        self.assertEqual(self.profile["source"], {"records": 6})
        self.assertEqual(self.profile["record_id"], {"path": "$.id", "unique": True})
        json.dumps(self.profile)

    def test_path_patterns(self):
        for path in ("$", "$.id", "$.question", "$.answer[*]", "$.passages.retriever_a", "$.passages.retriever_a[*]",
                     "$.facts.model_a", "$.facts.model_a.{key}", "$.subqueries.{key}", LABEL_PATH,
                     "$.labels.retriever_a.model_a.passage_fact_support.{key}.{key}[1]"):
            self.assertIn(path, self.by_path)
        self.assertNotIn("$.facts.model_a['Fact 1']", self.by_path)
        self.assertNotIn("$.labels.retriever_a.model_a.passage_fact_support['Passage 1']", self.by_path)
        self.assertEqual(list(self.by_path)[:4], ["$", "$.id", "$.question", "$.answer"])

    def test_stats(self):
        passages = self.by_path["$.passages.retriever_a[*]"]
        self.assertEqual(passages["types"], {"str": 48})
        self.assertEqual(passages["present"], 48)
        self.assertGreaterEqual(passages["str_len"]["median"], 200)
        self.assertEqual(len(passages["examples"]), 3)
        self.assertTrue(all(len(e) <= 120 for e in passages["examples"]))
        self.assertEqual(self.by_path["$.passages.retriever_a"]["list_len"], {"min": 8, "median": 8, "max": 8})
        facts = self.by_path["$.facts.model_a"]
        self.assertEqual(facts["keys"]["kind"], "map")
        self.assertEqual(facts["keys"]["pattern"], "Fact {n}")
        self.assertEqual(facts["keys"]["count"], {"min": 1, "median": 2, "max": 3})
        self.assertEqual(self.by_path["$.passages"]["keys"], {"kind": "fixed", "count": {"min": 2, "median": 2, "max": 2}, "names": ["retriever_a", "retriever_b"]})
        self.assertEqual(self.by_path["$"]["keys"]["names"], ["id", "question", "answer", "passages", "subqueries", "facts", "labels"])

    def test_value_histogram(self):
        label = self.by_path[LABEL_PATH]
        self.assertEqual(set(label["values"]), {"Yes", "No"})
        self.assertEqual(sum(label["values"].values()), 96)
        self.assertNotIn("values", self.by_path["$.passages.retriever_a[*]"])
        self.assertNotIn("values", self.by_path["$.subqueries.{key}"])

    def test_anomalies(self):
        mismatches = [a for a in self.profile["anomalies"] if a["kind"] == "type_mismatch"]
        self.assertEqual(mismatches, [{"path": "$.subqueries", "kind": "type_mismatch", "majority": "dict",
                                       "found": "str", "count": 1, "record_ids": ["r005"]}])
        self.assertEqual([a for a in self.profile["anomalies"] if a["kind"] != "type_mismatch"], [])

    def test_hints(self):
        hints = "\n".join(self.profile["hints"])
        self.assertIn("$.id looks like a record id", hints)
        self.assertIn("$.passages.retriever_a[*] holds long texts", hints)
        self.assertIn("$.facts.model_a.{key} holds short sentences in a map keyed 'Fact {n}'", hints)
        self.assertIn(f"{LABEL_PATH} takes 2 values", hints)
        self.assertIn("'Passage {n}', 'Fact {n}'", hints)
        self.assertIn("$.subqueries is str in 1 record(s) (r005)", hints)

    def test_markdown(self):
        text = profile.profile_to_markdown(self.profile)
        for expected in ("# Data profile", "## Paths", "## Anomalies", "## Hints", "`$.facts.model_a.{key}`",
                         "type_mismatch", "record id: `$.id`"):
            self.assertIn(expected, text)
        self.assertTrue(text.endswith("\n"))

    def test_profile_for_prompt(self):
        full = len(json.dumps(self.profile, ensure_ascii=False))
        small = profile.profile_for_prompt(self.profile, max_chars=40000)
        self.assertLess(len(json.dumps(small, ensure_ascii=False)), full)
        self.assertNotIn("truncated", small)
        self.assertNotIn("source", small)
        self.assertEqual({e["path"] for e in small["paths"]}, set(self.by_path))
        self.assertTrue(all(len(e.get("examples", [])) <= 2 for e in small["paths"]))
        tiny = profile.profile_for_prompt(self.profile, max_chars=6000)
        self.assertLessEqual(len(json.dumps(tiny, ensure_ascii=False)), 6000)
        self.assertIn("truncated", tiny)
        self.assertGreater(tiny["truncated"]["paths_dropped"], 0)
        paths_kept = {e["path"] for e in tiny["paths"]}
        self.assertIn("$.question", paths_kept)
        self.assertIn(LABEL_PATH, paths_kept)
        self.assertNotIn("$.labels.retriever_a.model_a.passage_fact_support.{key}.{key}[1]", paths_kept)
        self.assertEqual(self.by_path["$.passages.retriever_a[*]"]["present"], 48)

    def test_run_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            result = profile.run_profile(EXAMPLE_DIR / "raw.json", out)
            self.assertEqual(result["source"]["format"], "json_array")
            self.assertEqual(result["source"]["records"], 6)
            self.assertEqual(result["source"]["path"], "raw.json")
            self.assertGreater(result["source"]["bytes"], 1000)
            saved = json.loads((out / "profile.json").read_text(encoding="utf-8"))
            self.assertEqual(saved, result)
            self.assertIn("raw.json", (out / "profile.md").read_text(encoding="utf-8"))

    def test_record_id_path_given(self):
        prof = profile.profile_records(self.records, "$.question")
        self.assertEqual(prof["record_id"], {"path": "$.question", "unique": True})
        prof = profile.profile_records(self.records, "$.missing")
        self.assertEqual(prof["record_id"], {"path": "$.missing", "unique": False})
        self.assertEqual(prof["anomalies"][0]["record_ids"], ["r5"])


class ClassificationTest(unittest.TestCase):
    def test_fixed_vs_map_and_positional(self):
        records = []
        for i in range(40):
            record = {"name": f"n{i}", "meta": {"a": 1, "b": "x", "d": 2, "e": 3}, "by_id": {f"item-{i}": 1, f"other-{i}": 2},
                      "pair": ["Yes", "reason"], "many": list(range(i % 7)), "flag": True}
            if i != 3:
                record["meta"]["c"] = 3.5
            if i == 5:
                record["many"] = list(range(200))
            if i == 6:
                record["name"] = None
            records.append(record)
        prof = profile.profile_records(records)
        by_path = entries(prof)
        self.assertEqual(prof["record_id"], None)
        self.assertEqual(by_path["$.meta"]["keys"]["kind"], "fixed")
        self.assertIn("$.meta.c", by_path)
        self.assertEqual(by_path["$.by_id"]["keys"]["kind"], "map")
        self.assertIn("$.by_id.{key}", by_path)
        self.assertIn("$.pair[0]", by_path)
        self.assertIn("$.pair[1]", by_path)
        self.assertNotIn("$.pair[*]", by_path)
        self.assertIn("$.many[*]", by_path)
        self.assertEqual(by_path["$.pair[0]"]["values"], {"Yes": 40})
        self.assertEqual(by_path["$.flag"]["values"], {"True": 40})
        kinds = {(a["path"], a["kind"]): a for a in prof["anomalies"]}
        self.assertEqual(kinds[("$.meta.c", "missing")]["record_ids"], ["r4"])
        self.assertEqual(kinds[("$.many", "size_outlier")]["record_ids"], ["r6"])
        self.assertEqual(kinds[("$.many", "size_outlier")]["stat"], "list_len")
        self.assertEqual(kinds[("$.name", "type_mismatch")]["found"], "null")
        self.assertEqual(kinds[("$.name", "type_mismatch")]["record_ids"], ["r7"])

    def test_record_id_guess_prefers_id_like_names(self):
        records = [{"title": f"t{i}", "doc_id": f"d{i}", "kind": "same"} for i in range(5)]
        prof = profile.profile_records(records)
        self.assertEqual(prof["record_id"], {"path": "$.doc_id", "unique": True})
        self.assertEqual(entries(prof)["$.kind"]["examples"], ["same"])
        records = [{"key with space": f"k{i}"} for i in range(3)]
        self.assertEqual(profile.profile_records(records)["record_id"], {"path": "$['key with space']", "unique": True})

    def test_numeric_key_pattern_forces_map(self):
        records = [{"labels": {"Passage 1": "a", "Passage 2": "b"}} for _ in range(3)]
        by_path = entries(profile.profile_records(records))
        self.assertEqual(by_path["$.labels"]["keys"]["kind"], "map")
        self.assertEqual(by_path["$.labels"]["keys"]["pattern"], "Passage {n}")
        records = [{"labels": {"model_x": "a", "model_y": "b"}} for _ in range(3)]
        self.assertEqual(entries(profile.profile_records(records))["$.labels"]["keys"]["kind"], "fixed")


if __name__ == "__main__":
    unittest.main()
