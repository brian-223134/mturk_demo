"""validate 모듈: 예시 묶음 통과, 컬럼 누락·reference 오류·attention 컬럼 오류·큰 행·렌더 검사, 문항 여러 개."""

import csv
import io
import json
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from agent import preprocess, render, spec, validate

csv.field_size_limit(sys.maxsize)

EXAMPLE_DIR = Path(__file__).resolve().parent.parent / "examples" / "groundedness"
COVERAGE_DIR = EXAMPLE_DIR.parent / "coverage"


def build_bundle(out: Path, example: Path = EXAMPLE_DIR) -> None:
    parsed = spec.load_spec(example / "task_spec.json")
    shutil.copy(example / "task_spec.json", out / "task_spec.json")
    preprocess.run_preprocess(parsed, example / "raw.json", out)
    render.run_render(parsed, out)


def read_rows(path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        return list(reader.fieldnames or []), list(reader)


def write_rows(path: Path, columns: list[str], rows: list[dict[str, str]]) -> None:
    preprocess.write_csv(path, columns, rows)


class ValidateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.source = Path(cls.tmp.name) / "bundle"
        cls.source.mkdir()
        build_bundle(cls.source)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def bundle(self) -> Path:
        """예시 묶음의 복사본 (테스트마다 고쳐 쓴다)."""
        out = Path(tempfile.mkdtemp(dir=self.tmp.name))
        for name in ("task_spec.json", "hits.csv", "template.html"):
            shutil.copy(self.source / name, out / name)
        return out

    def test_example_bundle_is_ok(self):
        out = self.bundle()
        result = validate.validate_bundle(out)
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["warnings"], [])
        self.assertTrue(result["ok"])
        stats = result["stats"]
        self.assertEqual(stats["placeholders"], ["hit_id", "question", "passage", "facts"])
        self.assertEqual(stats["unused_columns"], ["record_ids", "item_ids", "attention", "llm_label", "llm_reason", "attention_expected"])
        self.assertEqual((stats["rows"], stats["rows_ok"], stats["items"], stats["attention_items"], stats["targets"]), (6, 6, 30, 6, 58))
        self.assertEqual((stats["answers"], stats["attention_answers"]), (58, 10))
        self.assertEqual(stats["hints_missing"], 0)
        self.assertEqual(stats["free_text_suffixes"], [])
        self.assertEqual(sum(stats["reference_values"].values()), 48)
        self.assertEqual(stats["rows_over_64kb"], 0)
        saved = json.loads((out / "validation.json").read_text(encoding="utf-8"))
        self.assertEqual(saved, result)

    def test_run_validate_prints_report(self):
        out = self.bundle()
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            result = validate.run_validate(out)
        self.assertTrue(result["ok"])
        text = buffer.getvalue()
        self.assertIn(": ok", text)
        self.assertIn("rows 6, items 30", text)
        self.assertIn("answers 58", text)
        self.assertIn("placeholders: hit_id, question, passage, facts", text)

    def test_missing_files(self):
        out = self.bundle()
        (out / "template.html").unlink()
        result = validate.validate_bundle(out)
        self.assertFalse(result["ok"])
        self.assertTrue(any("template.html: file not found" in e for e in result["errors"]))

    def test_invalid_spec(self):
        out = self.bundle()
        (out / "task_spec.json").write_text('{"task": {"id": "x"}}', encoding="utf-8")
        result = validate.validate_bundle(out)
        self.assertFalse(result["ok"])
        self.assertTrue(any(e.startswith("task_spec.json: $.item") for e in result["errors"]))

    def test_removed_column_is_an_error(self):
        out = self.bundle()
        columns, rows = read_rows(out / "hits.csv")
        columns.remove("passage")
        write_rows(out / "hits.csv", columns, rows)
        result = validate.validate_bundle(out)
        self.assertFalse(result["ok"])
        self.assertTrue(any("placeholder column(s) missing: passage" in e for e in result["errors"]))
        self.assertTrue(any("placeholder(s) left unsubstituted: passage" in e for e in result["errors"]))

    def test_corrupted_reference_is_an_error(self):
        out = self.bundle()
        columns, rows = read_rows(out / "hits.csv")
        reference = json.loads(rows[0]["llm_label"])
        attention_name = next(iter(json.loads(rows[0]["attention_expected"])))
        general_name = next(iter(reference))
        reference[attention_name] = "not_grounded"
        reference[general_name] = "maybe"
        reference["general_9_9_support"] = "grounded"
        rows[0]["llm_label"] = preprocess.json_cell(reference)
        write_rows(out / "hits.csv", columns, rows)
        result = validate.validate_bundle(out)
        self.assertFalse(result["ok"])
        errors = "\n".join(result["errors"])
        self.assertIn(f"llm_label has attention answer(s) {attention_name}; expected values belong in the attention column", errors)
        self.assertIn(f"llm_label['{general_name}'] = 'maybe' is not an option value of question 'support'", errors)
        self.assertIn("key(s) that are not answer names: general_9_9_support", errors)

    def test_corrupted_attention_column_is_an_error(self):
        out = self.bundle()
        columns, rows = read_rows(out / "hits.csv")
        expected = json.loads(rows[0]["attention_expected"])
        first, *rest = list(expected)
        expected[first] = "grounded"
        reference_name = next(iter(json.loads(rows[0]["llm_label"])))
        expected[reference_name] = "not_grounded"
        rows[0]["attention_expected"] = preprocess.json_cell(expected)
        second = json.loads(rows[1]["attention_expected"])
        dropped = next(iter(second))
        del second[dropped]
        rows[1]["attention_expected"] = preprocess.json_cell(second)
        rows[2]["attention_expected"] = "[]"
        write_rows(out / "hits.csv", columns, rows)
        errors = "\n".join(validate.validate_bundle(out)["errors"])
        self.assertIn(f"line 2: attention_expected['{first}'] = 'grounded', expected 'not_grounded'", errors)
        self.assertIn(f"line 2: attention_expected has key(s) that are not attention answers with an expected value: {reference_name}", errors)
        self.assertIn(f"line 3: attention_expected lacks the attention answer {dropped}", errors)
        self.assertIn("line 4: attention_expected must be a JSON object", errors)

    def test_template_must_hide_attention(self):
        out = self.bundle()
        path = out / "template.html"
        html = path.read_text(encoding="utf-8")
        path.write_text(html.replace("return 'general_' + i", "return (ATT ? 'attention_' : 'general_') + i")
                        .replace("window.TASK_ANSWER_SCHEMA", "window.SCHEMA"), encoding="utf-8")
        errors = "\n".join(validate.validate_bundle(out)["errors"])
        self.assertIn("template.html: contains 'attention_'", errors)
        self.assertIn("template.html: 'TASK_ANSWER_SCHEMA' not found", errors)
        # 옛 템플릿처럼 ${attention}을 쓰면 placeholder가 맞지 않는다
        path.write_text(html.replace("var FIELDS = {};", "var FIELDS = {};\nvar ATT = ${attention};"), encoding="utf-8")
        errors = "\n".join(validate.validate_bundle(out)["errors"])
        self.assertIn("differ from the expected ['facts', 'hit_id', 'passage', 'question'] (hit_id and the spec fields)", errors)

    def test_item_count_mismatch_and_bad_json(self):
        out = self.bundle()
        columns, rows = read_rows(out / "hits.csv")
        rows[1]["attention"] = "[0,0,0,0]"
        rows[2]["question"] = "not json"
        rows[3]["attention"] = "[0,0,0,0,0]"
        write_rows(out / "hits.csv", columns, rows)
        result = validate.validate_bundle(out)
        errors = "\n".join(result["errors"])
        self.assertIn("line 3: item counts differ", errors)
        self.assertIn("line 4: column 'question' is not JSON", errors)
        self.assertIn("line 5: 0 attention item(s), spec says 1", errors)

    def test_big_row_is_a_warning(self):
        out = self.bundle()
        columns, rows = read_rows(out / "hits.csv")
        passages = json.loads(rows[0]["passage"])
        passages[1] = "x" * (70 * 1024)
        rows[0]["passage"] = preprocess.json_cell(passages)
        write_rows(out / "hits.csv", columns, rows)
        result = validate.validate_bundle(out)
        self.assertTrue(result["ok"])
        self.assertEqual(len(result["warnings"]), 1)
        self.assertIn("1 row(s) exceed 64 KB", result["warnings"][0])
        self.assertIn("hit-0001", result["warnings"][0])
        self.assertEqual(result["stats"]["rows_over_64kb"], 1)

    def test_unescaped_script_tag_in_data(self):
        out = self.bundle()
        columns, rows = read_rows(out / "hits.csv")
        passages = json.loads(rows[0]["passage"])
        passages[1] = "text </script><script>alert(1)</script>"
        rows[0]["passage"] = json.dumps(passages, ensure_ascii=False)  # json_cell을 거치지 않아 <가 남는다
        write_rows(out / "hits.csv", columns, rows)
        result = validate.validate_bundle(out)
        self.assertFalse(result["ok"])
        self.assertTrue(any("introduces '</script'" in e for e in result["errors"]))

    def test_extra_placeholder_in_template(self):
        out = self.bundle()
        path = out / "template.html"
        path.write_text(path.read_text(encoding="utf-8").replace("var FIELDS = {};", "var FIELDS = {};\nvar EXTRA = ${extra};"), encoding="utf-8")
        result = validate.validate_bundle(out)
        self.assertFalse(result["ok"])
        self.assertTrue(any("differ from the expected" in e for e in result["errors"]))
        self.assertTrue(any("placeholder column(s) missing: extra" in e for e in result["errors"]))

    def test_multi_question_bundle(self):
        out = Path(tempfile.mkdtemp(dir=self.tmp.name))
        build_bundle(out, COVERAGE_DIR)
        result = validate.validate_bundle(out)
        self.assertEqual((result["errors"], result["warnings"]), ([], []))
        stats = result["stats"]
        self.assertEqual(stats["placeholders"], ["hit_id", "question", "subquestion", "statements"])
        self.assertEqual(stats["free_text_suffixes"], ["_missing"])
        summary = json.loads((out / "summary.json").read_text(encoding="utf-8"))
        for key in ("targets", "answers", "attention_answers", "hints_missing", "reference_values", "row_bytes"):
            self.assertEqual(stats[key], summary[key], key)
        # 자유 서술 답을 reference에 넣으면 오류다
        columns, rows = read_rows(out / "hits.csv")
        reference = json.loads(rows[0]["llm_label"])
        flags = json.loads(rows[0]["attention"])
        normal = flags.index(0)
        reference[f"general_{normal}_missing"] = "covered"
        reference[f"general_{normal}_coverage"] = "relevant"
        rows[0]["llm_label"] = preprocess.json_cell(reference)
        write_rows(out / "hits.csv", columns, rows)
        errors = "\n".join(validate.validate_bundle(out)["errors"])
        self.assertIn(f"llm_label['general_{normal}_missing'] is a free-text answer", errors)
        self.assertIn(f"llm_label['general_{normal}_coverage'] = 'relevant' is not an option value of question 'coverage'", errors)

    def test_helpers(self):
        html = "a ${x} b ${y} ${x} ${1bad} ${z_1}"
        self.assertEqual(validate.extract_placeholders(html), ["x", "y", "z_1"])
        self.assertEqual(validate.substitute_row(html, {"x": "[1]", "z_1": "$&"}), "a [1] b ${y} [1] ${1bad} $&")


if __name__ == "__main__":
    unittest.main()
