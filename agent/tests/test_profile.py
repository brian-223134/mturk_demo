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

    def test_profile_for_prompt_keeps_everything_when_it_fits(self):
        before = json.dumps(self.profile, ensure_ascii=False)
        small = profile.profile_for_prompt(self.profile, max_chars=40000)
        self.assertEqual(json.dumps(self.profile, ensure_ascii=False), before)
        self.assertLess(len(json.dumps(small, ensure_ascii=False)), len(before))
        self.assertEqual(list(small), ["record_id", "paths", "anomalies", "hints"])
        self.assertEqual([e["path"] for e in small["paths"]], list(self.by_path))
        self.assertEqual(small["hints"], self.profile["hints"])
        self.assertEqual(small["anomalies"], self.profile["anomalies"])
        self.assertEqual(small["record_id"], self.profile["record_id"])
        by_path = entries(small)
        for entry in small["paths"]:
            self.assertNotIn("present", entry)
            self.assertLessEqual(len(entry.get("examples", [])), 2)
            self.assertTrue(all(len(e) <= 100 for e in entry.get("examples", []) if isinstance(e, str)))
        self.assertEqual(len(by_path["$.passages.retriever_a[*]"]["examples"]), 2)
        self.assertEqual(by_path["$"]["keys"], {"kind": "fixed", "names": ["id", "question", "answer", "passages", "subqueries", "facts", "labels"]})
        self.assertEqual(by_path["$.facts.model_a"]["keys"]["examples"], ["Fact 1"])
        self.assertEqual(by_path["$.facts.model_a"]["keys"]["count"], {"min": 1, "median": 2, "max": 3})
        self.assertEqual(profile.profile_for_prompt(self.profile, max_chars=40000), small)

    def test_profile_for_prompt_drops_examples_before_paths(self):
        small = profile.profile_for_prompt(self.profile, max_chars=12000)
        self.assertLessEqual(len(json.dumps(small, ensure_ascii=False)), 12000)
        self.assertNotIn("truncated", small)
        self.assertEqual(len(small["paths"]), len(self.by_path))
        by_path = entries(small)
        self.assertIn("examples", by_path["$.passages.retriever_a[*]"])
        self.assertNotIn("examples", by_path["$.labels.retriever_a.model_a.passage_fact_support.{key}.{key}[1]"])

    def test_profile_for_prompt_priority_order(self):
        small = profile.profile_for_prompt(self.profile, max_chars=9000)
        self.assertLessEqual(len(json.dumps(small, ensure_ascii=False)), 9000)
        self.assertEqual(small["hints"], self.profile["hints"])
        self.assertEqual(small["anomalies"], self.profile["anomalies"])
        kept = [e["path"] for e in small["paths"]]
        self.assertEqual(small["truncated"]["paths_dropped"], len(self.by_path) - len(kept))
        self.assertEqual(kept, [path for path in self.by_path if path in kept])
        for path in ("$", "$.id", "$.question", "$.answer", "$.answer[*]", "$.passages.retriever_a[*]", "$.subqueries.{key}",
                     "$.facts.model_a", "$.facts.model_a.{key}", LABEL_PATH,
                     "$.labels.retriever_b.model_b.passage_fact_support.{key}.{key}[0]",
                     "$.labels.retriever_a.model_a.passage_fact_support.{key}.{key}",
                     "$.labels.retriever_a.model_a.passage_fact_support"):
            self.assertIn(path, kept)
        self.assertNotIn("$.labels.retriever_a.model_a.passage_fact_support.{key}.{key}[1]", kept)
        self.assertNotIn("$.labels.retriever_a.model_a.subquery_fact_coverage.{key}[0]", kept)
        self.assertTrue(all("examples" not in e for e in small["paths"]))
        self.assertEqual(profile.profile_for_prompt(self.profile, max_chars=9000), small)
        tiny = profile.profile_for_prompt(self.profile, max_chars=700)
        self.assertEqual(tiny["paths"], [])
        self.assertEqual(tiny["hints"], self.profile["hints"])
        self.assertEqual(tiny["truncated"]["paths_dropped"], len(self.by_path))

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


class PromptProfileTest(unittest.TestCase):
    """profile_for_prompt: 넓은 스칼라 dict 접기, 힌트 문장의 경로 추출, 조상 경로."""

    WORDS = ("alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet")

    def test_wide_scalar_dict_is_collapsed(self):
        records = []
        for i in range(30):
            preds = {word: f"answer {word} of record {i}" for word in self.WORDS}
            preds["delta"] = "Yes" if i % 3 else "No"
            meta = {word: i for word in self.WORDS[:9]}
            meta["india"] = {"x": i}
            records.append({"doc_id": f"d{i}", "preds": preds, "meta": meta, "eight": {word: "v" for word in self.WORDS[:8]}})
        prof = profile.profile_records(records)
        self.assertEqual(entries(prof)["$.preds"]["keys"]["kind"], "fixed")
        small = profile.profile_for_prompt(prof, max_chars=40000)
        by_path = entries(small)
        self.assertEqual(by_path["$.preds"]["children_omitted"], 9)
        self.assertEqual(len(by_path["$.preds"]["keys"]["names"]), 10)
        self.assertIn("$.preds.delta", by_path)
        self.assertNotIn("$.preds.alpha", by_path)
        self.assertNotIn("children_omitted", by_path["$.meta"])
        self.assertIn("$.meta.alpha", by_path)
        self.assertNotIn("children_omitted", by_path["$.eight"])
        self.assertIn("$.eight.alpha", by_path)
        self.assertEqual(small["truncated"]["paths_dropped"], 9)
        self.assertIn("children_omitted", small["truncated"]["note"])
        self.assertEqual(profile.profile_for_prompt(prof, max_chars=40000), small)

    def test_hint_paths_and_prefixes(self):
        known = {"$", "$.a", "$.a['k 1']", "$.a['k 1'][*]", "$.b", "$.b.{key}", "$.c"}
        hints = ["$.a['k 1'][*] holds long texts; iterate over $.a['k 1']: candidate context field.",
                 "$.b.{key} takes 2 values (Yes 3, No 4): candidate LLM label for hints.",
                 "$.zzz is not in the profile; $.c."]
        self.assertEqual(profile._hint_paths(hints, known), ["$.a['k 1'][*]", "$.a['k 1']", "$.b.{key}", "$.c"])
        self.assertEqual(profile._prefixes("$.a['k 1'][*].{key}[0]"), ["$", "$.a", "$.a['k 1']", "$.a['k 1'][*]", "$.a['k 1'][*].{key}"])
        self.assertEqual(profile._prefixes("$.a"), ["$"])
        self.assertEqual(profile._prefixes("$"), [])


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
