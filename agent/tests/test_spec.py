"""spec 모듈: 기본값, 오류 수집, 저장/복원(v1 호환 포함), 문항 배치, 레코드 실측 검증, 경로 제안."""

import copy
import json
import tempfile
import unittest
from pathlib import Path

from agent import source, spec
from agent.spec import SpecError

EXAMPLE_DIR = Path(__file__).resolve().parent.parent / "examples" / "groundedness"
COVERAGE_DIR = EXAMPLE_DIR.parent / "coverage"
FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"

MINIMAL = {
    "task": {"id": "demo", "title": "Demo task", "description": "Judge things."},
    "item": {
        "fields": {
            "question": {"path": "$.question"},
            "facts": {"path": "$.facts[*]", "role": "target"},
        },
        "questions": [{"id": "ok", "text": "Is it?", "options": [{"value": "yes"}, {"value": "no", "label": "No"}]}],
    },
}

# spec_version 1 (옛 형식): 문항 하나를 item.question에, hint를 item.hint에 둔다
LEGACY_MINIMAL = {
    "task": {"id": "demo", "title": "Demo task", "description": "Judge things."},
    "item": {
        "fields": {
            "question": {"path": "$.question"},
            "facts": {"path": "$.facts[*]", "role": "target"},
        },
        "question": {"text": "Is it?", "options": [{"value": "yes"}, {"value": "no", "label": "No"}]},
    },
}


def question(**overrides):
    """v2 문항 dict. 기본은 target 문항 choice (yes/no)."""
    data = {"id": "q", "text": "Is it?", "type": "choice", "scope": "target",
            "options": [{"value": "yes"}, {"value": "no"}]}
    data.update(overrides)
    return data


def with_questions(*questions, **item):
    data = copy.deepcopy(MINIMAL)
    data["item"]["questions"] = list(questions)
    data["item"].update(item)
    return data


def errors_of(data) -> str:
    with unittest.TestCase().assertRaises(SpecError) as caught:
        spec.parse_spec(data)
    return "\n".join(caught.exception.messages)


class ParseTest(unittest.TestCase):
    def test_defaults(self):
        parsed = spec.parse_spec(copy.deepcopy(MINIMAL))
        self.assertEqual(parsed.spec_version, 2)
        self.assertEqual(parsed.task.keywords, [])
        self.assertIsNone(parsed.source.format)
        self.assertIsNone(parsed.source.record_id)
        self.assertIsNone(parsed.source.filter)
        self.assertEqual(parsed.item.iterate, [])
        self.assertEqual(parsed.item.fields["question"].label, "question")
        self.assertEqual(parsed.item.fields["question"].role, "context")
        self.assertEqual(parsed.item.fields["question"].style, "text")
        q = parsed.item.questions[0]
        self.assertEqual(q.options[0].label, "yes")
        self.assertEqual((q.id, q.type, q.scope, q.suffix, q.values), ("ok", "choice", "target", "_ok", ["yes", "no"]))
        self.assertEqual((q.none_label, q.scale, q.min_chars, q.required, q.required_when, q.hint), (None, None, 0, True, None, None))
        self.assertIsNone(q.answer_suffix)
        self.assertTrue(parsed.item.skip_if_no_targets)
        self.assertEqual(parsed.hit.items_per_hit, 10)
        self.assertEqual(parsed.hit.group_by, "record")
        self.assertIsNone(parsed.hit.attention)
        self.assertEqual(parsed.instructions.summary, "Judge things.")
        self.assertTrue(parsed.instructions.notices.attention)
        self.assertTrue(parsed.instructions.notices.research)
        self.assertEqual(parsed.output.reference_column, "llm_label")
        self.assertIsNone(parsed.output.reason_column)
        self.assertEqual(parsed.output.attention_column, "attention_expected")
        self.assertIsNone(parsed.planner_notes)
        self.assertEqual(parsed.target_field.name, "facts")
        self.assertEqual([f.name for f in parsed.context_fields], ["question"])
        self.assertEqual(parsed.option_values, ["yes", "no"])
        self.assertEqual(parsed.free_text_suffixes, [])
        self.assertFalse(parsed.legacy)

    def test_legacy_defaults(self):
        parsed = spec.parse_spec(copy.deepcopy(LEGACY_MINIMAL))  # spec_version이 없어도 item.question이면 v1로 읽는다
        self.assertEqual(parsed.spec_version, 1)
        self.assertTrue(parsed.legacy)
        q = parsed.item.questions[0]
        self.assertEqual((q.id, q.type, q.scope, q.suffix, q.answer_suffix), ("answer", "choice", "target", "", ""))
        self.assertEqual(parsed.output.attention_column, "attention_expected")
        data = copy.deepcopy(LEGACY_MINIMAL)
        data["spec_version"] = 1
        data["item"]["question"]["answer_suffix"] = "_x"
        data["item"]["hint"] = {"label_path": "$.gold[{target_index}]", "map": {"Y": "yes"}}
        data["hit"] = {"attention": {"strategy": "instruction", "expected_value": "no", "instruction": {"text": "Choose No."}}}
        parsed = spec.parse_spec(data)
        self.assertEqual(parsed.item.questions[0].suffix, "_x")
        self.assertEqual(parsed.item.questions[0].hint.map, {"Y": "yes"})
        self.assertEqual(parsed.hit.attention.expected, {"answer": "no"})

    def test_version(self):
        data = copy.deepcopy(MINIMAL)
        data["spec_version"] = 3
        self.assertIn("$.spec_version: must be 2 (or 1 for the legacy single-question format)", errors_of(data))
        data["spec_version"] = "2"
        self.assertIn("$.spec_version: must be an integer", errors_of(data))
        # v2 spec에 옛 키를 쓰면 모르는 키다
        data = copy.deepcopy(MINIMAL)
        data["spec_version"] = 2
        data["item"]["question"] = {"text": "x"}
        data["hit"] = {"attention": {"strategy": "instruction", "expected_value": "no", "expected": {"ok": "no"},
                                     "instruction": {"text": "Choose No."}}}
        joined = errors_of(data)
        self.assertIn("$.item.question: unknown key (allowed: iterate, fields, questions, skip_if_no_targets)", joined)
        self.assertIn("$.hit.attention.expected_value: unknown key", joined)
        # v1 spec에 새 키를 쓰면 모르는 키다
        data = copy.deepcopy(LEGACY_MINIMAL)
        data["spec_version"] = 1
        data["item"]["iterate"] = [{"var": "p", "path": "$.p", "group_size": 2}]
        data["output"] = {"attention_column": "x"}
        joined = errors_of(data)
        self.assertIn("$.item.iterate[0].group_size: unknown key", joined)
        self.assertIn("$.output.attention_column: unknown key", joined)

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
        data["hit"] = {"attention": {"strategy": "instruction", "expected": {"ok": "no"},
                                     "instruction": {"text": "Choose No."}}}
        attention = spec.parse_spec(data).hit.attention
        self.assertEqual((attention.per_hit, attention.position, attention.seed, attention.max_targets), (1, "random", 42, None))
        self.assertEqual(attention.expected, {"ok": "no"})

    def test_collects_all_errors_with_paths_legacy(self):
        data = {
            "spec_version": 1,
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
        self.assertIn("$.task.id: must match", str(caught.exception))

    def test_collects_all_errors_with_paths_v2(self):
        data = {
            "spec_version": 2,
            "task": {"id": "demo", "title": "Demo"},
            "item": {
                "iterate": [{"var": "pair", "path": "$.passages", "group_size": 1}],
                "fields": {"a": {"path": "$.a[*]", "role": "target"}, "b": {"path": "$.b[*]", "role": "target"},
                           "q": {"path": "$.q"}},
                "questions": [
                    question(id="Bad", text="", type="multi_select", scope="item", options=[{"value": "x"}]),
                    question(id="rate", type="likert", options=[{"value": "1"}], scale={"min": 1, "max": 20}, none_label="x",
                             hint={"label_path": "$.r", "contains": "{nope}"}),
                    question(id="info", type="text", scope="item", options=[], hint={"label_path": "$.x"}, min_chars=-1),
                    question(id="missing_info", scope="item", options=[{"value": "a"}, {"value": "b"}],
                             required_when={"question": "later", "value": "z"}, min_chars=5),
                    question(id="later", scope="item", required=False, required_when={"question": "info", "value": "q"}),
                    question(id="later", scope="item", hint={"label_path": "$.l", "map": {"Y": "maybe"}, "missing": "nope"}),
                    question(id="cond", scope="item", required_when={"question": "q2", "value": "yes"}),
                    question(id="q2", required_when={"question": "rate", "value": "99"}),
                    question(id="dep", scope="item", required_when={"question": "q2", "value": "yes"}),
                    "not an object",
                ],
            },
            "hit": {"attention": {"strategy": "mismatch", "expected": {"info": "x", "nope": "y", "rate": "9", "q2": 1},
                                  "mismatch": {"swap_fields": ["q"]}}},
            "output": {"attention_column": "llm_label"},
        }
        joined = errors_of(data)
        for expected in (
            "$.item.iterate[0].group_size: must be null or at least 2",
            "$.item.fields: at most one field may have role \"target\" (found 2: a, b)",
            "$.item.questions[0].id: must match ^[a-z][a-z0-9_]*$",
            "$.item.questions[0].text: must not be empty",
            "$.item.questions[0].options: a multi_select question needs exactly 2 options",
            "$.item.questions[0].scope: a multi_select question asks about the targets",
            "$.item.questions[1].options: must be empty for a likert question",
            "$.item.questions[1].scale: at most 11 points",
            "$.item.questions[1].none_label: only for multi_select questions",
            "$.item.questions[1].hint.contains: unknown variable {nope}",
            "$.item.questions[1].hint.contains: needs a map from \"true\"/\"false\"",
            "$.item.questions[2].hint: not allowed for a text question",
            "$.item.questions[2].min_chars: must be 0 or more",
            "$.item.questions[2].id: 'info' is a '_' suffix of the question id 'missing_info'",
            "$.item.questions[3].required_when.question: 'later' must come before this question",
            "$.item.questions[3].min_chars: only for text questions",
            "$.item.questions[4].required_when: only for required questions",
            "$.item.questions[4].required_when.question: 'info' is a text question",
            "$.item.questions[5].id: duplicate question id 'later'",
            "$.item.questions[5].hint.map.Y: 'maybe' is not an option value (yes, no)",
            "$.item.questions[5].hint.missing: 'nope' is not an option value (yes, no)",
            "$.item.questions[6].required_when.question: 'q2' must come before this question",
            "$.item.questions[7].required_when.value: '99' is not a scale value of 'rate'",
            "$.item.questions[8].required_when.question: an item-scoped question cannot depend on the target-scoped question 'q2'",
            "$.item.questions[9]: must be an object",
            "$.hit.attention.expected.info: a text question has no expected value",
            "$.hit.attention.expected.nope: not a question id",
            "$.hit.attention.expected.rate: '9' is not a scale value of this question",
            "$.hit.attention.expected.q2: must be a string (a value of that question)",
            "$.output.attention_column: must differ from reference_column and reason_column",
        ):
            self.assertIn(expected, joined, msg=f"missing error {expected!r} in:\n{joined}")

    def test_question_type_rules(self):
        likert = question(id="rate", type="likert", options=[], scale={"min": 1, "max": 5, "min_label": "Low", "max_label": None})
        parsed = spec.parse_spec(with_questions(likert))
        self.assertEqual(parsed.item.questions[0].values, ["1", "2", "3", "4", "5"])
        self.assertIn("$.item.questions[0].scale: required for a likert question",
                      errors_of(with_questions(question(id="rate", type="likert", options=[]))))
        self.assertIn("$.item.questions[0].scale.max: must be greater than scale.min",
                      errors_of(with_questions(question(id="rate", type="likert", options=[], scale={"min": 3, "max": 3}))))
        self.assertIn("$.item.questions[0].scale: only for likert questions",
                      errors_of(with_questions(question(scale={"min": 1, "max": 2}))))
        self.assertIn("$.item.questions[0].options: at least 2 options are required",
                      errors_of(with_questions(question(options=[{"value": "yes"}]))))
        self.assertIn("$.item.questions: at least one question is required", errors_of(with_questions()))
        multi = question(id="pick", type="multi_select", options=[{"value": "in"}, {"value": "out"}], none_label="None of them")
        parsed = spec.parse_spec(with_questions(multi))
        self.assertEqual((parsed.item.questions[0].none_text, parsed.item.questions[0].values), ("None of them", ["in", "out"]))
        multi["none_label"] = None
        self.assertEqual(spec.parse_spec(with_questions(multi)).item.questions[0].none_text, "None of the above")
        text = question(id="note", type="text", scope="item", options=[], required=False, min_chars=5)
        parsed = spec.parse_spec(with_questions(question(), text))
        self.assertEqual(parsed.free_text_suffixes, ["_note"])
        self.assertEqual(parsed.option_values, ["yes", "no"])

    def test_target_field_rules(self):
        data = with_questions(question(scope="item"))
        del data["item"]["fields"]["facts"]
        parsed = spec.parse_spec(data)
        self.assertIsNone(parsed.target_field)
        data = with_questions(question(scope="target"))
        del data["item"]["fields"]["facts"]
        self.assertIn("$.item.questions[0].scope: \"target\" needs a field with role \"target\"", errors_of(data))
        data = with_questions(question(scope="item"))
        del data["item"]["fields"]["facts"]
        data["hit"] = {"attention": {"strategy": "instruction", "expected": {"q": "no"}, "instruction": {"text": "Choose No."}}}
        self.assertIn("$.hit.attention.strategy: \"instruction\" needs a field with role \"target\"", errors_of(data))
        data["hit"] = {"attention": {"strategy": "mismatch", "expected": {}, "mismatch": {"swap_fields": ["question"]}}}
        self.assertIn("$.hit.attention.expected: at least one question id with its expected value is required", errors_of(data))

    def test_contains_needs_true_false(self):
        hint = {"label_path": "$.sel", "contains": "{target_key}", "map": {"yes": "yes"}}
        self.assertIn("$.item.questions[0].hint.map: with contains, the raw labels are \"true\" and \"false\"",
                      errors_of(with_questions(question(hint=hint))))
        hint["map"] = {"true": "yes", "false": "no"}
        spec.parse_spec(with_questions(question(hint=hint)))
        both = question(options=[{"value": "true"}, {"value": "false"}], hint={"label_path": "$.sel", "contains": "{target}"})
        spec.parse_spec(with_questions(both))
        item_hint = question(scope="item", hint={"label_path": "$.sel", "contains": "{target_key}", "map": {"true": "yes"}})
        self.assertIn("$.item.questions[0].hint.contains: unknown variable {target_key}", errors_of(with_questions(item_hint)))
        item_path = question(scope="item", hint={"label_path": "$.sel[{target_no}]"})
        self.assertIn("$.item.questions[0].hint.label_path: unknown variable {target_no}", errors_of(with_questions(item_path)))

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
        data["hit"] = {"attention": {"strategy": "mismatch", "expected": {"ok": "no"}}}
        with self.assertRaisesRegex(SpecError, r"\$\.hit\.attention\.mismatch: required"):
            spec.parse_spec(data)
        data["hit"] = {"attention": {"strategy": "instruction", "expected": {"ok": "no"}}}
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

    def test_coverage_example_roundtrip(self):
        path = COVERAGE_DIR / "task_spec.json"
        loaded = spec.load_spec(path)
        self.assertEqual(spec.spec_to_dict(loaded), json.loads(path.read_text(encoding="utf-8")))
        self.assertEqual([(q.id, q.type, q.scope) for q in loaded.item.questions],
                         [("relevant", "multi_select", "target"), ("coverage", "choice", "item"), ("missing", "text", "item")])
        self.assertEqual(loaded.item.questions[2].required_when, spec.ConditionSpec("coverage", "not_covered"))
        self.assertEqual(loaded.item.questions[0].hint.contains, "{target_key}")

    def test_legacy_roundtrip_keeps_v1_shape(self):
        data = copy.deepcopy(LEGACY_MINIMAL)
        data["item"]["hint"] = {"label_path": "$.gold[{target_index}]", "reason_path": None, "map": None, "missing": "no"}
        data["item"]["question"]["answer_suffix"] = "_check"
        data["hit"] = {"attention": {"strategy": "mismatch", "expected_value": "no",
                                     "mismatch": {"swap_fields": ["question"], "distance": 2}}}
        parsed = spec.parse_spec(data)
        as_dict = spec.spec_to_dict(parsed)
        self.assertEqual(as_dict["spec_version"], 1)
        self.assertEqual(set(as_dict["item"]), {"iterate", "fields", "question", "hint", "skip_if_no_targets"})
        self.assertEqual(as_dict["item"]["question"]["answer_suffix"], "_check")
        self.assertEqual(as_dict["item"]["hint"], data["item"]["hint"])
        self.assertEqual(as_dict["hit"]["attention"]["expected_value"], "no")
        self.assertNotIn("expected", as_dict["hit"]["attention"])
        self.assertEqual(as_dict["output"], {"reference_column": "llm_label", "reason_column": None})
        again = spec.parse_spec(json.loads(json.dumps(as_dict)))
        self.assertEqual(again, parsed)
        self.assertEqual(spec.spec_to_dict(again), as_dict)
        # 저장소의 v1 fixture도 v1 그대로 되돌아온다
        sample = spec.load_spec(FIXTURE_DIR / "sample_spec.json")
        self.assertTrue(sample.legacy)
        self.assertEqual(spec.parse_spec(spec.spec_to_dict(sample)), sample)
        self.assertEqual(spec.spec_to_dict(sample)["item"]["question"]["text"], "Is this statement supported by the passage above?")

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
        hint = self.spec.item.questions[0].hint
        from agent import paths
        self.assertEqual(spec.map_hint(hint, paths.evaluate(hint.label_path, record, tvars)), "grounded")
        self.assertEqual(spec.map_hint(hint, "Maybe"), None)
        self.assertEqual(spec.map_hint(hint, paths.MISSING), None)

    def test_broken_spec_reports(self):
        data = spec.spec_to_dict(self.spec)
        data["item"]["questions"][0]["hint"]["label_path"] = "$.labels.retriever_a.model_a.nothing['Passage {passage_no}']['Fact {target_no}'][0]"
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
        data["item"]["questions"][0]["hint"]["label_path"] = "$.labels.retriever_a.model_a.nothing['Passage {passage_no}']['Fact {target_no}'][0]"
        errors = spec.validate_against_records(spec.parse_spec(data), self.records)
        self.assertTrue(any(e.startswith("$.item.questions[0].hint.label_path:") and "never resolves" in e for e in errors), errors)

        data = spec.spec_to_dict(self.spec)
        data["item"]["questions"][0]["hint"]["map"] = {"Maybe": "grounded"}
        errors = spec.validate_against_records(spec.parse_spec(data), self.records)
        self.assertTrue(any(e.startswith("$.item.questions[0].hint.map: no observed label maps") and "'Yes'" in e for e in errors), errors)

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
        broken.hit.attention.expected["support"] = "nope"
        errors = spec.validate_against_records(broken, self.records)
        self.assertEqual(len(errors), 1)
        self.assertTrue(errors[0].startswith("$.hit.attention.expected.support"))
        self.assertEqual(spec.validate_against_records(self.spec, []), ["no records to validate against"])
        self.assertEqual(spec.validate_against_records(self.spec, self.records[:1]),
                         ["$.hit.attention.mismatch: needs at least 2 records to take fields from another record"])

    def test_iterate_over_map_and_no_iterate(self):
        data = copy.deepcopy(MINIMAL)
        data["item"]["iterate"] = [{"var": "fact", "path": "$.facts"}]
        data["item"]["fields"] = {"fact": {"path": "{fact}"}, "keys": {"path": "$.answers", "role": "target"}}
        data["item"]["questions"][0]["hint"] = {"label_path": "$.gold['{fact_key}'][{target_index}]", "map": None}
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



class V2RulesTest(unittest.TestCase):
    """group_size, contains hint, 문항 배치(question_blocks, answer_slots), 경로 제안, 드문드문한 라벨 맵."""

    def test_group_size_cuts_pairs(self):
        data = with_questions(question(scope="item"))
        data["item"]["iterate"] = [{"var": "pair", "path": "$.passages", "limit": 5, "group_size": 2}]
        data["item"]["fields"] = {"a": {"path": "{pair}[0]"}, "b": {"path": "{pair}[1]"}}
        parsed = spec.parse_spec(data)
        record = {"passages": ["p1", "p2", "p3", "p4", "p5", "p6"]}
        items = list(spec.iter_item_variables(parsed, record, spec.record_variables(0, "r1")))
        # limit 5 → p1..p5, 2개씩 → (p1, p2), (p3, p4); 모자란 (p5)는 버린다
        self.assertEqual([v["pair"] for v in items], [["p1", "p2"], ["p3", "p4"]])
        self.assertEqual([(v["pair_index"], v["pair_no"], v["pair_key"]) for v in items], [(0, 1, 0), (1, 2, 2)])
        self.assertEqual(spec.field_value(parsed.item.fields["b"], record, items[1]), "p4")
        self.assertEqual(spec.validate_against_records(parsed, [record, {"passages": ["x", "y"]}]), [])
        mapped = {"passages": {"A": "a", "B": "b", "C": "c"}}
        items = list(spec.iter_item_variables(parsed, mapped, {}))
        self.assertEqual([(v["pair"], v["pair_key"]) for v in items], [(["a", "b"], "A")])
        self.assertEqual(spec.parse_spec(spec.spec_to_dict(parsed)), parsed)

    def test_contains_label(self):
        hint = spec.HintSpec(label_path="$.sel['{x_key}']", contains="{target_key}", map={"true": "yes", "false": "no"}, missing="no")
        record = {"sel": {"A": ["Fact 1", "Fact 3"], "B": {"Fact 2": 1}, "C": "Fact 1", "D": None}}
        def label(key, target_key):
            return spec.hint_label(hint, record, {"x_key": key, "target_key": target_key})
        self.assertEqual(label("A", "Fact 1"), "true")
        self.assertEqual(label("A", "Fact 2"), "false")
        self.assertEqual(label("B", "Fact 2"), "true")   # 객체면 키와 비교한다
        self.assertIs(label("C", "Fact 1"), spec.MISSING)  # 목록·객체가 아니면 없는 것으로 본다
        self.assertIs(label("D", "Fact 1"), spec.MISSING)
        self.assertIs(label("Z", "Fact 1"), spec.MISSING)
        self.assertEqual(spec.map_hint(hint, label("A", "Fact 3")), "yes")
        self.assertEqual(spec.map_hint(hint, label("Z", "Fact 3")), "no")
        self.assertEqual(spec.fill_text("Fact {n} of {m}", {"n": 2, "m": "x"}), "Fact 2 of x")
        with self.assertRaises(spec.PathError):
            spec.fill_text("{nope}", {})

    def test_blocks_and_slots(self):
        data = with_questions(
            question(id="a"),
            question(id="b", type="likert", options=[], scale={"min": 1, "max": 3}),
            question(id="m", type="multi_select", options=[{"value": "in"}, {"value": "out"}]),
            question(id="i", scope="item"),
            question(id="c"),
            question(id="d"),
        )
        parsed = spec.parse_spec(data)
        self.assertEqual(spec.question_blocks(parsed.item.questions),
                         [("targets", [0, 1]), ("multi", [2]), ("item", [3]), ("targets", [4, 5])])
        slots = [(q.id, j) for q, j in spec.answer_slots(parsed, 2)]
        self.assertEqual(slots, [("a", 1), ("b", 1), ("a", 2), ("b", 2), ("m", 1), ("m", 2), ("i", None),
                                 ("c", 1), ("d", 1), ("c", 2), ("d", 2)])
        self.assertEqual([(q.id, j) for q, j in spec.answer_slots(parsed, 0)], [("i", None)])

    def test_suggest_path(self):
        known = ["$.labels.retriever_a.model_a.passage_fact_support", "$.labels.retriever_a.model_a.passage_fact_support.{key}.{key}[0]",
                 "$.question", "$.passages.retriever_a"]
        wrong = "$.labels.retriever_a.model_a.passage_support['Passage {passage_no}']['Fact {target_no}'][0]"
        self.assertEqual(spec.suggest_path(wrong, known), "$.labels.retriever_a.model_a.passage_fact_support.{key}.{key}[0]")
        self.assertEqual(spec.suggest_path("$.questions", known), "$.question")
        self.assertIsNone(spec.suggest_path("$.zzz_totally_else", known))
        self.assertIsNone(spec.suggest_path("{passage}.text", known))

    def test_validation_suggests_close_paths(self):
        parsed = spec.load_spec(EXAMPLE_DIR / "task_spec.json")
        _, records = source.load_records(EXAMPLE_DIR / "raw.json")
        data = spec.spec_to_dict(parsed)
        data["item"]["questions"][0]["hint"]["label_path"] = "$.labels.retriever_a.model_a.passage_support['Passage {passage_no}']['Fact {target_no}'][0]"
        data["item"]["fields"]["question"]["path"] = "$.questoin"
        errors = spec.validate_against_records(spec.parse_spec(data), records)
        joined = "\n".join(errors)
        self.assertIn("$.item.fields.question.path: '$.questoin' does not resolve in record 'r001' (did you mean '$.question'?)", joined)
        self.assertIn("never resolves for the targets of the first 5 record(s) (did you mean "
                      "'$.labels.retriever_a.model_a.passage_fact_support.{key}.{key}[0]'?)", joined)

    def test_sparse_label_map_with_missing(self):
        data = with_questions(question(id="sup", type="multi_select", options=[{"value": "in"}, {"value": "out"}],
                                       hint={"label_path": "$.labels['P{p_no}'].selected", "contains": "{target_key}",
                                             "map": {"true": "in", "false": "out"}, "missing": "out"}))
        data["item"]["iterate"] = [{"var": "p", "path": "$.passages"}]
        data["item"]["fields"] = {"passage": {"path": "{p}"}, "facts": {"path": "$.facts[*]", "role": "target"}}
        records = [{"passages": ["a", "b"], "facts": {"F1": "x", "F2": "y"}, "labels": {}},
                   {"passages": ["c"], "facts": {"F1": "z"}, "labels": {}}]
        parsed = spec.parse_spec(data)
        # 라벨 맵이 비어 있어도 변수 앞까지($.labels)가 풀리고 missing이 있으면 "없음"으로 본다
        self.assertEqual(spec.validate_against_records(parsed, records), [])
        data["item"]["questions"][0]["hint"]["missing"] = None
        errors = spec.validate_against_records(spec.parse_spec(data), records)
        self.assertTrue(any("never resolves" in e for e in errors), errors)
        data["item"]["questions"][0]["hint"]["missing"] = "out"
        data["item"]["questions"][0]["hint"]["label_path"] = "$.lables['P{p_no}'].selected"
        errors = spec.validate_against_records(spec.parse_spec(data), records)
        self.assertTrue(any("never resolves" in e for e in errors), errors)
        # contains인데 목록이 아닌 값으로 풀리면 알린다
        records[0]["labels"] = {"P1": {"selected": "F1"}}
        data["item"]["questions"][0]["hint"]["label_path"] = "$.labels['P{p_no}'].selected"
        errors = spec.validate_against_records(spec.parse_spec(data), records)
        self.assertTrue(any("resolves to str in record 'r1', expected a list or an object (hint.contains is set)" in e for e in errors), errors)

    def test_item_hint_is_checked_per_item(self):
        data = with_questions(question(id="best", scope="item", options=[{"value": "a"}, {"value": "b"}],
                                       hint={"label_path": "$.best", "map": {"A": "a", "B": "b"}}))
        del data["item"]["fields"]["facts"]
        parsed = spec.parse_spec(data)
        self.assertEqual(spec.validate_against_records(parsed, [{"question": "q", "best": "A"}]), [])
        errors = spec.validate_against_records(parsed, [{"question": "q", "best": "C"}])
        self.assertEqual(errors, ["$.item.questions[0].hint.map: no observed label maps to an option value (observed: 'C')"])
        errors = spec.validate_against_records(parsed, [{"question": "q"}])
        self.assertEqual(errors, ["$.item.questions[0].hint.label_path: '$.best' never resolves for the items of the first 1 record(s) "
                                  "(top-level keys: question)"])



def rag_record(i: int) -> dict:
    """외부 RAG 데이터와 같은 모양의 합성 레코드: retriever별 passage, model별 fact, 한 retriever·model의 라벨."""
    subs = {f"Core subquery{n}": f"Sub-question {n} of {i}?" for n in (1, 2)}
    return {
        "qid": f"q{i}",
        "query": f"Question {i}?",
        "retrieved_chunk": {"dense": [f"d{i}-{k}" for k in range(4)], "rt25": [f"s{i}-{k}" for k in range(4)]},
        "decomposed_query": subs,
        "atomic_facts": {"rt25": {model: {f"Atomic fact{n}": f"{model} fact {n}" for n in (1, 2)}
                                  for model in ("mdl3_27B", "mdl-5", "mdl3_4B")}},
        "relevance_check": {"rt25": {"mdl-5": {
            "query_fact_relevance": {key: {"selected_facts": ["Atomic fact1"]} for key in subs},
            "chunk_fact_relevance": {"Chunk 2": {"selected_facts": ["Atomic fact1"]},
                                     "Chunk 4": {"selected_facts": ["Atomic fact2"]}} if i % 2 else {},
            "query_chunk_coverage": {"Chunk 1": ["Core subquery1"], "Chunk 3": ["Core subquery1", "Core subquery2"]},
        }}},
    }


RAG_RECORDS = [rag_record(i) for i in range(1, 9)]


def rag_spec(**changes) -> dict:
    """passage 하나에 statement 여러 개 (multi_select + contains hint). 일관된 spec이라 오류가 없다."""
    data = {
        "spec_version": 2,
        "task": {"id": "rag", "title": "Which statements does the passage support?", "keywords": ["reading"]},
        "source": {"record_id": "$.qid"},
        "item": {
            "iterate": [{"var": "chunk", "path": "$.retrieved_chunk.rt25", "limit": 4}],
            "fields": {"query": {"path": "$.query"}, "passage": {"path": "{chunk}", "style": "passage"},
                       "facts": {"path": "$.atomic_facts.rt25['mdl-5'][*]", "role": "target"}},
            "questions": [{"id": "supported", "text": "Which statements are supported?", "type": "multi_select",
                           "options": [{"value": "supported"}, {"value": "not_supported"}],
                           "hint": {"label_path": "$.relevance_check.rt25['mdl-5'].chunk_fact_relevance['Chunk {chunk_no}'].selected_facts",
                                    "contains": "{target_key}", "map": {"true": "supported", "false": "not_supported"},
                                    "missing": "not_supported"}}],
        },
        "hit": {"items_per_hit": 4},
    }
    for path, value in changes.items():
        node = data
        keys = path.split("/")
        for key in keys[:-1]:
            node = node[int(key)] if key.isdigit() else node[key]
        last = keys[-1]
        if last.isdigit():
            node[int(last)] = value
        else:
            node[last] = value
    return data


def rag_errors(**changes) -> list[str]:
    return spec.validate_against_records(spec.parse_spec(rag_spec(**changes)), RAG_RECORDS)


class ContentChecksTest(unittest.TestCase):
    """경로는 풀리지만 뜻이 틀린 spec: 문법 안내, target 안내, 최상위 키, contains, 키 일치, 내부 이름, 빠진 라벨 항목."""

    def test_consistent_spec_passes(self):
        self.assertEqual(rag_errors(), [])

    def test_dotted_variable_or_number_key(self):
        joined = errors_of(rag_spec(**{"item/questions/0/hint/label_path": "$.relevance_check.rt25.mdl.query_fact_coverage.{chunk_key}"}))
        self.assertIn("$.item.questions[0].hint.label_path: invalid path '$.relevance_check.rt25.mdl.query_fact_coverage.{chunk_key}': "
                      "'.{chunk_key}' is not allowed after '.'; an object key that is a variable or starts with a digit is "
                      "written in quotes, e.g. ['{sub_key}'] or ['Core subquery {sub_no}'], and a list index as [0]", joined)
        joined = errors_of(rag_spec(**{"item/questions/0/hint/label_path": "$.relevance_check.rt25.x.1.selected_facts"}))
        self.assertIn("'.1' is not allowed after '.'", joined)

    def test_target_that_is_one_string(self):
        errors = rag_errors(**{"item/iterate": [{"var": "chunk", "path": "$.retrieved_chunk.rt25", "limit": 4},
                                                {"var": "fact", "path": "$.atomic_facts.rt25['mdl-5']"}],
                               "item/fields/facts/path": "{fact}", "item/questions/0/hint": None})
        self.assertEqual(errors, ["$.item.fields.facts.path: '{fact}' resolves to str in record 'q1', expected a list of strings; "
                                  "a target must be a list shown inside one tab — if each tab judges one thing, make it a "
                                  "context field and use scope \"item\""])

    def test_missing_top_level_key(self):
        errors = rag_errors(**{"item/fields/query/path": "$.question"})
        self.assertEqual(errors, ["$.item.fields.query.path: '$.question' does not resolve in record 'q1' (did you mean '$.query'?) "
                                  "(top-level keys: qid, query, retrieved_chunk, decomposed_query, atomic_facts, relevance_check)"])

    def test_contains_that_never_matches(self):
        # 라벨 목록은 'Core subquery1' 같은 키를 담는데 contains가 target 글을 비교한다
        coverage = {"item/fields/facts/path": "$.decomposed_query[*]",
                    "item/questions/0/hint/label_path": "$.relevance_check.rt25['mdl-5'].query_chunk_coverage['Chunk {chunk_no}']"}
        self.assertEqual(rag_errors(**coverage), [])
        errors = rag_errors(**coverage, **{"item/questions/0/hint/contains": "{target}"})
        self.assertEqual(errors, ["$.item.questions[0].hint.contains: '{target}' is never found in the label lists of question "
                                  "'supported' (32 non-empty list(s) in the first 8 record(s)); the lists hold values like "
                                  "'Core subquery1', 'Core subquery2'; \"contains\": \"{target_key}\" matches them"])
        # 목록 원소가 번호로 만들어지면 번호 변수로 쓰는 법을 알려 준다
        errors = rag_errors(**{"item/questions/0/hint/contains": "Fact {target_no}"})
        self.assertTrue(errors and errors[0].endswith("\"contains\": \"{target_key}\" matches them"), errors)
        records = [dict(record, atomic_facts={"rt25": {"mdl-5": [f"fact {n}" for n in (1, 2)]}}) for record in RAG_RECORDS]
        errors = spec.validate_against_records(spec.parse_spec(rag_spec(**{"item/fields/facts/path": "$.atomic_facts.rt25['mdl-5']",
                                                                            "item/questions/0/hint/contains": "Fact {target_no}"})), records)
        self.assertTrue(any(e.endswith("\"contains\": \"Atomic fact{target_no}\" matches them") for e in errors), errors)
        # 목록이 모두 비어 있으면 판단하지 않는다
        empty = [dict(record, relevance_check={"rt25": {"mdl-5": {"chunk_fact_relevance": {}}}}) for record in RAG_RECORDS]
        parsed = spec.parse_spec(rag_spec(**{"item/questions/0/hint/contains": "{target}"}))
        self.assertFalse(any(".contains:" in e for e in spec.validate_against_records(parsed, empty)))

    def test_labels_for_another_model(self):
        errors = rag_errors(**{"item/fields/facts/path": "$.atomic_facts.rt25.mdl3_27B[*]"})
        self.assertEqual(errors, ["$.item.questions[0].hint.label_path: reads labels for 'mdl-5' but the targets come from "
                                  "'mdl3_27B' (both are keys of $.atomic_facts.rt25); labels must address the same targets — "
                                  "use the same key in both paths"])

    def test_targets_from_another_retriever(self):
        errors = rag_errors(**{"item/iterate/0/path": "$.retrieved_chunk.dense", "item/questions/0/hint": None})
        self.assertEqual(errors, ["$.item.fields.facts.path: the targets come from 'rt25' but the tab shows $.retrieved_chunk.dense "
                                  "('rt25' and 'dense' are both keys of $.retrieved_chunk); show targets and context from the "
                                  "same source — use the same key in both paths"])

    def test_side_by_side_models_are_not_a_mismatch(self):
        # 두 model의 statement를 나란히 보여 주는 작업: 문맥이 두 키를 모두 쓰므로 알리지 않는다
        errors = rag_errors(**{"item/fields/other": {"path": "$.atomic_facts.rt25.mdl3_27B[*]", "style": "list"},
                               "item/questions/0/hint/label_path":
                                   "$.relevance_check.rt25['mdl-5'].chunk_fact_relevance['Chunk {chunk_no}'].selected_facts"})
        self.assertEqual(errors, [])

    def test_internal_names_in_worker_text(self):
        errors = rag_errors(**{"task/title": "Select facts supported by an RT25 chunk",
                               "task/keywords": ["reading", "rt25"],
                               "item/questions/0/options/0/label": "Supported by mdl3_4B",
                               "item/questions/0/text": "Which statements does Chunk 3 support?"})
        self.assertEqual(errors, [
            "$.task.title: mentions 'rt25', an internal name from the data; describe it in plain words (e.g. 'retrieved passage')",
            "$.task.keywords[1]: mentions 'rt25', an internal name from the data; describe it in plain words (e.g. 'retrieved passage')",
            "$.item.questions[0].options[0].label: mentions 'mdl3_4B', an internal name from the data; describe it in plain "
            "words (e.g. 'retrieved passage')",
        ])
        self.assertTrue(spec._is_internal_name("mdl-5") and spec._is_internal_name("key_19") and spec._is_internal_name("RT25"))
        self.assertFalse(any(spec._is_internal_name(key) for key in ("Chunk 3", "Atomic fact1", "Core subquery2", "Sub-question 1",
                                                                     "model_a", "2024", "rt25")))
        # 띄어쓰기 없는 '글자+숫자'는 형제 키로 가른다: 번호만 다른 형제가 있으면 번호 라벨이다
        self.assertTrue(spec._is_internal_name("rt25", {"rt25", "dense"}))
        self.assertFalse(spec._is_internal_name("fact1", {"fact1", "fact2"}))

    def test_sparse_label_map_needs_missing(self):
        errors = rag_errors(**{"item/questions/0/hint/missing": None})
        self.assertEqual(errors, ["$.item.questions[0].hint.missing: 48 answer(s) have no label entry (e.g. 'Chunk 1' in record "
                                  "'q1') although the label map $.relevance_check.rt25['mdl-5'].chunk_fact_relevance exists; if "
                                  "an absent entry means 'no', set missing to 'not_supported'"])
        # 뒤쪽 번호만 빠진 것(아직 라벨이 없는 passage일 수 있다)은 세지 않는다
        tail = [dict(record, relevance_check={"rt25": {"mdl-5": {"chunk_fact_relevance": {
            "Chunk 1": {"selected_facts": ["Atomic fact1"]}, "Chunk 2": {"selected_facts": []}}}}}) for record in RAG_RECORDS]
        parsed = spec.parse_spec(rag_spec(**{"item/questions/0/hint/missing": None}))
        self.assertEqual(spec.validate_against_records(parsed, tail), [])


if __name__ == "__main__":
    unittest.main()
