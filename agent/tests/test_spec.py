"""spec 모듈: 기본값, 오류 수집, 저장/복원, 레코드 실측 검증."""

import copy
import json
import tempfile
import unittest
from pathlib import Path

from agent import source, spec
from agent.spec import SpecError

EXAMPLE_DIR = Path(__file__).resolve().parent.parent / "examples" / "groundedness"

MINIMAL = {
    "task": {"id": "demo", "title": "Demo task", "description": "Judge things."},
    "item": {
        "fields": {
            "question": {"path": "$.question"},
            "facts": {"path": "$.facts[*]", "role": "target"},
        },
        "question": {"text": "Is it?", "options": [{"value": "yes"}, {"value": "no", "label": "No"}]},
    },
}


class ParseTest(unittest.TestCase):
    def test_defaults(self):
        parsed = spec.parse_spec(copy.deepcopy(MINIMAL))
        self.assertEqual(parsed.spec_version, 1)
        self.assertEqual(parsed.task.keywords, [])
        self.assertIsNone(parsed.source.format)
        self.assertIsNone(parsed.source.record_id)
        self.assertIsNone(parsed.source.filter)
        self.assertEqual(parsed.item.iterate, [])
        self.assertEqual(parsed.item.fields["question"].label, "question")
        self.assertEqual(parsed.item.fields["question"].role, "context")
        self.assertEqual(parsed.item.fields["question"].style, "text")
        self.assertEqual(parsed.item.question.options[0].label, "yes")
        self.assertEqual(parsed.item.question.answer_suffix, "")
        self.assertIsNone(parsed.item.hint)
        self.assertTrue(parsed.item.skip_if_no_targets)
        self.assertEqual(parsed.hit.items_per_hit, 10)
        self.assertEqual(parsed.hit.group_by, "record")
        self.assertIsNone(parsed.hit.attention)
        self.assertEqual(parsed.instructions.summary, "Judge things.")
        self.assertTrue(parsed.instructions.notices.attention)
        self.assertTrue(parsed.instructions.notices.research)
        self.assertEqual(parsed.output.reference_column, "llm_label")
        self.assertIsNone(parsed.output.reason_column)
        self.assertIsNone(parsed.planner_notes)
        self.assertEqual(parsed.target_field.name, "facts")
        self.assertEqual([f.name for f in parsed.context_fields], ["question"])
        self.assertEqual(parsed.option_values, ["yes", "no"])

    def test_null_means_default(self):
        data = copy.deepcopy(MINIMAL)
        data["task"]["description"] = None
        data["task"]["keywords"] = None
        data["item"]["skip_if_no_targets"] = None
        data["hit"] = {"items_per_hit": None, "attention": None}
        data["instructions"] = {"summary": None, "tip": None, "notices": None}
        parsed = spec.parse_spec(data)
        self.assertEqual((parsed.task.description, parsed.task.keywords), ("", []))
        self.assertTrue(parsed.item.skip_if_no_targets)
        self.assertEqual(parsed.hit.items_per_hit, 10)
        self.assertEqual(parsed.instructions.summary, "")
        data["task"]["id"] = None
        with self.assertRaisesRegex(SpecError, r"\$\.task\.id: required"):
            spec.parse_spec(data)

    def test_attention_defaults(self):
        data = copy.deepcopy(MINIMAL)
        data["hit"] = {"attention": {"strategy": "instruction", "expected_value": "no",
                                     "instruction": {"text": "Choose No."}}}
        attention = spec.parse_spec(data).hit.attention
        self.assertEqual((attention.per_hit, attention.position, attention.seed, attention.max_targets), (1, "random", 42, None))

    def test_collects_all_errors_with_paths(self):
        data = {
            "spec_version": 2,
            "task": {"id": "Bad_ID", "title": ""},
            "source": {"format": "xml", "limit": 0, "filter": {"path": "$.x"}},
            "item": {
                "iterate": [{"var": "record_id", "path": "$.passages"}, {"var": "p", "path": "$.a.{name}"}],
                "fields": {
                    "hit_id": {"path": "$.q"},
                    "a": {"path": "$.a[*]", "role": "target"},
                    "b": {"path": "$.b[*]", "role": "target", "style": "huge"},
                    "c": {"path": "{nothere}.x"},
                    "bad name": {"path": "$.c", "extra": 1},
                },
                "question": {"text": "", "options": [{"value": "yes"}], "answer_suffix": "-x"},
                "hint": {"label_path": "$.l['{target_no}']", "map": {"Y": "maybe"}, "missing": "nope"},
            },
            "hit": {"items_per_hit": 0, "group_by": "pile",
                    "attention": {"strategy": "mismatch", "expected_value": "zzz", "per_hit": -1,
                                  "position": "middle", "mismatch": {"swap_fields": ["a", "zz"], "distance": 0}}},
            "output": {"reference_column": "attention", "reason_column": "attention"},
            "unknown_top": 1,
        }
        with self.assertRaises(SpecError) as caught:
            spec.parse_spec(data)
        messages = caught.exception.messages
        joined = "\n".join(messages)
        for expected in (
            "$.spec_version: must be 1",
            "$.task.id: must match",
            "$.task.title: must not be empty",
            "$.source.format:",
            "$.source.limit:",
            "$.source.filter: needs",
            "$.item.iterate[0].var: 'record_id' is a reserved",
            "$.item.iterate[1].path: invalid path",
            "$.item.fields.hit_id: field name 'hit_id' is reserved",
            "$.item.fields: exactly one field must have role \"target\" (found 2",
            "$.item.fields.b.style: must be one of",
            "$.item.fields.c.path: unknown variable {nothere}",
            "$.item.fields.bad name: field name must match",
            "$.item.fields.bad name.extra: unknown key",
            "$.item.question.text: must not be empty",
            "$.item.question.options: at least 2",
            "$.item.question.answer_suffix: must match",
            "$.item.hint.map.Y: 'maybe' is not an option value",
            "$.item.hint.missing: 'nope' is not an option value",
            "$.hit.items_per_hit: must be at least 1",
            "$.hit.group_by: must be one of",
            "$.hit.attention.per_hit: must be 0 or more",
            "$.hit.attention.position: must be one of",
            "$.hit.attention.expected_value: 'zzz' is not an option value",
            "$.hit.attention.mismatch.swap_fields: 'a' is not a context field",
            "$.hit.attention.mismatch.swap_fields: 'zz' is not a context field",
            "$.hit.attention.mismatch.distance: must be at least 1",
            "$.output.reference_column: 'attention' is reserved",
            "$.unknown_top: unknown key",
        ):
            self.assertIn(expected, joined, msg=f"missing error {expected!r} in:\n{joined}")
        self.assertEqual(len(messages), len(set(messages)))
        self.assertIn("$.spec_version: must be 1", str(caught.exception))

    def test_wrong_types(self):
        data = copy.deepcopy(MINIMAL)
        data["task"]["keywords"] = "reading"
        data["item"]["skip_if_no_targets"] = "yes"
        data["hit"] = {"items_per_hit": True}
        data["instructions"] = {"steps": ["ok", 3], "notices": {"attention": "no"}}
        with self.assertRaises(SpecError) as caught:
            spec.parse_spec(data)
        joined = "\n".join(caught.exception.messages)
        for expected in ("$.task.keywords: must be a list", "$.item.skip_if_no_targets: must be a boolean",
                         "$.hit.items_per_hit: must be an integer", "$.instructions.steps[1]: must be a string",
                         "$.instructions.notices.attention: must be a boolean"):
            self.assertIn(expected, joined)
        with self.assertRaises(SpecError):
            spec.parse_spec([])

    def test_planner_notes(self):
        parsed = spec.parse_spec(copy.deepcopy(MINIMAL))
        self.assertIsNone(parsed.planner_notes)
        self.assertIsNone(spec.spec_to_dict(parsed)["planner_notes"])
        data = copy.deepcopy(MINIMAL)
        data["planner_notes"] = None
        self.assertIsNone(spec.parse_spec(data).planner_notes)
        note = "The facts list is the target; the question is the only context field."
        data["planner_notes"] = note
        parsed = spec.parse_spec(data)
        self.assertEqual(parsed.planner_notes, note)
        as_dict = spec.spec_to_dict(parsed)
        self.assertEqual(as_dict["planner_notes"], note)
        self.assertEqual(spec.parse_spec(as_dict), parsed)
        data["planner_notes"] = ["not", "a string"]
        with self.assertRaisesRegex(SpecError, r"\$\.planner_notes: must be a string"):
            spec.parse_spec(data)

    def test_strategy_requires_block(self):
        data = copy.deepcopy(MINIMAL)
        data["hit"] = {"attention": {"strategy": "mismatch", "expected_value": "no"}}
        with self.assertRaisesRegex(SpecError, r"\$\.hit\.attention\.mismatch: required"):
            spec.parse_spec(data)
        data["hit"] = {"attention": {"strategy": "instruction", "expected_value": "no"}}
        with self.assertRaisesRegex(SpecError, r"\$\.hit\.attention\.instruction: required"):
            spec.parse_spec(data)


class LoadRoundtripTest(unittest.TestCase):
    def test_example_roundtrip(self):
        path = EXAMPLE_DIR / "task_spec.json"
        loaded = spec.load_spec(path)
        self.assertTrue(loaded.planner_notes)
        as_dict = spec.spec_to_dict(loaded)
        self.assertEqual(as_dict, json.loads(path.read_text(encoding="utf-8")))
        self.assertEqual(spec.parse_spec(as_dict), loaded)
        self.assertEqual(spec.parse_spec(json.loads(json.dumps(as_dict))), loaded)

    def test_roundtrip_with_filter_and_sample(self):
        data = copy.deepcopy(MINIMAL)
        data["source"] = {"record_id": "$.id", "filter": {"path": "$.split", "equals": "test"}, "sample": {"n": 3, "seed": 1}, "limit": 2}
        parsed = spec.parse_spec(data)
        self.assertEqual(parsed.source.filter.mode, "equals")
        again = spec.parse_spec(spec.spec_to_dict(parsed))
        self.assertEqual(again, parsed)
        data["source"]["filter"] = {"path": "$.split", "exists": False}
        parsed = spec.parse_spec(data)
        self.assertEqual((parsed.source.filter.mode, parsed.source.filter.value), ("exists", False))
        self.assertEqual(spec.spec_to_dict(parsed)["source"]["filter"], {"path": "$.split", "exists": False})

    def test_load_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            broken = Path(tmp) / "task_spec.json"
            broken.write_text("{", encoding="utf-8")
            with self.assertRaisesRegex(SpecError, "invalid JSON"):
                spec.load_spec(broken)
            with self.assertRaises(SpecError):
                spec.load_spec(Path(tmp) / "missing.json")

    def test_reference_doc_contains_example(self):
        reference = (EXAMPLE_DIR.parent.parent / "spec_reference.md").read_text(encoding="utf-8")
        example = (EXAMPLE_DIR / "task_spec.json").read_text(encoding="utf-8")
        self.assertIn(example, reference)


class ValidateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spec = spec.load_spec(EXAMPLE_DIR / "task_spec.json")
        _, cls.records = source.load_records(EXAMPLE_DIR / "raw.json")

    def test_example_passes(self):
        self.assertEqual(spec.validate_against_records(self.spec, self.records), [])

    def test_helpers_on_example(self):
        record = self.records[0]
        record_id = spec.record_id_of(self.spec, record, 0)
        self.assertEqual(record_id, "r001")
        base = spec.record_variables(0, record_id)
        items = list(spec.iter_item_variables(self.spec, record, base))
        self.assertEqual(len(items), 4)
        self.assertEqual([v["passage_no"] for v in items], [1, 2, 3, 4])
        self.assertEqual(items[0]["passage_key"], 0)
        self.assertEqual(items[0]["passage"], record["passages"]["retriever_a"][0])
        self.assertEqual(spec.field_value(self.spec.item.fields["passage"], record, items[1]), record["passages"]["retriever_a"][1])
        targets, keys = spec.resolve_targets(self.spec.target_field, record, items[0])
        self.assertEqual(keys, ["Fact 1", "Fact 2"])
        self.assertEqual(targets, list(record["facts"]["model_a"].values()))
        tvars = spec.target_variables(items[1], targets[0], 0, keys[0])
        self.assertEqual((tvars["target_no"], tvars["target_key"], tvars["passage_no"]), (1, "Fact 1", 2))
        hint = self.spec.item.hint
        from agent import paths
        self.assertEqual(spec.map_hint(hint, paths.evaluate(hint.label_path, record, tvars)), "grounded")
        self.assertEqual(spec.map_hint(hint, "Maybe"), None)
        self.assertEqual(spec.map_hint(hint, paths.MISSING), None)

    def test_broken_spec_reports(self):
        data = spec.spec_to_dict(self.spec)
        data["item"]["hint"]["label_path"] = "$.labels.retriever_a.model_a.nothing['Passage {passage_no}']['Fact {target_no}'][0]"
        data["item"]["fields"]["question"]["path"] = "$.no_such_key"
        data["item"]["fields"]["facts"]["path"] = "$.question"
        broken = spec.parse_spec(data)
        errors = spec.validate_against_records(broken, self.records)
        joined = "\n".join(errors)
        self.assertIn("$.item.fields.question.path: '$.no_such_key' does not resolve in record 'r001'", joined)
        self.assertIn("$.item.fields.facts.path: '$.question' resolves to str", joined)
        self.assertNotIn("no item has targets", joined)
        self.assertEqual(len(errors), 2, errors)

        data = spec.spec_to_dict(self.spec)
        data["item"]["hint"]["label_path"] = "$.labels.retriever_a.model_a.nothing['Passage {passage_no}']['Fact {target_no}'][0]"
        errors = spec.validate_against_records(spec.parse_spec(data), self.records)
        self.assertTrue(any(e.startswith("$.item.hint.label_path:") and "never resolves" in e for e in errors), errors)

        data = spec.spec_to_dict(self.spec)
        data["item"]["hint"]["map"] = {"Maybe": "grounded"}
        errors = spec.validate_against_records(spec.parse_spec(data), self.records)
        self.assertTrue(any(e.startswith("$.item.hint.map: no observed label maps") and "'Yes'" in e for e in errors), errors)

        data = spec.spec_to_dict(self.spec)
        data["item"]["iterate"][0]["path"] = "$.question"
        errors = spec.validate_against_records(spec.parse_spec(data), self.records)
        self.assertIn("$.item.iterate[0].path: '$.question' resolves to str in record 'r001', expected a list or an object", errors)

        data = spec.spec_to_dict(self.spec)
        data["source"]["filter"] = {"path": "$.id", "equals": "zzz"}
        self.assertEqual(spec.validate_against_records(spec.parse_spec(data), self.records), ["$.source.filter: no record matches the filter"])

        data = spec.spec_to_dict(self.spec)
        data["source"]["filter"] = {"path": "$.id", "equals": "r003"}
        self.assertEqual(spec.validate_against_records(spec.parse_spec(data), self.records), [])

    def test_static_errors_come_first(self):
        broken = spec.parse_spec(spec.spec_to_dict(self.spec))
        broken.hit.attention.expected_value = "nope"
        errors = spec.validate_against_records(broken, self.records)
        self.assertEqual(len(errors), 1)
        self.assertTrue(errors[0].startswith("$.hit.attention.expected_value"))
        self.assertEqual(spec.validate_against_records(self.spec, []), ["no records to validate against"])
        self.assertEqual(spec.validate_against_records(self.spec, self.records[:1]),
                         ["$.hit.attention.mismatch: needs at least 2 records to take fields from another record"])

    def test_iterate_over_map_and_no_iterate(self):
        data = copy.deepcopy(MINIMAL)
        data["item"]["iterate"] = [{"var": "fact", "path": "$.facts"}]
        data["item"]["fields"] = {"fact": {"path": "{fact}"}, "keys": {"path": "$.answers", "role": "target"}}
        data["item"]["hint"] = {"label_path": "$.gold['{fact_key}'][{target_index}]", "map": None}
        parsed = spec.parse_spec(data)
        records = [{"facts": {"F1": "a", "F2": "b"}, "answers": ["x", "y"], "gold": {"F1": ["yes", "no"], "F2": ["no", "no"]}}]
        self.assertEqual(spec.validate_against_records(parsed, records), [])
        items = list(spec.iter_item_variables(parsed, records[0], spec.record_variables(0, "r1")))
        self.assertEqual([(v["fact_key"], v["fact"], v["fact_no"]) for v in items], [("F1", "a", 1), ("F2", "b", 2)])
        plain = spec.parse_spec(copy.deepcopy(MINIMAL))
        self.assertEqual(len(list(spec.iter_item_variables(plain, records[0], {}))), 1)
        self.assertEqual(spec.validate_against_records(plain, [{"question": "q", "facts": ["a"]}]), [])
        self.assertEqual(spec.validate_against_records(plain, [{"question": "q", "facts": [1, {"x": 1}]}]),
                         ["$.item.fields.facts.path: '$.facts[*]' contains a dict in record 'r1', expected strings"])


if __name__ == "__main__":
    unittest.main()
